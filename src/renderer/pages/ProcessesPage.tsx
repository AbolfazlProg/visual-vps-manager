import { useEffect, useState } from "react";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { RefreshCw } from "../components/icons";
import { fileSizeStr } from "../components/icons";
import type { ProcessInfo } from "../../shared/protocol";
import { Modal } from "../components/Modal";

export function ProcessesPage({ profileId }: { profileId: string }) {
  const { states, toast } = useApp();
  const connected = states[profileId]?.status === "connected";
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmKill, setConfirmKill] = useState<ProcessInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connected) return;
    void reload();
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const reload = async () => {
    try {
      const list = await call(window.vpsm.listProcesses(profileId));
      setProcs(list);
      setError(null);
    } catch (err) {
      const e = err as VpsmApiError;
      setError(e.sErr?.message ?? "failed to list processes");
    }
  };

  if (!connected) return <div className="center-note"><div>Not connected.</div></div>;

  const filtered = (procs ?? []).filter((p) => !filter || p.command.toLowerCase().includes(filter.toLowerCase()) || p.user === filter);
  const totalCpu = (procs ?? []).reduce((a, p) => a + p.cpuPercent, 0);
  const totalRss = (procs ?? []).reduce((a, p) => a + p.rssBytes, 0);

  const kill = async (p: ProcessInfo, signal: "TERM" | "KILL") => {
    setBusy(true);
    try {
      await call(window.vpsm.killProcess(profileId, p.pid, signal));
      toast({ kind: "success", title: `Sent SIG${signal} to PID ${p.pid}` });
      await reload();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({
        kind: "error",
        title: e.sErr?.message ?? "kill failed",
        detail: e.sErr?.code === "EPERM" || e.sErr?.code === "EACCES_ROOT" ? "Process belongs to another user — unlock sudo in Monitor and retry." : e.sErr?.detail
      });
    } finally {
      setBusy(false);
      setConfirmKill(null);
    }
  };

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 12 }}>
          <h1 className="page-title">Processes</h1>
          <span className="faint">{filtered.length} shown · Σ CPU {totalCpu.toFixed(1)}% · Σ RSS {fileSizeStr(totalRss)}</span>
          <div className="spacer" />
          <input className="input" style={{ maxWidth: 200 }} placeholder="Filter by name / user…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn small" onClick={() => void reload()}><RefreshCw size={14} /> Refresh</button>
        </div>

        {error && <div style={{ color: "var(--red)", marginBottom: 10 }}>⚠ {error}</div>}

        <div className="proc-rows">
          <div className="proc-row" style={{ color: "var(--text-faint)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em", position: "sticky", top: 0, background: "var(--bg-2)" }}>
            <span>PID</span><span className="col-user">User</span><span>CPU%</span><span>MEM%</span><span className="col-rss">RSS</span><span>Command</span><span />
          </div>
          {filtered.slice(0, 200).map((p) => (
            <div key={p.pid} className="proc-row" style={{ fontSize: 12.5 }}>
              <span className="mono">{p.pid}</span>
              <span className="col-user muted mono">{p.user}</span>
              <span className="mono" style={{ color: p.cpuPercent > 50 ? "var(--red)" : undefined }}>{p.cpuPercent.toFixed(1)}</span>
              <span className="mono">{p.memPercent.toFixed(1)}</span>
              <span className="mono col-rss">{fileSizeStr(p.rssBytes)}</span>
              <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.command}</span>
              <button className="btn small danger" onClick={() => setConfirmKill(p)}>Kill</button>
            </div>
          ))}
        </div>
        <div className="faint" style={{ marginTop: 8 }}>Auto-refreshes every 5s. Killing a process interrupts it — send SIGTERM first (default), SIGKILL as last resort.</div>
      </div>

      {confirmKill && (
        <Modal
          title={`Kill PID ${confirmKill.pid}?`}
          onClose={() => setConfirmKill(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmKill(null)} disabled={busy}>Cancel</button>
              <button className="btn" onClick={() => void kill(confirmKill, "TERM")} disabled={busy}>SIGTERM (graceful)</button>
              <button className="btn danger" onClick={() => void kill(confirmKill, "KILL")} disabled={busy}>SIGKILL (force)</button>
            </>
          }
        >
          <div className="card mono" style={{ fontSize: 12 }}>
            {confirmKill.user} · PID {confirmKill.pid} · CPU {confirmKill.cpuPercent}% · RSS {fileSizeStr(confirmKill.rssBytes)}
            <br />{confirmKill.command}
          </div>
          <p className="muted" style={{ margin: 0 }}>Killing a process can interrupt services and cause data loss. Prefer SIGTERM.</p>
        </Modal>
      )}
    </div>
  );
}
