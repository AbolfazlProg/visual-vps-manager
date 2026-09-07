import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { call } from "../ipc";
import type { FileEntry, SortDir, SortKey, SearchResult, FileOperation } from "../../shared/protocol";
import { FileTypeIcon, fileSizeStr, dateStr, ArrowLeft, ArrowRight, ArrowUp, Home, RefreshCw, Search, FolderOpenIcon, Upload, Download, TrashIcon2, PlusIcon, EditIcon, Eye, Scissors, ClipboardPaste, ListTree, MoreIcon, CopyIcon, RotateCcw } from "../components/icons";
import { PromptDialog, ConfirmDialog, Modal } from "../components/Modal";
import { PermissionsDialog } from "../components/PermissionsDialog";
import { FileTree } from "../components/FileTree";
import { ContextMenu, type CtxItem } from "../components/ContextMenu";
import { EditorOverlay } from "../components/EditorOverlay";
import { VpsmApiError } from "../ipc";
import type { SerializedVpsmError } from "../../shared/errors";

interface Props { profileId: string }

interface ConfirmState {
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  action: () => Promise<void>;
}

export function FilesPage({ profileId }: Props) {
  const { navigate, toast, states } = useApp();
  void navigate;
  const connected = states[profileId]?.status === "connected";

  const [cwd, setCwd] = useState<string>("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<SerializedVpsmError | null>(null);
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: ["/"], index: 0 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [clipboard, setClipboard] = useState<{ op: "copy" | "cut"; paths: string[]; fromDir: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; label: string; initial?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null; onConfirm: (v: string) => void } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [permEntry, setPermEntry] = useState<FileEntry | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef<Map<string, { top: number; bottom: number }>>(new Map());

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight || 600);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight || 600));
    ro.observe(el);
    setViewportH(el.clientHeight || 600);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  /* ---------- directory loading / navigation ---------- */

  const loadDir = useCallback(async (dir: string, pushHistory = true) => {
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    try {
      const res = await call(window.vpsm.listDir(profileId, dir));
      setCwd(res.path);
      setEntries(res.entries);
      if (pushHistory) {
        setHistory((h) => {
          const stack = h.stack.slice(0, h.index + 1);
          if (stack[stack.length - 1] !== res.path) stack.push(res.path);
          return { stack, index: stack.length - 1 };
        });
      }
    } catch (err) {
      const e = err as VpsmApiError;
      setLoadError(e.sErr ?? null);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    if (connected) void loadDir("/", false);
  }, [connected, loadDir]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setCtxMenu(null); setSearchOpen(false); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !editorPath) {
        e.preventDefault();
        setSelected(new Set(visibleEntries().map((en) => en.path)));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !editorPath) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const navigateTo = async (dir: string) => {
    await loadDir(dir);
  };
  const goBack = () => setHistory((h) => {
    if (h.index > 0) {
      const index = h.index - 1;
      void loadDir(h.stack[index], false);
      return { ...h, index };
    }
    return h;
  });
  const goForward = () => setHistory((h) => {
    if (h.index < h.stack.length - 1) {
      const index = h.index + 1;
      void loadDir(h.stack[index], false);
      return { ...h, index };
    }
    return h;
  });
  const goUp = () => {
    const parent = cwd === "/" ? "/" : cwd.slice(0, cwd.lastIndexOf("/")) || "/";
    void navigateTo(parent);
  };
  const goHome = async () => {
    try {
      const home = await call(window.vpsm.homeDir(profileId));
      void navigateTo(home);
    } catch { void navigateTo("/"); }
  };

  /* ---------- derived visible list ---------- */

  const visibleEntries = () => {
    let list = entries;
    if (!showHidden) list = list.filter((e) => !e.name.startsWith("."));
    if (filter.trim()) list = list.filter((e) => e.name.toLowerCase().includes(filter.trim().toLowerCase()));
    const dirFirst = (a: FileEntry, b: FileEntry) => {
      const av = a.kind === "directory" ? 0 : 1;
      const bv = b.kind === "directory" ? 0 : 1;
      return av - bv;
    };
    const cmp: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      size: (a, b) => a.size - b.size,
      mtime: (a, b) => a.mtimeMs - b.mtimeMs,
      kind: (a, b) => a.kind.localeCompare(b.kind)
    };
    return [...list].sort((a, b) => {
      const d = dirFirst(a, b);
      if (d !== 0) return d;
      const r = cmp[sortKey](a, b);
      return sortDir === "asc" ? r : -r;
    });
  };

  const visible = visibleEntries();

  /* virtualization: fixed 40px rows — only visible rows render (smooth scroll
   * even in directories with thousands of entries) */
  const ROW_H = 40;
  const OVERSCAN = 6;
  const [padTop, padBottom, sliceStart, sliceEnd] = useMemo(() => {
    const total = visible.length;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
    return [start * ROW_H, Math.max(0, (total - end) * ROW_H), start, end];
  }, [visible.length, scrollTop, viewportH]);

  /* ---------- selection ---------- */

  const toggleSelect = (entry: FileEntry, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (additive && prev.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.kind === "directory") void navigateTo(entry.path);
    else setEditorPath(entry.path);
  };

  /* ---------- operations ---------- */

  const runOp = async (op: FileOperation, successMsg?: string) => {
    setBusyKey(op.kind);
    try {
      const res = await call(window.vpsm.runOperation(profileId, op));
      toast({ kind: "success", title: successMsg ?? res.message, detail: res.undo ? "Undo available" : undefined });
      if (res.undo) setLastUndo({ label: res.undo.label, ops: res.undo.ops });
      await loadDir(cwd, false);
      return res;
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: e.sErr?.message ?? "Operation failed", detail: e.sErr?.detail ?? USER_HINT(e.sErr) });
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const askDelete = (paths: string[]) => {
    setConfirm({
      title: paths.length === 1 ? `Delete "${paths[0].split("/").pop()}"?` : `Delete ${paths.length} items?`,
      message: "Items will be moved to the app trash on the server (~/.vpsmgr-trash) and can be restored.",
      detail: <div className="mono">{paths.join("\n")}</div>,
      danger: true,
      confirmLabel: "Move to trash",
      action: async () => {
        const res = await runOp({ kind: "delete", paths, useTrash: true });
        if (res) setConfirm(null);
      }
    });
  };

  const askPermanentDelete = async (paths: string[]) => {
    setBusyKey("size");
    let sizeInfo = "";
    try {
      const { bytes, files } = await call(window.vpsm.sizeOf(profileId, paths));
      sizeInfo = `${files.toLocaleString()} files · ${fileSizeStr(bytes)}`;
    } catch { sizeInfo = "size unknown"; }
    setBusyKey(null);
    setConfirm({
      title: "Permanently delete?",
      message: (
        <div className="col" style={{ gap: 6 }}>
          <span>This action <strong>cannot be undone</strong>.</span>
          <span className="muted">Prefer "Move to trash" for recoverable deletion.</span>
        </div>
      ),
      detail: <div className="mono">{paths.join("\n")}{sizeInfo && `\n\n${sizeInfo}`}</div>,
      danger: true,
      confirmLabel: "Delete permanently",
      action: async () => {
        const res = await runOp({ kind: "delete", paths, useTrash: false }, "Deleted permanently");
        if (res) setConfirm(null);
      }
    });
  };

  const doPaste = async () => {
    if (!clipboard) return;
    const op = clipboard.op === "copy" ? "copy" : "move";
    const res = await runOp(op === "copy"
      ? { kind: "copy", sources: clipboard.paths, destDir: cwd }
      : { kind: "move", sources: clipboard.paths, destDir: cwd });
    if (res) setClipboard(null);
  };

  const uploadHere = async () => {
    const picked = await call(window.vpsm.pickLocalFile("open"));
    if (!picked) return;
    const files = picked.split("|").filter(Boolean);
    try {
      const n = await call(window.vpsm.smartUpload(profileId, files, cwd, true));
      toast({ kind: "info", title: `${n} upload${n === 1 ? "" : "s"} queued`, detail: "Progress is shown at the bottom-right." });
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Upload failed", detail: e.sErr?.message });
    }
  };

  const uploadFolderHere = async () => {
    const dir = await call(window.vpsm.pickFolder());
    if (!dir) return;
    try {
      const n = await call(window.vpsm.smartUpload(profileId, [dir], cwd, true));
      toast({ kind: "info", title: `Folder upload queued — ${n} file${n === 1 ? "" : "s"}`, detail: "Progress is shown at the bottom-right." });
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Folder upload failed", detail: e.sErr?.message });
    }
  };

  const downloadEntry = async (entry: FileEntry) => {
    const isDir = entry.kind === "directory";
    const defaultName = isDir ? `${entry.name}.zip` : entry.name;
    const target = await call(window.vpsm.pickLocalFile("save", defaultName));
    if (!target) return;
    try {
      if (isDir) {
        await call(window.vpsm.downloadFolder(profileId, entry.path, target));
        toast({ kind: "info", title: "Packing folder on the server…", detail: "The archive download will appear in the transfer dock." });
      } else {
        await call(window.vpsm.startDownload(profileId, entry.path, target));
        toast({ kind: "info", title: "Download started", detail: "Progress is shown at the bottom-right." });
      }
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Download failed", detail: e.sErr?.message });
    }
  };

  const askNewFolder = () => setPrompt({
    title: "Create folder",
    label: "Folder name",
    placeholder: "website",
    confirmLabel: "Create folder",
    validate: validateName,
    onConfirm: (v) => { setPrompt(null); void runOp({ kind: "mkdir", parent: cwd, name: v }); }
  });

  const askNewFile = () => setPrompt({
    title: "Create file",
    label: "File name",
    placeholder: "index.html",
    confirmLabel: "Create file",
    validate: validateName,
    onConfirm: (v) => { setPrompt(null); void runOp({ kind: "createFile", parent: cwd, name: v }); }
  });

  const askRename = (entry: FileEntry) => setPrompt({
    title: `Rename "${entry.name}"`,
    label: "New name",
    initial: entry.name,
    confirmLabel: "Rename",
    validate: validateName,
    onConfirm: (v) => { setPrompt(null); void runOp({ kind: "rename", path: entry.path, newName: v }); }
  });

  const undoLast = async () => {
    if (!lastUndo) return;
    setBusyKey("undo");
    try {
      for (const op of lastUndo.ops) {
        await call(window.vpsm.runOperation(profileId, op));
      }
      toast({ kind: "success", title: `Undone: ${lastUndo.label}` });
      setLastUndo(null);
      await loadDir(cwd, false);
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Undo failed", detail: e.sErr?.message });
    } finally {
      setBusyKey(null);
    }
  };
  const [lastUndo, setLastUndo] = useState<{ label: string; ops: FileOperation[] } | null>(null);

  /* ---------- drag & drop ---------- */

  const onDropExternal = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as File & { path?: string };
      if (f.path) paths.push(f.path);
      else toast({ kind: "warn", title: `Cannot access local path of "${f.name}"`, detail: "Use the Upload button instead." });
    }
    if (paths.length === 0) return;
    try {
      const n = await call(window.vpsm.smartUpload(profileId, paths, cwd, true));
      toast({ kind: "info", title: `${n} upload${n === 1 ? "" : "s"} queued`, detail: "Folders are uploaded recursively — watch the dock." });
    } catch (err) {
      const e2 = err as VpsmApiError;
      toast({ kind: "error", title: "Upload failed", detail: e2.sErr?.message });
    }
  };

  /* ---------- internal drag (move) ---------- */

  const [dragPaths, setDragPaths] = useState<string[] | null>(null);

  const onRowDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path];
    setDragPaths(paths);
    e.dataTransfer.setData("application/x-vpsm-paths", paths.join("\n"));
    e.dataTransfer.effectAllowed = "move";
  };

  const onRowDrop = async (e: React.DragEvent, target: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const raw = e.dataTransfer.getData("application/x-vpsm-paths");
    const paths = raw ? raw.split("\n").filter(Boolean) : dragPaths;
    setDragPaths(null);
    if (!paths || target.kind !== "directory") return;
    const sources = paths.filter((p) => p !== target.path && !target.path.startsWith(p + "/"));
    if (sources.length === 0) return;
    await runOp({ kind: "move", sources, destDir: target.path });
  };

  /* ---------- context menu ---------- */

  const menuItemsFor = (entry: FileEntry | null): CtxItem[] => {
    if (!entry) {
      return [
        { label: "New folder", icon: <PlusIcon size={15} />, action: askNewFolder },
        { label: "New file", icon: <EditIcon size={15} />, action: askNewFile },
        { label: "Upload here", icon: <Upload size={15} />, action: uploadHere },
        { label: "Paste", icon: <ClipboardPaste size={15} />, disabled: !clipboard, action: doPaste },
        { label: "Refresh", icon: <RefreshCw size={15} />, action: () => void loadDir(cwd, false) }
      ];
    }
    const isDir = entry.kind === "directory";
    const items: CtxItem[] = [];
    if (isDir) items.push({ label: "Open", icon: <FolderOpenIcon size={15} />, action: () => openEntry(entry) });
    else items.push({ label: "Open in editor", icon: <EditIcon size={15} />, action: () => setEditorPath(entry.path) });
    items.push({ label: "Quick look (info)", icon: <Eye size={15} />, action: () => setPermEntry(entry) });
    items.push({ sep: true });
    items.push({ label: "Rename", icon: <EditIcon size={15} />, disabled: isMulti, action: () => askRename(entry) });
    if (clipboard) {
      items.push({ label: `Paste into "${entry.name}"`, icon: <ClipboardPaste size={15} />, disabled: !isDir, action: async () => {
        const op = clipboard.op === "copy" ? { kind: "copy", sources: clipboard.paths, destDir: entry.path } as FileOperation : { kind: "move", sources: clipboard.paths, destDir: entry.path } as FileOperation;
        const res = await runOp(op);
        if (res) setClipboard(null);
      } });
    }
    items.push({ label: "Copy", icon: <CopyIcon size={15} />, action: () => { setClipboard({ op: "copy", paths: currentTargets(entry), fromDir: cwd }); toast({ kind: "info", title: "Copied to clipboard" }); } });
    items.push({ label: "Cut", icon: <Scissors size={15} />, action: () => { setClipboard({ op: "cut", paths: currentTargets(entry), fromDir: cwd }); toast({ kind: "info", title: "Cut — paste to move" }); } });
    items.push({ label: "Duplicate", icon: <CopyIcon size={15} />, disabled: isMulti, action: () => void runOp({ kind: "duplicate", paths: currentTargets(entry) }) });
    items.push({ sep: true });
    items.push({ label: "Download…", icon: <Download size={15} />, disabled: isMulti, action: () => void downloadEntry(entry) });
    items.push({ label: "Permissions…", icon: <Eye size={15} />, disabled: isMulti, action: () => setPermEntry(entry) });
    items.push({ label: "Copy path", icon: <CopyIcon size={15} />, action: () => { void navigator.clipboard.writeText(entry.path); toast({ kind: "info", title: "Path copied" }); } });
    items.push({ sep: true });
    items.push({ label: "Delete (trash)", icon: <TrashIcon2 size={15} />, danger: true, action: () => askDelete(currentTargets(entry)) });
    items.push({ label: "Delete permanently…", icon: <TrashIcon2 size={15} />, danger: true, action: () => void askPermanentDelete(currentTargets(entry)) });
    return items;
  };

  const isMulti = selected.size > 1;
  const currentTargets = (entry: FileEntry): string[] =>
    selected.has(entry.path) ? [...selected] : [entry.path];

  /* ---------- render ---------- */

  const crumbs = useMemo(() => {
    const parts = cwd.split("/").filter(Boolean);
    const acc: Array<{ name: string; path: string }> = [{ name: "/", path: "/" }];
    let cur = "";
    for (const p of parts) {
      cur += `/${p}`;
      acc.push({ name: p, path: cur });
    }
    return acc;
  }, [cwd]);

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.stack.length - 1;

  return (
    <div className="page">
      {/* toolbar */}
      <div className="fm-toolbar">
        <button className="icon-btn fm-sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle sidebar"><ListTree size={18} /></button>
        <button className="icon-btn" onClick={goBack} disabled={!canGoBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <button className="icon-btn" onClick={goForward} disabled={!canGoForward} aria-label="Forward"><ArrowRight size={18} /></button>
        <button className="icon-btn" onClick={goUp} disabled={cwd === "/"} aria-label="Parent"><ArrowUp size={18} /></button>
        <button className="icon-btn" onClick={goHome} aria-label="Home"><Home size={18} /></button>
        <div className="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="row" style={{ gap: 2 }}>
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className={`crumb${i === crumbs.length - 1 ? " current" : ""}`} onClick={() => void navigateTo(c.path)}>{c.name}</button>
            </span>
          ))}
          {loading && <span className="spinner" style={{ marginLeft: 8 }} />}
        </div>
        <button className="icon-btn" onClick={() => setSearchOpen(true)} aria-label="Search"><Search size={18} /></button>
        <button className="icon-btn" onClick={() => { setShowHidden((v) => !v); }} aria-label="Toggle hidden files" style={{ color: showHidden ? "var(--accent)" : undefined }}><Eye size={18} /></button>
        <button className="icon-btn" onClick={() => void loadDir(cwd, false)} aria-label="Refresh"><RefreshCw size={18} /></button>
        <button className="btn small primary" onClick={uploadHere}><Upload size={14} /> Upload</button>
        <button className="btn small" onClick={uploadFolderHere} title="Upload a folder recursively"><Upload size={14} /> 📁</button>
      </div>

      <div className="fm-layout">
        <aside className={`fm-sidebar${sidebarOpen ? " open" : ""}`}>
          <FileTree profileId={profileId} currentPath={cwd} onOpen={(p) => { void navigateTo(p); setSidebarOpen(false); }} />
        </aside>

        <div className="fm-main">
          {/* filter row */}
          <div className="row" style={{ padding: "7px 12px", borderBottom: "1px solid var(--border-soft)" }}>
            <input className="input" style={{ maxWidth: 260, minHeight: 30 }} placeholder="Filter current folder…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select className="input" style={{ width: 110, minHeight: 30 }} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sort by">
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="mtime">Modified</option>
              <option value="kind">Type</option>
            </select>
            <button className="btn small" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>{sortDir === "asc" ? "↑ Asc" : "↓ Desc"}</button>
            {lastUndo && (
              <button className="btn small" onClick={() => void undoLast()} disabled={busyKey === "undo"}>
                <RotateCcw size={13} /> Undo: {lastUndo.label}
              </button>
            )}
            <div className="spacer" />
            <span className="faint">{visible.length} of {entries.length} items</span>
          </div>

          <div
            className="fm-filelist"
            ref={listRef}
            tabIndex={0}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const t = e.target as HTMLElement;
              if (t.closest(".fm-row") || t.closest(".fm-header") || t.closest("button")) return;
              // rubber-band multi-select from empty space
              setSelected(new Set());
              const box = listRef.current!.getBoundingClientRect();
              const x0 = e.clientX, y0 = e.clientY;
              const startY = box.top + 30; // rows start below the sticky header
              const move = (ev: MouseEvent) => {
                const x1 = ev.clientX, y1 = ev.clientY;
                setBand({ x0, y0, x1, y1 });
                const sel = new Set<string>();
                rowEls.current.forEach((r, p) => {
                  const rt = startY + r.top - listRef.current!.scrollTop;
                  const rb = rt + 40;
                  const maxY = Math.max(y0, y1);
                  const minY = Math.min(y0, y1);
                  if (rb > minY && rt < maxY) sel.add(p);
                });
                setSelected(sel);
              };
              const up = () => {
                setBand(null);
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
              setBand({ x0, y0, x1: x0, y1: y0 });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, entry: null });
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDropExternal}
          >
            <div className="fm-header">
              <button className="h-sort" onClick={() => { setSortKey("name"); setSortDir(sortKey === "name" && sortDir === "asc" ? "desc" : "asc"); }}>Name</button>
              <button className="h-sort col-size-h" onClick={() => { setSortKey("size"); setSortDir(sortKey === "size" && sortDir === "asc" ? "desc" : "asc"); }}>Size</button>
              <button className="h-sort" onClick={() => { setSortKey("mtime"); setSortDir(sortKey === "mtime" && sortDir === "asc" ? "desc" : "asc"); }}>Modified</button>
              <button className="h-sort col-perm-h" onClick={() => { setSortKey("kind"); setSortDir(sortKey === "kind" && sortDir === "asc" ? "desc" : "asc"); }}>Owner / Perms</button>
              <span />
            </div>

            {loadError && (
              <div className="fm-empty">
                <div style={{ color: "var(--red)" }}>⚠ {loadError.message}</div>
                {loadError.detail && <div className="faint" style={{ maxWidth: 420 }}>{loadError.detail}</div>}
                <button className="btn" onClick={() => void loadDir(cwd, false)}>Retry</button>
              </div>
            )}

            {!loadError && visible.length === 0 && !loading && (
              <div className="fm-empty">
                {entries.length === 0 ? <FolderOpenIcon size={34} /> : <Search size={30} />}
                <div>{entries.length === 0 ? "This folder is empty" : "No items match the filter"}</div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn small" onClick={askNewFolder}><PlusIcon size={14} /> New folder</button>
                  <button className="btn small" onClick={askNewFile}><EditIcon size={14} /> New file</button>
                </div>
              </div>
            )}

            <div style={{ height: padTop }} />
            {visible.slice(sliceStart, sliceEnd).map((en) => (
              <div
                key={en.path}
                data-path={en.path}
                ref={(el) => {
                  if (el) {
                    const r = el.getBoundingClientRect();
                    rowEls.current.set(en.path, { top: r.top, bottom: r.bottom });
                  } else rowEls.current.delete(en.path);
                }}
                className={`fm-row${selected.has(en.path) ? " selected" : ""}${clipboard?.op === "cut" && clipboard.paths.includes(en.path) ? " cut" : ""}`}
                onClick={(e) => toggleSelect(en, e.ctrlKey || e.metaKey)}
                onDoubleClick={() => openEntry(en)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!selected.has(en.path)) setSelected(new Set([en.path]));
                  setCtxMenu({ x: e.clientX, y: e.clientY, entry: en });
                }}
                draggable
                onDragStart={(e) => onRowDragStart(e, en)}
                onDragOver={(e) => { if (en.kind === "directory") { e.preventDefault(); e.stopPropagation(); } }}
                onDrop={(e) => void onRowDrop(e, en)}
                aria-selected={selected.has(en.path)}
              >
                <div className="fm-name">
                  <FileTypeIcon name={en.name} kind={en.kind} />
                  <span className={`name${en.kind === "directory" ? " is-dir" : ""}`}>{en.name}</span>
                  {en.kind === "symlink" && en.target && <span className="link-target">→ {en.target}{en.linkTargetKind === "broken" ? " (broken)" : ""}</span>}
                </div>
                <div className="fm-meta col-size">{en.kind === "directory" ? "—" : fileSizeStr(en.size)}</div>
                <div className="fm-meta">{dateStr(en.mtimeMs)}</div>
                <div className="fm-meta col-perm">{en.owner}:{en.group} · {en.perms}</div>
                <button
                  className="icon-btn"
                  onClick={(e) => { e.stopPropagation(); setSelected(new Set([en.path])); setCtxMenu({ x: e.clientX, y: e.clientY, entry: en }); }}
                  aria-label="Item menu"
                >
                  <MoreIcon size={16} />
                </button>
              </div>
            ))}
            <div style={{ height: padBottom }} />
            {band && (
              <div
                className="rubber-band"
                style={{
                  left: Math.min(band.x0, band.x1),
                  top: Math.min(band.y0, band.y1),
                  width: Math.abs(band.x1 - band.x0),
                  height: Math.abs(band.y1 - band.y0)
                }}
              />
            )}
            {dragOver && <div className="fm-drop-overlay">Drop files to upload to {cwd}</div>}
          </div>

          {selected.size > 0 && (
            <div className="selection-bar">
              <strong style={{ fontSize: 13 }}>{selected.size} selected</strong>
              <button className="btn small" onClick={() => { setClipboard({ op: "copy", paths: [...selected], fromDir: cwd }); toast({ kind: "info", title: "Copied" }); }}>Copy</button>
              <button className="btn small" onClick={() => { setClipboard({ op: "cut", paths: [...selected], fromDir: cwd }); toast({ kind: "info", title: "Cut" }); }}>Cut</button>
              <button className="btn small" onClick={() => askDelete([...selected])}><TrashIcon2 size={13} /> Delete</button>
              <div className="spacer" />
              <button className="btn small ghost" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          {clipboard && selected.size === 0 && (
            <div className="selection-bar">
              <span style={{ fontSize: 13 }}>{clipboard.op === "copy" ? "Copied" : "Cut"}: {clipboard.paths.length} item(s)</span>
              <button className="btn small primary" onClick={() => void doPaste()} disabled={clipboard.fromDir === cwd && clipboard.op === "cut"}>Paste here</button>
              <button className="btn small ghost" onClick={() => setClipboard(null)}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* overlays */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItemsFor(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          placeholder={prompt.placeholder}
          confirmLabel={prompt.confirmLabel}
          validate={prompt.validate}
          onConfirm={prompt.onConfirm}
          onCancel={() => setPrompt(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          detail={confirm.detail}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel}
          busy={busyKey === "delete"}
          onConfirm={() => void confirm.action()}
          onCancel={() => setConfirm(null)}
        />
      )}

      {permEntry && <PermissionsDialog profileId={profileId} entry={permEntry} onClose={() => setPermEntry(null)} onApplied={() => void loadDir(cwd, false)} />}

      {editorPath && (
        <EditorOverlay
          profileId={profileId}
          path={editorPath}
          onClose={() => setEditorPath(null)}
          onSaved={() => void loadDir(cwd, false)}
        />
      )}

      {searchOpen && (
        <SearchDialog
          profileId={profileId}
          baseDir={cwd}
          onClose={() => setSearchOpen(false)}
          onOpen={(p, kind) => { setSearchOpen(false); if (kind === "directory") void navigateTo(p); else setEditorPath(p); }}
        />
      )}
    </div>
  );
}

function SearchDialog({ profileId, baseDir, onClose, onOpen }: {
  profileId: string;
  baseDir: string;
  onClose(): void;
  onOpen(path: string, kind: "file" | "directory"): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(4);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call(window.vpsm.search(profileId, baseDir, query.trim(), { maxDepth: depth, maxResults: 500 }));
      setResults(r);
    } catch (err) {
      const e = err as VpsmApiError;
      setError(e.sErr?.message ?? "Search failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Search in ${baseDir}`} wide onClose={onClose}>
      <div className="row">
        <input
          className="input" autoFocus placeholder="File or folder name contains…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
        />
        <select className="input" style={{ width: 130 }} value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Depth">
          <option value={2}>2 levels</option>
          <option value={4}>4 levels</option>
          <option value={6}>6 levels</option>
          <option value={8}>8 levels</option>
        </select>
        <button className="btn primary" onClick={() => void run()} disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : <Search size={15} />} Search
        </button>
      </div>
      {error && <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>}
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {results?.map((r) => (
          <button key={r.path} className="ctx-item" style={{ width: "100%" }} onClick={() => onOpen(r.path, r.kind)}>
            <FileTypeIcon name={r.name} kind={r.kind} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              <span className="mono" style={{ fontSize: 12 }}>{r.path}</span>
            </span>
            <span className="spacer" />
            <span className="faint">{r.kind === "file" ? fileSizeStr(r.size) : "folder"}</span>
          </button>
        ))}
        {results && results.length === 0 && <div className="faint" style={{ padding: 14 }}>No matches found.</div>}
      </div>
    </Modal>
  );
}

function validateName(v: string): string | null {
  if (!v) return "Name is required";
  if (v === "." || v === "..") return "This name is reserved";
  if (v.includes("/") || v.includes("\\")) return "Name cannot contain / or \\";
  if (v.includes("\u0000")) return "Name contains invalid characters";
  if (v.length > 255) return "Name is too long (max 255)";
  return null;
}

function USER_HINT(e?: SerializedVpsmError): string | undefined {
  if (e?.code === "EPERM") return "Try connecting with an account that has sufficient permissions, or use sudo.";
  if (e?.code === "ENOSPC") return "Free some space on the server and try again.";
  return undefined;
}
