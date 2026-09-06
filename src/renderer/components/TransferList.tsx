import { useEffect, useState } from "react";
import { useApp } from "../store";
import { call } from "../ipc";
import { RefreshCw, X } from "./icons";
import { fileSizeStr } from "./icons";
import type { TransferState } from "../../shared/protocol";

export function TransferList({ profileId }: { profileId: string }) {
  const { transfers } = useApp();
  const [refreshKey, setRefreshKey] = useState(0);
  const mine = transfers.filter((t) => !profileId || t.profileId === profileId);

  useEffect(() => {
    void (async () => {
      try {
        await call(window.vpsm.listTransfers(profileId));
        setRefreshKey((k) => k + 1);
      } catch { /* noop */ }
    })();
  }, [profileId, refreshKey]);

  if (mine.length === 0) {
    return <div className="center-note" style={{ minHeight: 160 }}><div>No transfers yet.</div><div className="faint">Upload from the file manager toolbar or drag files in; download from the context menu.</div></div>;
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row"><div className="spacer" /><button className="btn small" onClick={() => setRefreshKey((k) => k + 1)}><RefreshCw size={13} /> Refresh</button></div>
      {mine.map((t) => (
        <TransferRow key={t.id} t={t} />
      ))}
    </div>
  );
}

function TransferRow({ t }: { t: TransferState }) {
  const pct = t.totalBytes > 0 ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : (t.status === "done" ? 100 : 0);
  const elapsed = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
  const eta = t.speedBps > 0 && t.status === "running" ? Math.max(0, Math.round((t.totalBytes - t.transferredBytes) / t.speedBps)) : null;
  const color = t.status === "done" ? "done" : t.status === "error" ? "error" : "";

  return (
    <div className="transfer-row">
      <div className="row">
        <span className="badge">{t.kind === "upload" ? "↑ UP" : "↓ DL"}</span>
        <span className="mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.remotePath}</span>
        <div className="spacer" />
        <span className="faint">{t.status}{t.status === "running" && eta !== null ? ` · ETA ${eta}s` : ""}</span>
        {t.status === "running" && <CancelButton id={t.id} />}
      </div>
      <div className="progress-track"><div className={`progress-fill ${color}`} style={{ width: `${pct}%` }} /></div>
      <div className="row" style={{ fontSize: 11.5 }}>
        <span className="faint">{fileSizeStr(t.transferredBytes)} / {fileSizeStr(t.totalBytes)}</span>
        <div className="spacer" />
        {t.speedBps > 0 && <span className="faint">{fileSizeStr(t.speedBps)}/s</span>}
        {t.resumedFrom ? <span className="faint">resumed from {fileSizeStr(t.resumedFrom)}</span> : null}
        {t.error && <span style={{ color: "var(--red)", fontSize: 12 }}>{t.error.message}</span>}
        {elapsed > 0 && t.status === "done" && <span className="faint">{elapsed.toFixed(1)}s</span>}
      </div>
    </div>
  );
}

function CancelButton({ id }: { id: string }) {
  return (
    <button className="icon-btn" onClick={() => void call(window.vpsm.cancelTransfer(id))} aria-label="Cancel transfer">
      <X size={14} />
    </button>
  );
}
