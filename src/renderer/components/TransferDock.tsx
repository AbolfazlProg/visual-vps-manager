import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import { call } from "../ipc";
import { Upload, Download, X, ChevronUp, ChevronDown, AlertTriangle, Check } from "./icons";
import { fileSizeStr } from "./icons";
import type { TransferState } from "../../shared/protocol";

const MAX_COLLAPSED = 3;
/** how long the dock lingers after the last transfer settles (no errors) */
const AUTO_HIDE_MS = 5000;

export function TransferDock() {
  const { transfers } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const active = useMemo(
    () => transfers.filter((t) => t.status === "running" || t.status === "queued"),
    [transfers]
  );
  const settled = useMemo(
    () => transfers.filter((t) => t.status === "done" || t.status === "error" || t.status === "canceled").slice(0, 8),
    [transfers]
  );
  const errs = useMemo(() => transfers.filter((t) => t.status === "error").length, [transfers]);

  // a brand-new transfer always re-opens the dock
  useEffect(() => {
    if (active.length > 0) setDismissed(false);
  }, [active.length]);

  // everything finished cleanly → linger briefly, then get out of the way.
  // errors keep the dock open so the user can read them (close manually).
  useEffect(() => {
    if (active.length === 0 && errs === 0 && settled.length > 0) {
      const t = setTimeout(() => setDismissed(true), AUTO_HIDE_MS);
      return () => clearTimeout(t);
    }
  }, [active.length, errs, settled.length]);

  if (dismissed) return null;

  const shown = expanded ? [...active, ...settled] : [...active, ...settled].slice(0, MAX_COLLAPSED);
  // nothing to show (no transfers at all) → stay hidden
  if (shown.length === 0) return null;
  const totalActiveBytes = active.reduce((a, t) => a + t.transferredBytes, 0);
  const totalActiveSize = active.reduce((a, t) => a + t.totalBytes, 0);
  const aggPct = totalActiveSize > 0 ? (totalActiveBytes / totalActiveSize) * 100 : active.length > 0 ? 0 : 100;

  return (
    <div className="transfer-dock" role="region" aria-label="Transfer progress">
      <div className="td-head-row">
        <button className="td-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {active.length > 0 ? <Upload size={15} className="td-spin" /> : errs > 0 ? <AlertTriangle size={15} color="var(--red)" /> : <Check size={15} color="var(--green)" />}
          <span>
            {active.length > 0
              ? `${active.length} active · ${fileSizeStr(totalActiveBytes)} / ${fileSizeStr(totalActiveSize)}`
              : errs > 0
                ? `${errs} transfer${errs > 1 ? "s" : ""} failed`
                : "Transfers completed"}
          </span>
          <div className="spacer" />
          <span className="faint">{Math.round(aggPct)}%</span>
          {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <button
          className="icon-btn td-close"
          onClick={() => setDismissed(true)}
          aria-label="Close transfer panel"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="td-agg"><div className="td-agg-fill" style={{ width: `${aggPct}%` }} /></div>
      <div className="td-list">
        {shown.map((t) => <Row key={t.id} t={t} />)}
        {!expanded && (active.length + settled.length) > MAX_COLLAPSED && (
          <button className="td-more" onClick={() => setExpanded(true)}>+{active.length + settled.length - MAX_COLLAPSED} more…</button>
        )}
      </div>
    </div>
  );
}

function Row({ t }: { t: TransferState }) {
  const pct = t.totalBytes > 0 ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : t.status === "done" ? 100 : 0;
  const eta = t.speedBps > 0 && t.status === "running" ? Math.max(0, Math.round((t.totalBytes - t.transferredBytes) / t.speedBps)) : null;
  const isArchive = t.localPath.endsWith(".zip") || t.localPath.endsWith(".tar.gz");
  const short = isArchive
    ? `📁 ${t.localPath.split(/[\\/]/).pop()} (folder archive)`
    : t.kind === "upload" ? t.remotePath.split("/").pop() : t.localPath.split(/[\\/]/).pop();

  const cancel = async () => {
    try { await call(window.vpsm.cancelTransfer(t.id)); } catch { /* noop */ }
  };
  const retry = async () => {
    try { await call(window.vpsm.resumeTransfer(t.id)); } catch { /* noop */ }
  };

  return (
    <div className="td-row">
      <div className="td-line">
        {t.kind === "upload" ? <Upload size={13} /> : <Download size={13} />}
        <span className="td-name" title={t.kind === "upload" ? t.remotePath : t.localPath}>{short}</span>
        <span className="td-meta">
          {t.status === "running" && t.speedBps > 0 ? `${fileSizeStr(t.speedBps)}/s` : ""}
          {t.status === "running" && eta !== null ? ` · ETA ${eta}s` : ""}
          {t.status === "queued" ? "queued…" : ""}
          {t.status === "done" ? "done" : ""}
          {t.status === "canceled" ? "canceled" : ""}
        </span>
        <div className="spacer" />
        {(t.status === "running" || t.status === "queued") && (
          <button className="icon-btn" onClick={() => void cancel()} aria-label="Cancel transfer" title="Cancel"><X size={13} /></button>
        )}
        {(t.status === "error" || t.status === "canceled") && (
          <button className="icon-btn" onClick={() => void retry()} aria-label="Retry transfer" title="Retry"><RotateCwIcon /></button>
        )}
      </div>
      <div className="progress-track" style={{ height: 5 }}><div className={`progress-fill ${t.status === "done" ? "done" : t.status === "error" ? "error" : ""}`} style={{ width: `${pct}%` }} /></div>
      {t.status === "error" && t.error && <div className="td-err" title={t.error.detail}>{t.error.message}</div>}
    </div>
  );
}

function RotateCwIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  );
}
