import { useState } from "react";
import { Modal } from "./Modal";
import { call } from "../ipc";
import { useApp } from "../store";
import type { FileEntry } from "../../shared/protocol";
import { fileSizeStr, dateStr } from "./icons";
import { VpsmApiError } from "../ipc";

type Tri = boolean | null; // null = unset

interface PermBits { read: Tri; write: Tri; execute: Tri }

function modeToBits(mode: number): { owner: PermBits; group: PermBits; others: PermBits; setuid: boolean; setgid: boolean; sticky: boolean } {
  const bit = (m: number, r: number): Tri => ((m >> r) & 1) === 1;
  return {
    owner: { read: bit(mode, 8), write: bit(mode, 7), execute: bit(mode, 6) },
    group: { read: bit(mode, 5), write: bit(mode, 4), execute: bit(mode, 3) },
    others: { read: bit(mode, 2), write: bit(mode, 1), execute: bit(mode, 0) },
    setuid: ((mode >> 11) & 1) === 1,
    setgid: ((mode >> 10) & 1) === 1,
    sticky: ((mode >> 9) & 1) === 1
  };
}

function bitsToOctal(b: { owner: PermBits; group: PermBits; others: PermBits }): string {
  const tri = (p: PermBits): number =>
    (p.read === false ? 0 : 4) + (p.write === false ? 0 : 2) + (p.execute === false ? 0 : 1);
  return `${tri(b.owner)}${tri(b.group)}${tri(b.others)}`;
}

export function PermissionsDialog({ profileId, entry, onClose, onApplied }: {
  profileId: string;
  entry: FileEntry;
  onClose(): void;
  onApplied(): void;
}) {
  const { toast } = useApp();
  const initial = modeToBits(parseInt(entry.perms, 8));
  const [bits, setBits] = useState<{ owner: PermBits; group: PermBits; others: PermBits }>({
    owner: initial.owner, group: initial.group, others: initial.others
  });
  const [recursive, setRecursive] = useState(false);
  const [owner, setOwner] = useState(entry.owner);
  const [group, setGroup] = useState(entry.group);
  const [busy, setBusy] = useState(false);
  const [sudoHint, setSudoHint] = useState(false);

  const octal = bitsToOctal(bits);
  const isDir = entry.kind === "directory";

  const applyPerms = async () => {
    setBusy(true);
    setSudoHint(false);
    try {
      await call(window.vpsm.runOperation(profileId, { kind: "chmod", path: entry.path, mode: octal, recursive: recursive && isDir }));
      toast({ kind: "success", title: `Permissions set to ${octal}` });
      onApplied();
      onClose();
    } catch (err) {
      const e = err as VpsmApiError;
      if (e.sErr?.code === "EPERM") setSudoHint(true);
      toast({ kind: "error", title: e.sErr?.message ?? "Failed to change permissions", detail: e.sErr?.detail });
    } finally {
      setBusy(false);
    }
  };

  const applyOwner = async () => {
    setBusy(true);
    try {
      await call(window.vpsm.runOperation(profileId, { kind: "chown", path: entry.path, owner: owner.trim(), group: group.trim() || null, recursive: recursive && isDir }));
      toast({ kind: "success", title: "Owner updated" });
      onApplied();
      onClose();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: e.sErr?.message ?? "Failed to change owner", detail: e.sErr?.detail ?? "Changing owner usually requires administrator (root/sudo) privileges on the server." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Permissions — ${entry.name}`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => void applyOwner()} disabled={busy || !/^[A-Za-z0-9_.-]+$/.test(owner.trim())}>Apply owner</button>
          <button className="btn primary" onClick={() => void applyPerms()} disabled={busy}>Apply permissions</button>
        </>
      }
    >
      <div className="card" style={{ padding: 10 }}>
        <div className="kv"><span className="k">Path</span><span className="v">{entry.path}</span></div>
        <div className="kv"><span className="k">Type</span><span className="v">{entry.kind}{isDir ? " (recursive apply available)" : ""}</span></div>
        <div className="kv"><span className="k">Size</span><span className="v">{entry.kind === "directory" ? "—" : fileSizeStr(entry.size)}</span></div>
        <div className="kv"><span className="k">Modified</span><span className="v">{dateStr(entry.mtimeMs)}</span></div>
        <div className="kv"><span className="k">Owner / Group</span><span className="v">{entry.uid} ({entry.owner}) / {entry.gid} ({entry.group})</span></div>
      </div>

      <PermGrid bits={bits} onChange={setBits} />

      <div className="row">
        <div className="field" style={{ width: 110 }}>
          <label htmlFor="perm-octal">Permission #</label>
          <input id="perm-octal" className="input mono" value={octal} readOnly />
        </div>
        <div className="field grow">
          <label htmlFor="perm-owner">Owner (user)</label>
          <input id="perm-owner" className="input mono" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </div>
        <div className="field" style={{ width: 110 }}>
          <label htmlFor="perm-group">Group</label>
          <input id="perm-group" className="input mono" value={group} onChange={(e) => setGroup(e.target.value)} />
        </div>
      </div>

      {isDir && (
        <label className="checkbox-row">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Apply recursively to all contained files and folders
        </label>
      )}

      {sudoHint && (
        <div className="sudo-banner">
          You don't own this item. Re-apply after granting elevated privileges (unlock sudo in the Monitor page),
          or connect as a user with sufficient permissions.
        </div>
      )}
    </Modal>
  );
}

function PermGrid({ bits, onChange }: {
  bits: { owner: PermBits; group: PermBits; others: PermBits };
  onChange(b: { owner: PermBits; group: PermBits; others: PermBits }): void;
}) {
  const classOf = (cls: "owner" | "group" | "others", key: keyof PermBits): Tri => bits[cls][key];
  const set = (cls: "owner" | "group" | "others", key: keyof PermBits, v: Tri) => {
    onChange({ ...bits, [cls]: { ...bits[cls], [key]: v } });
  };

  const rows: Array<{ cls: "owner" | "group" | "others"; label: string }> = [
    { cls: "owner", label: "Owner" },
    { cls: "group", label: "Group" },
    { cls: "others", label: "Others" }
  ];

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--text-dim)", fontSize: 12 }}>
            <th style={{ textAlign: "left", padding: "4px 8px" }}>Who</th>
            <th style={{ padding: 4 }}>Read</th>
            <th style={{ padding: 4 }}>Write</th>
            <th style={{ padding: 4 }}>Execute</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cls}>
              <td style={{ padding: "5px 8px", fontWeight: 600 }}>{r.label}</td>
              {(["read", "write", "execute"] as const).map((k) => (
                <td key={k} style={{ textAlign: "center" }}>
                  <TriCheck value={classOf(r.cls, k)} onToggle={() => set(r.cls, k, !(classOf(r.cls, k) ?? true))} label={`${r.cls} ${k}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TriCheck({ value, onToggle, label }: { value: Tri; onToggle(): void; label: string }) {
  const on = value !== false;
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      aria-label={label}
      className="icon-btn"
      style={{ color: on ? "var(--green)" : "var(--text-faint)" }}
    >
      {on ? "✓" : "✗"}
    </button>
  );
}
