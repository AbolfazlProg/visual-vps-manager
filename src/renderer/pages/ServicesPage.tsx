import { useEffect, useState } from "react";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { RefreshCw, Play, Square, RotateCw } from "../components/icons";
import type { ServiceInfo } from "../../shared/protocol";
import { Modal } from "../components/Modal";
import { SudoPanel } from "../components/SudoPanel";

const STATE_META: Record<string, { color: string; label: string }> = {
  running: { color: "var(--green)", label: "Running" },
  stopped: { color: "var(--text-dim)", label: "Stopped" },
  failed: { color: "var(--red)", label: "Failed" },
  unknown: { color: "var(--yellow)", label: "Unknown" },
  static: { color: "var(--text-faint)", label: "Static" }
};

export function ServicesPage({ profileId }: { profileId: string }) {
  const { states, toast, navigate } = useApp();
  const connected = states[profileId]?.status === "connected";
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<{ unit: string; action: "start" | "stop" | "restart" } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (connected) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const reload = async () => {
    setError(null);
    try {
      const list = await call(window.vpsm.listServices(profileId));
      setServices(list);
    } catch (err) {
      const e = err as VpsmApiError;
      setError(e.sErr?.message ?? "failed to list services");
    }
  };

  if (!connected) return <div className="center-note"><div>Not connected.</div></div>;

  const filtered = (services ?? []).filter((s) => !filter || s.unit.includes(filter.toLowerCase()) || s.description.toLowerCase().includes(filter.toLowerCase()));
  const interesting = filtered.filter((s) => s.state === "running" || s.state === "failed");
  const shown = showAll ? filtered : interesting;

  const doAction = async (unit: string, action: "start" | "stop" | "restart") => {
    setBusyUnit(unit);
    try {
      const r = await call(window.vpsm.serviceAction(profileId, unit, action));
      if (r.ok) toast({ kind: "success", title: `${action} → ${unit}` });
      else toast({ kind: "error", title: `${action} ${unit} failed`, detail: r.output });
      await reload();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({
        kind: "error",
        title: e.sErr?.message ?? "service action failed",
        detail: e.sErr?.code === "EACCES_ROOT" ? "Unlock sudo in the panel above, then try again." : e.sErr?.detail
      });
    } finally {
      setBusyUnit(null);
      setConfirm(null);
    }
  };

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 12 }}>
          <h1 className="page-title">Services</h1>
          <div className="spacer" />
          <input className="input" style={{ maxWidth: 220 }} placeholder="Filter services…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn small" onClick={() => void reload()}><RefreshCw size={14} /> Refresh</button>
        </div>

        <SudoPanel profileId={profileId} />

        {error && <div style={{ color: "var(--red)", marginBottom: 10 }}>⚠ {error}</div>}

        {!services ? (
          <div className="center-note"><span className="spinner" /> loading services…</div>
        ) : (
          <>
            <div className="svc-rows">
              {shown.map((s) => {
                const meta = STATE_META[s.state] ?? STATE_META.unknown;
                return (
                  <div key={s.unit} className="svc-row">
                    <span className="svc-state-icon"><span className="dot" style={{ width: 9, height: 9, borderRadius: "50%", background: meta.color, display: "inline-block" }} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 13 }}>{s.unit}</div>
                      <div className="faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description}</div>
                    </div>
                    <span className="faint">{meta.label}</span>
                    <button className="btn small ghost" onClick={() => navigate({ view: "logs", profileId })} title="View logs">Logs</button>
                    <div className="row" style={{ gap: 4 }}>
                      {s.state !== "running" && (
                        <button className="icon-btn" title="Start" disabled={busyUnit === s.unit} onClick={() => setConfirm({ unit: s.unit, action: "start" })}><Play size={15} /></button>
                      )}
                      {s.state === "running" && (
                        <>
                          <button className="icon-btn" title="Restart" disabled={busyUnit === s.unit} onClick={() => setConfirm({ unit: s.unit, action: "restart" })}><RotateCw size={15} /></button>
                          <button className="icon-btn" title="Stop" disabled={busyUnit === s.unit} onClick={() => setConfirm({ unit: s.unit, action: "stop" })}><Square size={15} /></button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {shown.length === 0 && <div className="faint" style={{ padding: 16 }}>No matching services.</div>}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show active only" : `Show all (${filtered.length})`}
              </button>
            </div>
          </>
        )}
      </div>

      {confirm && (
        <Modal
          title={`${confirm.action.toUpperCase()} ${confirm.unit}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn primary" onClick={() => void doAction(confirm.unit, confirm.action)}>
                {busyUnit === confirm.unit ? <span className="spinner" /> : null} Confirm
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This runs <span className="mono">systemctl {confirm.action} {confirm.unit}</span> on the server{confirm.action !== "start" ? " and may cause a short downtime of the service" : ""}.
          </p>
        </Modal>
      )}
    </div>
  );
}
