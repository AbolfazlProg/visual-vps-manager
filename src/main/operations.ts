/**
 * Command Translation Layer — UI Action → Operation model → validation →
 * SFTP or SSH (escaped) → result with undo descriptor.
 *
 * The renderer can ONLY express operations defined in shared/protocol.ts.
 * All path/name validation happens here. Shell commands are built exclusively
 * from shared/shell.ts builders (strict single-quote escaping).
 */

import type {
  FileEntry,
  FileOperation,
  ListDirResult,
  OperationResult,
  SearchResult,
  TrashItem,
  ActivityEntry,
  UndoDescriptor
} from "../shared/protocol";
import {
  assertSafeRemotePath,
  basenameOf,
  dirnameOf,
  isWithinPath,
  joinRemotePath,
  validateEntryName
} from "../shared/paths";
import { cmdCpRecursive, cmdDuBytes, cmdMv, cmdRmRecursive, cmdChmod, shq } from "../shared/shell";
import { classifyFsError, vpsmError, type SerializedVpsmError } from "../shared/errors";
import type { SshSession } from "./ssh";
import { entryKindFromMode, permsFromMode } from "./ssh";
import type { Stats } from "ssh2";

function randToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function fileEntryFromStat(
  name: string,
  parentDir: string,
  attrs: Stats,
  ownerName: string,
  groupName: string,
  homeOverride?: string
): FileEntry {
  const path = joinRemotePath(parentDir, name);
  const kind = entryKindFromMode(Number(attrs.mode));
  const e: FileEntry = {
    name,
    path,
    kind: kind === "other" ? "file" : kind,
    size: Number(attrs.size) || 0,
    mode: Number(attrs.mode) & 0xffff,
    perms: permsFromMode(Number(attrs.mode)),
    uid: Number(attrs.uid) || 0,
    gid: Number(attrs.gid) || 0,
    owner: ownerName,
    group: groupName,
    mtimeMs: (Number(attrs.mtime) || 0) * 1000
  };
  void homeOverride;
  return e;
}

export interface OperationDeps {
  getSession: (profileId: string) => SshSession;
  logActivity: (profileId: string, entry: ActivityEntry) => Promise<void>;
}

export class OperationError extends Error {
  readonly code: string;
  constructor(public readonly sErr: SerializedVpsmError) {
    super(sErr.message);
    this.name = "OperationError";
    this.code = sErr.code;
  }
}

function throwOp(err: unknown, context: string): never {
  throw new OperationError(classifyFsError(err, context));
}

export class OperationService {
  constructor(private deps: OperationDeps) {}

  private session(profileId: string): SshSession {
    return this.deps.getSession(profileId);
  }

  private async log(profileId: string, entry: ActivityEntry): Promise<void> {
    await this.deps.logActivity(profileId, entry);
  }

  /* ---------------- reading ---------------- */

  async homeDir(profileId: string): Promise<string> {
    const s = this.session(profileId);
    return await s.realpath(".");
  }

  async listDir(profileId: string, dirRaw: string): Promise<ListDirResult> {
    const dir = assertSafeRemotePath(dirRaw);
    const s = this.session(profileId);
    await s.ensureUserMap();
    let list: Array<{ filename: string; attrs: Stats }> = [];
    try {
      const sftp = await s.sftp();
      list = await new Promise((resolve, reject) =>
        sftp.readdir(dir, (err, files) => (err ? reject(err) : resolve(files as never)))
      );
    } catch (err) {
      throwOp(err, `list ${dir}`);
    }
    const entries: FileEntry[] = [];
    // resolve ALL symlinks in one round-trip (large dirs were slow otherwise)
    const linkPaths = list
      .filter((f) => entryKindFromMode(Number(f.attrs.mode)) === "symlink")
      .map((f) => joinRemotePath(dir, f.filename));
    const linkInfo = await s.batchReadlink(linkPaths).catch(() => new Map<string, { target: string; resolvedKind: "file" | "directory" | "broken" }>());
    for (const f of list) {
      let entry = fileEntryFromStat(f.filename, dir, f.attrs, s.userNameFor(Number(f.attrs.uid) || 0), s.groupNameFor(Number(f.attrs.gid) || 0));
      if (entry.kind === "symlink") {
        const info = linkInfo.get(entry.path);
        if (info) {
          entry.target = info.target;
          entry.linkTargetKind = info.resolvedKind;
        } else {
          // fallback for servers without readlink/stat (rare)
          try {
            entry.target = await s.readlink(entry.path);
            try {
              const targetStat = await s.stat(entry.path);
              const tk = entryKindFromMode(Number(targetStat.mode));
              entry.linkTargetKind = tk === "other" ? "file" : tk;
            } catch {
              entry.linkTargetKind = "broken";
            }
          } catch {
            entry.target = "";
            entry.linkTargetKind = "broken";
          }
        }
      }
      entries.push(entry);
    }
    return { path: dir, entries, truncated: false };
  }

  async stat(profileId: string, pathRaw: string): Promise<FileEntry> {
    const path = assertSafeRemotePath(pathRaw);
    const s = this.session(profileId);
    await s.ensureUserMap();
    const st = await s.lstat(path);
    const e = fileEntryFromStat(basenameOf(path), dirnameOf(path), st, s.userNameFor(Number(st.uid) || 0), s.groupNameFor(Number(st.gid) || 0));
    if (e.kind === "symlink") {
      try {
        e.target = await s.readlink(path);
        try {
          await s.stat(path);
          e.linkTargetKind = entryKindFromMode(Number((await s.stat(path)).mode)) === "directory" ? "directory" : "file";
        } catch {
          e.linkTargetKind = "broken";
        }
      } catch {
        e.linkTargetKind = "broken";
      }
    }
    return e;
  }

  /** Recursive size/file-count probe for delete confirmations. */
  async sizeOf(profileId: string, paths: string[]): Promise<{ bytes: number; files: number }> {
    const safe = paths.map(assertSafeRemotePath);
    const s = this.session(profileId);
    const du = await s.exec(cmdDuBytes(safe), { timeoutMs: 60000 }).catch((e) => throwOp(e, "measure size"));
    let bytes = 0;
    for (const line of du.stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\t/);
      if (m) bytes += parseInt(m[1], 10);
    }
    let files = 0;
    if (safe.length > 0) {
      const findArgv = safe.map((p) => shq(p)).join(" ");
      const count = await s.exec(`find ${findArgv} -type f 2>/dev/null | wc -l`, { timeoutMs: 60000 });
      files = parseInt(count.stdout.trim(), 10) || 0;
    }
    return { bytes, files };
  }

  async search(
    profileId: string,
    baseDirRaw: string,
    query: string,
    opts: { maxDepth: number; maxResults: number }
  ): Promise<SearchResult[]> {
    const baseDir = assertSafeRemotePath(baseDirRaw);
    if (query.length === 0) return [];
    const s = this.session(profileId);
    const depth = Math.max(1, Math.min(8, opts.maxDepth));
    const max = Math.max(10, Math.min(2000, opts.maxResults));
    const pattern = shq(`*${query.replace(/[\r\n\0*?[\]]/g, "")}*`);
    const cmd = `find ${shq(baseDir)} -maxdepth ${depth} -iname ${pattern} -printf '%y\\t%s\\t%p\\n' 2>/dev/null | head -n ${max}`;
    const r = await s.exec(cmd, { timeoutMs: 30000 }).catch((e) => throwOp(e, "search"));
    const out: SearchResult[] = [];
    for (const line of r.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [type, size, p] = parts;
      const name = basenameOf(p);
      if (!name || name === "/" || p === baseDir) continue;
      out.push({ name, path: p, kind: type === "d" ? "directory" : "file", size: parseInt(size, 10) || 0 });
    }
    return out;
  }

  /* ---------------- trash helpers ---------------- */

  private async ensureTrashDir(profileId: string): Promise<string> {
    const s = this.session(profileId);
    const home = await this.homeDir(profileId);
    const trash = `${home}/.vpsmgr-trash`;
    const r = await s.exec(`mkdir -p ${shq(trash)}`, { timeoutMs: 10000 }).catch((e) => throwOp(e, "create trash"));
    if (r.code !== 0) throwOp(new Error(r.stderr || "mkdir failed"), "create trash");
    return trash;
  }

  async listTrash(profileId: string): Promise<TrashItem[]> {
    const s = this.session(profileId);
    const home = await this.homeDir(profileId).catch(() => null);
    if (!home) return [];
    const trash = `${home}/.vpsmgr-trash`;
    let list: Array<{ filename: string; attrs: Stats }> = [];
    try {
      const sftp = await s.sftp();
      list = await new Promise((resolve, reject) =>
        sftp.readdir(trash, (err, files) => (err ? reject(err) : resolve(files as never)))
      );
    } catch {
      return [];
    }
    const items: TrashItem[] = [];
    for (const f of list) {
      if (!f.filename.endsWith(".meta.json")) continue;
      const id = f.filename.slice(0, -".meta.json".length);
      try {
        const meta = await s.readFileToString(`${trash}/${f.filename}`, 64 * 1024);
        const parsed = JSON.parse(meta.content) as { origPath: string; deletedAt: number; size: number };
        items.push({
          id,
          originalPath: parsed.origPath,
          trashPath: `${trash}/${id}`,
          deletedAt: parsed.deletedAt,
          sizeBytes: parsed.size || 0,
          profileId
        });
      } catch {
        items.push({ id, originalPath: "", trashPath: `${trash}/${id}`, deletedAt: Number(f.attrs.mtime) * 1000, sizeBytes: Number(f.attrs.size) || 0, profileId });
      }
    }
    return items;
  }

  async emptyTrash(profileId: string): Promise<void> {
    const s = this.session(profileId);
    const home = await this.homeDir(profileId);
    const trash = `${home}/.vpsmgr-trash`;
    const r = await s.exec(`rm -rf ${shq(trash)} && mkdir -p ${shq(trash)}`, { timeoutMs: 120000 }).catch((e) => throwOp(e, "empty trash"));
    if (r.code !== 0) throwOp(new Error(r.stderr), "empty trash");
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: "Emptied the trash", detail: trash });
  }

  /* ---------------- operations ---------------- */

  async runOperation(profileId: string, op: FileOperation): Promise<OperationResult> {
    switch (op.kind) {
      case "mkdir":
        return await this.opMkdir(profileId, op.parent, op.name);
      case "createFile":
        return await this.opCreateFile(profileId, op.parent, op.name, op.content ?? "");
      case "rename":
        return await this.opRename(profileId, op.path, op.newName);
      case "move":
        return await this.opMoveCopy(profileId, op, true);
      case "copy":
        return await this.opMoveCopy(profileId, op, false);
      case "delete":
        return await this.opDelete(profileId, op.paths, op.useTrash);
      case "restore":
        return await this.opRestore(profileId, op.trashIds);
      case "duplicate":
        return await this.opDuplicate(profileId, op.paths);
      case "chmod":
        return await this.opChmod(profileId, op);
      case "chown":
        return await this.opChown(profileId, op);
      case "readFile": {
        const s = this.session(profileId);
        const path = assertSafeRemotePath(op.path);
        const res = await s.readFileToString(path, op.maxSize).catch((e) => throwOp(e, `read ${path}`));
        return { ok: true, op, message: "Read", affected: [path], warnings: res.truncated ? ["File is larger than the editor limit — content is truncated."] : [] };
      }
      case "writeFile":
        return await this.opWriteFile(profileId, op.path, op.content, op.expectedMtime, op.encoding);
      case "stat": {
        await this.stat(profileId, op.path);
        return { ok: true, op, message: "Read", affected: [op.path] };
      }
      default:
        throw new OperationError(vpsmError("EINVAL_INPUT", "Unsupported operation"));
    }
  }

  private async opMkdir(profileId: string, parentRaw: string, name: string): Promise<OperationResult> {
    validateEntryName(name);
    const parent = assertSafeRemotePath(parentRaw);
    const path = joinRemotePath(parent, name);
    const s = this.session(profileId);
    try {
      await s.mkdir(path);
    } catch (err) {
      throwOp(err, `create folder ${path}`);
    }
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Created folder ${name}`, detail: path });
    return {
      ok: true,
      op: { kind: "mkdir", parent, name },
      message: `Folder "${name}" created`,
      affected: [path],
      undo: { label: "Create folder", ops: [{ kind: "delete", paths: [path], useTrash: false }] }
    };
  }

  private async opCreateFile(profileId: string, parentRaw: string, name: string, content: string): Promise<OperationResult> {
    validateEntryName(name);
    const parent = assertSafeRemotePath(parentRaw);
    const path = joinRemotePath(parent, name);
    const s = this.session(profileId);
    const sftp = await s.sftp();
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(path, { flags: "wx" });
      ws.on("error", (e: Error) => reject(e));
      ws.on("close", () => resolve());
      ws.end(Buffer.from(content, "utf8"));
    }).catch(async (err) => {
      // "wx" failures are generic on the wire; distinguish EEXIST explicitly
      const exists = await s.lstat(path).then(() => true).catch(() => false);
      if (exists) {
        throw new OperationError(vpsmError("EEXIST", `Already exists: ${path}`, { detail: "An item with this name already exists." }));
      }
      throwOp(err, `create file ${path}`);
    });
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Created file ${name}`, detail: path });
    return {
      ok: true,
      op: { kind: "createFile", parent, name, content },
      message: `File "${name}" created`,
      affected: [path],
      undo: { label: "Create file", ops: [{ kind: "delete", paths: [path], useTrash: false }] }
    };
  }

  private async opRename(profileId: string, pathRaw: string, newName: string): Promise<OperationResult> {
    validateEntryName(newName);
    const path = assertSafeRemotePath(pathRaw);
    const parent = dirnameOf(path);
    const newPath = joinRemotePath(parent, newName);
    if (newPath === path) {
      return { ok: true, op: { kind: "rename", path, newName }, message: "No change", affected: [path] };
    }
    const s = this.session(profileId);
    // clear EEXIST: SFTP rename over an existing target fails opaquely
    const targetExists = await s.lstat(newPath).then(() => true).catch(() => false);
    if (targetExists) {
      throw new OperationError(
        vpsmError("EEXIST", `An item named "${newName}" already exists in ${parent}`, {
          detail: "Choose a different name."
        })
      );
    }
    try {
      await s.rename(path, newPath);
    } catch (err) {
      throwOp(err, `rename ${path} → ${newName}`);
    }
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Renamed ${basenameOf(path)} → ${newName}`, detail: `${path} → ${newPath}` });
    return {
      ok: true,
      op: { kind: "rename", path, newName },
      message: `Renamed to "${newName}"`,
      affected: [path, newPath],
      undo: { label: "Rename", ops: [{ kind: "rename", path: newPath, newName: basenameOf(path) }] }
    };
  }

  private async opMoveCopy(profileId: string, op: Extract<FileOperation, { kind: "move" } | { kind: "copy" }>, isMove: boolean): Promise<OperationResult> {
    if (op.sources.length === 0) throw new OperationError(vpsmError("EINVAL_INPUT", "No items selected"));
    const destDir = assertSafeRemotePath(op.destDir);
    const sources = op.sources.map(assertSafeRemotePath);
    const s = this.session(profileId);

    for (const src of sources) {
      if (isWithinPath(destDir, src)) {
        throw new OperationError(vpsmError("EINVAL_INPUT", `Cannot move/copy "${basenameOf(src)}" into itself`, { detail: `${src} → ${destDir}` }));
      }
    }

    const affected: string[] = [];
    const warnings: string[] = [];
    for (const src of sources) {
      const dest = joinRemotePath(destDir, basenameOf(src));
      // OpenSSH SFTP rename fails with an opaque status when the target exists —
      // surface a clear, actionable error instead.
      const destExists = await s.lstat(dest).then(() => true).catch(() => false);
      if (destExists) {
        throw new OperationError(
          vpsmError("EEXIST", `An item named "${basenameOf(src)}" already exists in ${destDir}`, {
            detail: "Rename the item or remove the existing one, then try again."
          })
        );
      }
      if (isMove) {
        try {
          await s.rename(src, dest);
        } catch (err) {
          const mapped = classifyFsError(err, `move ${src}`);
          if (mapped.code === "EXDEV") {
            // cross-filesystem → real mv (escaped)
            const r = await s.exec(cmdMv([src], destDir), { timeoutMs: 300000 }).catch((e) => throwOp(e, `move ${src}`));
            if (r.code !== 0) throwOp(new Error(r.stderr || "mv failed"), `move ${src}`);
          } else {
            throwOp(err, `move ${src} → ${dest}`);
          }
        }
        await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Moved ${basenameOf(src)}`, detail: `${src} → ${dest}` });
      } else {
        const r = await s.exec(cmdCpRecursive([src], destDir), { timeoutMs: 600000 }).catch((e) => throwOp(e, `copy ${src}`));
        if (r.code !== 0) {
          if (/No such file or directory/i.test(r.stderr)) throwOp({ code: "ENOENT" }, `copy ${src}`);
          throwOp(new Error(r.stderr || "cp failed"), `copy ${src}`);
        }
        await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Copied ${basenameOf(src)}`, detail: `${src} → ${dest}` });
      }
      affected.push(dest);
    }

    const verb = isMove ? "Moved" : "Copied";
    const label = sources.length === 1 ? `"${basenameOf(sources[0])}"` : `${sources.length} items`;
    const undo: UndoDescriptor = isMove
      ? {
          label: "Move",
          ops: sources.map((src): FileOperation => ({
            kind: "move",
            sources: [joinRemotePath(destDir, basenameOf(src))],
            destDir: dirnameOf(src)
          }))
        }
      : {
          label: "Copy",
          ops: sources.map((src): FileOperation => ({
            kind: "delete",
            paths: [joinRemotePath(destDir, basenameOf(src))],
            useTrash: false
          }))
        };
    return { ok: true, op, message: `${verb} ${label} → ${destDir}`, affected, warnings, undo };
  }

  private async opDelete(profileId: string, pathsRaw: string[], useTrash: boolean): Promise<OperationResult> {
    if (pathsRaw.length === 0) throw new OperationError(vpsmError("EINVAL_INPUT", "Nothing to delete"));
    const paths = pathsRaw.map(assertSafeRemotePath);
    for (const p of paths) {
      if (p === "/") {
        throw new OperationError(vpsmError("EINVAL_INPUT", "Refusing to delete the root directory"));
      }
    }
    const s = this.session(profileId);
    const affected: string[] = [];

    if (useTrash) {
      const trash = await this.ensureTrashDir(profileId);
      const trashIds: string[] = [];
      for (const p of paths) {
        const id = `${Date.now().toString(36)}-${randToken()}-${basenameOf(p)}`;
        const dest = `${trash}/${id}`;
        // record real size for the trash UI before the move
        let itemSize = 0;
        try {
          const st = await s.lstat(p);
          itemSize = Number(st.size) || 0;
          if (entryKindFromMode(Number(st.mode)) === "directory") itemSize = 0; // dirs: computed on demand
        } catch { itemSize = 0; }
        try {
          await s.rename(p, dest);
        } catch (err) {
          const mapped = classifyFsError(err, `trash ${p}`);
          if (mapped.code === "EXDEV") {
            const r = await s.exec(cmdMv([p], trash), { timeoutMs: 300000 }).catch((e) => throwOp(e, `trash ${p}`));
            if (r.code !== 0) throwOp(new Error(r.stderr || "mv failed"), `trash ${p}`);
          } else {
            throwOp(err, `move to trash ${p}`);
          }
        }
        const meta = JSON.stringify({ origPath: p, deletedAt: Date.now(), size: itemSize });
        await s.writeStringToFile(`${trash}/${id}.meta.json`, meta).catch(() => {});
        trashIds.push(id);
        affected.push(dest);
      }
      const label = paths.length === 1 ? `"${basenameOf(paths[0])}"` : `${paths.length} items`;
      await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Moved ${label} to trash`, detail: paths.join("\n") });
      return {
        ok: true,
        op: { kind: "delete", paths, useTrash },
        message: `Moved ${label} to trash`,
        affected,
        undo: { label: "Delete", ops: [{ kind: "restore", trashIds }] }
      };
    }

    // permanent delete — UI must have confirmed with size/count
    const r = await s.exec(cmdRmRecursive(paths), { timeoutMs: 600000 }).catch((e) => throwOp(e, "delete"));
    if (r.code !== 0) {
      if (/Permission denied/i.test(r.stderr)) throwOp({ code: "EACCES" }, "delete");
      if (/No such file or directory/i.test(r.stderr)) throwOp({ code: "ENOENT" }, "delete");
      throwOp(new Error(r.stderr || "rm failed"), "delete");
    }
    const label = paths.length === 1 ? `"${basenameOf(paths[0])}"` : `${paths.length} items`;
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Permanently deleted ${label}`, detail: paths.join("\n") });
    return { ok: true, op: { kind: "delete", paths, useTrash }, message: `Deleted ${label} permanently`, affected: paths };
  }

  private async opRestore(profileId: string, trashIds: string[]): Promise<OperationResult> {
    const s = this.session(profileId);
    const home = await this.homeDir(profileId);
    const trash = `${home}/.vpsmgr-trash`;
    const affected: string[] = [];
    for (const id of trashIds) {
      const metaRes = await s.readFileToString(`${trash}/${id}.meta.json`, 64 * 1024).catch(() => null);
      const orig = metaRes ? (JSON.parse(metaRes.content) as { origPath: string }).origPath : null;
      if (!orig) throw new OperationError(vpsmError("ENOENT", `Cannot restore item: metadata missing`));
      let dest = orig;
      try {
        await s.stat(dest);
        // conflict → auto-suffix
        const parent = dirnameOf(orig);
        const base = basenameOf(orig);
        for (let i = 1; i < 100; i++) {
          const candidate = joinRemotePath(parent, `${base} (restored ${i})`);
          try {
            await s.stat(candidate);
          } catch {
            dest = candidate;
            break;
          }
        }
      } catch {
        // target free
      }
      try {
        await s.rename(`${trash}/${id}`, dest);
        await s.unlink(`${trash}/${id}.meta.json`).catch(() => {});
      } catch (err) {
        throwOp(err, `restore ${id}`);
      }
      affected.push(dest);
      await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Restored ${basenameOf(dest)}`, detail: `${trash}/${id} → ${dest}` });
    }
    return {
      ok: true,
      op: { kind: "restore", trashIds },
      message: `Restored ${affected.length} item(s)`,
      affected,
      undo: { label: "Restore", ops: [{ kind: "delete", paths: affected, useTrash: true }] }
    };
  }

  private async opDuplicate(profileId: string, pathsRaw: string[]): Promise<OperationResult> {
    if (pathsRaw.length === 0) throw new OperationError(vpsmError("EINVAL_INPUT", "Nothing to duplicate"));
    const s = this.session(profileId);
    const affected: string[] = [];
    for (const pRaw of pathsRaw) {
      const p = assertSafeRemotePath(pRaw);
      const parent = dirnameOf(p);
      const base = basenameOf(p);
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let candidate = `${stem} (copy)${ext}`;
      for (let i = 1; i < 50; i++) {
        try {
          await s.stat(joinRemotePath(parent, candidate));
          candidate = `${stem} (copy ${i + 1})${ext}`;
        } catch {
          break;
        }
      }
      const r = await s.exec(cmdCpRecursive([p], joinRemotePath(parent, candidate)), { timeoutMs: 600000 }).catch((e) => throwOp(e, `duplicate ${p}`));
      if (r.code !== 0) throwOp(new Error(r.stderr || "cp failed"), `duplicate ${p}`);
      affected.push(joinRemotePath(parent, candidate));
    }
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Duplicated ${pathsRaw.length} item(s)`, detail: affected.join("\n") });
    return {
      ok: true,
      op: { kind: "duplicate", paths: pathsRaw },
      message: `Duplicated ${pathsRaw.length} item(s)`,
      affected,
      undo: { label: "Duplicate", ops: [{ kind: "delete", paths: affected, useTrash: true }] }
    };
  }

  private async opChmod(profileId: string, op: Extract<FileOperation, { kind: "chmod" }>): Promise<OperationResult> {
    const path = assertSafeRemotePath(op.path);
    const s = this.session(profileId);
    if (!op.recursive) {
      try {
        await s.setMode(path, parseInt(op.mode, 8));
      } catch (err) {
        const mapped = classifyFsError(err, `chmod ${path}`);
        if (mapped.code === "EPERM" && s.hasSudoPassword()) {
          const r = await s.execSudo(cmdChmod(op.mode, [path], false)).catch((e) => throwOp(e, `chmod ${path}`));
          if (r.code !== 0) throwOp(new Error(r.stderr || "chmod failed"), `chmod ${path}`);
        } else {
          throwOp(err, `chmod ${path}`);
        }
      }
    } else {
      const r = await s.exec(cmdChmod(op.mode, [path], true), { timeoutMs: 120000 }).catch((e) => throwOp(e, `chmod ${path}`));
      if (r.code !== 0) {
        if (/Permission denied/i.test(r.stderr) && s.hasSudoPassword()) {
          const rs = await s.execSudo(cmdChmod(op.mode, [path], true)).catch((e) => throwOp(e, `chmod ${path}`));
          if (rs.code !== 0) throwOp(new Error(rs.stderr || "chmod failed"), `chmod ${path}`);
        } else {
          throwOp(new Error(r.stderr || "chmod failed"), `chmod ${path}`);
        }
      }
    }
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Changed permissions of ${basenameOf(path)} to ${op.mode}${op.recursive ? " (recursive)" : ""}`, detail: path });
    return { ok: true, op, message: `Permissions set to ${op.mode}`, affected: [path] };
  }

  private async opChown(profileId: string, op: Extract<FileOperation, { kind: "chown" }>): Promise<OperationResult> {
    const path = assertSafeRemotePath(op.path);
    const s = this.session(profileId);
    const argv = ["chown", op.group ? `${op.owner}:${op.group}` : op.owner];
    if (op.recursive) argv.push("-R");
    argv.push("--", path);
    const { buildCommand } = await import("../shared/shell");
    const r = await s.execSudo(buildCommand(argv)).catch((e) => throwOp(e, `chown ${path}`));
    if (r.code !== 0) throwOp(new Error(r.stderr || "chown failed"), `chown ${path}`);
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Changed owner of ${basenameOf(path)} to ${op.owner}${op.group ? ":" + op.group : ""}${op.recursive ? " (recursive)" : ""}`, detail: path });
    return { ok: true, op, message: `Owner set to ${op.owner}${op.group ? ":" + op.group : ""}`, affected: [path] };
  }

  private async opWriteFile(profileId: string, pathRaw: string, content: string, expectedMtime?: number, encoding?: import("../shared/encoding").TextEncoding): Promise<OperationResult> {
    const path = assertSafeRemotePath(pathRaw);
    const s = this.session(profileId);
    // conflict detection
    if (expectedMtime !== undefined) {
      try {
        const st = await s.lstat(path);
        if (Math.abs(Number(st.mtime) * 1000 - expectedMtime) > 1500) {
          throw new OperationError(
            vpsmError("EEXIST", "The file changed on the server since you opened it", {
              detail: "Reload the file and re-apply your changes to avoid overwriting newer content."
            })
          );
        }
      } catch (e) {
        if (e instanceof OperationError) throw e;
        // file vanished → allow save
      }
    }
    // preserve permissions: read mode first
    let priorMode: number | null = null;
    try {
      const st = await s.lstat(path);
      priorMode = Number(st.mode) & 0o7777;
    } catch {
      priorMode = null;
    }
    const tmp = `${path}.vpsmgr-tmp-${randToken()}`;
    await s.writeStringToFile(tmp, content, encoding ?? "utf8").catch((e) => throwOp(e, `write ${tmp}`));
    try {
      await s.unlink(path).catch(() => {});
      await s.rename(tmp, path);
      if (priorMode !== null) await s.setMode(path, priorMode).catch(() => {});
    } catch (err) {
      await s.unlink(tmp).catch(() => {});
      throwOp(err, `save ${path}`);
    }
    await this.log(profileId, { at: Date.now(), kind: "fs", summary: `Saved ${basenameOf(path)} (${content.length} bytes)`, detail: path });
    return { ok: true, op: { kind: "writeFile", path, content }, message: `Saved ${basenameOf(path)}`, affected: [path] };
  }
}
