import { useEffect, useRef, useState } from "react";
import { useApp, metricsOf } from "../store";
import { call, VpsmApiError } from "../ipc";
import { RefreshCw, Cpu, MemoryStick, HardDrive, Wifi, Power, Clock } from "../components/icons";
import { fileSizeStr } from "../components/icons";
import { Modal } from "../components/Modal";
import { SudoPanel } from "../components/SudoPanel";
import type { MetricsSnapshot } from "../../shared/protocol";

export function DashboardPage({ profileId }: { profileId: string }) {
  const { states } = useApp();
  const connected = states[profileId]?.status === "connected";
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>({ cpu: [], mem: [], rx: [], tx: [] });
  const [confirmPower, setConfirmPower] = useState<"reboot" | "shutdown" | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await metricsOf(profileId);
        if (stopped) return;
        setSnap(s);
        setError(null);
        setHistory((h) => ({
          cpu: [...h.cpu.slice(-59), s.cpu.percent],
          mem: [...h.mem.slice(-59), s.mem.percent],
          rx: [...h.rx.slice(-59), s.net.rxBps],
          tx: [...h.tx.slice(-59), s.net.txBps]
        }));
      } catch (err) {
        if (!stopped) {
          const e = err as VpsmApiError;
          setError(e.sErr?.message ?? "metrics failed");
        }
      }
    };
    void tick();
    timerRef.current = setInterval(tick, 3000);
    return () => {
      stopped = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [connected, profileId]);

  if (!connected) {
    return <div className="center-note"><div>Not connected.</div></div>;
  }

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 12 }}>
          <h1 className="page-title">Monitor</h1>
          <div className="spacer" />
          {error && <span className="faint" style={{ color: "var(--red)" }}>{error}</span>}
          <button className="btn small" onClick={() => { void (async () => { try { setSnap(await metricsOf(profileId)); } catch { /* noop */ } })(); }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {!snap ? (
          <div className="center-note"><span className="spinner" /> collecting metrics…</div>
        ) : (
          <>
            <div className="dash-grid" style={{ marginBottom: 14 }}>
              <DonutCard icon={<Cpu size={17} />} title="CPU" percent={snap.cpu.percent}
                rows={[
                  ["Model", snap.cpu.model.slice(0, 30)],
                  ["Cores", String(snap.cpu.cores)],
                  ["Load (1/5/15)", `${snap.cpu.load1} / ${snap.cpu.load5} / ${snap.cpu.load15}`]
                ]}
                spark={history.cpu}
              />
              <DonutCard icon={<MemoryStick size={17} />} title="Memory" percent={snap.mem.percent}
                rows={[
                  ["Used / Total", `${fileSizeStr(snap.mem.usedBytes)} / ${fileSizeStr(snap.mem.totalBytes)}`],
                  ["Available", fileSizeStr(snap.mem.availableBytes)],
                  ["Cached", fileSizeStr(snap.mem.cachedBytes)]
                ]}
                spark={history.mem}
              />
              <DonutCard icon={<HardDrive size={17} />} title={snap.disks[0] ? `Disk — ${snap.disks[0].mount}` : "Disk"}
                percent={snap.disks[0]?.percent ?? 0}
                rows={snap.disks.slice(0, 3).map((d) => [d.mount, `${fileSizeStr(d.usedBytes)} / ${fileSizeStr(d.totalBytes)}`] as [string, string])}
              />
              <div className="donut-card">
                <div className="row"><Wifi size={17} /><strong>Network</strong></div>
                <div className="kv"><span className="k">Download</span><span className="v">{fileSizeStr(snap.net.rxBps)}/s</span></div>
                <div className="kv"><span className="k">Upload</span><span className="v">{fileSizeStr(snap.net.txBps)}/s</span></div>
                <Sparkline data={history.rx} color="#22d3ee" />
                <Sparkline data={history.tx} color="#a855f7" />
                <div className="kv"><span className="k">Total RX / TX</span><span className="v">{fileSizeStr(snap.net.totalRxBytes)} / {fileSizeStr(snap.net.totalTxBytes)}</span></div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <div className="section-title">System</div>
              <div className="row-wrap">
                <SysChip icon={<Clock size={13} />} k="Uptime" v={uptimeStr(snap.system.uptimeSec)} />
                <SysChip k="OS" v={`${snap.system.os} ${snap.system.osVersion}`.trim()} />
                <SysChip k="Kernel" v={snap.system.kernel} />
                <SysChip k="Arch" v={snap.system.arch} />
                <SysChip k="CPU" v={snap.system.cpuModel.slice(0, 42)} />
              </div>
            </div>

            <SudoPanel profileId={profileId} />

            <div className="card">
              <div className="section-title">Power</div>
              <div className="row">
                <button className="btn danger" onClick={() => setConfirmPower("reboot")}><Power size={15} /> Reboot server…</button>
                <button className="btn danger" onClick={() => setConfirmPower("shutdown")}>Shut down…</button>
                <span className="faint">Requires sudo — both operations ask for confirmation.</span>
              </div>
            </div>
          </>
        )}
      </div>

      {confirmPower && (
        <PowerConfirm action={confirmPower} profileId={profileId} onClose={() => setConfirmPower(null)} />
      )}
    </div>
  );
}

function PowerConfirm({ action, onClose, profileId }: {
  action: "reboot" | "shutdown";
  onClose(): void;
  profileId: string;
}) {
  const { toast, disconnect } = useApp();
  const [busyLocal, setBusyLocal] = useState(false);

  const run = async () => {
    setBusyLocal(true);
    try {
      const r = await call(window.vpsm.systemPower(profileId, action === "reboot" ? "reboot" : "poweroff"));
      toast({ kind: "success", title: action === "reboot" ? "Reboot command sent" : "Shutdown command sent", detail: r.output?.slice(0, 140) });
      setTimeout(() => void disconnect(profileId), 2500);
      onClose();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: e.sErr?.message ?? "Failed", detail: e.sErr?.code === "EACCES_ROOT" ? "Unlock sudo in the panel above first." : e.sErr?.detail });
      setBusyLocal(false);
    }
  };

  return (
    <Modal title={action === "reboot" ? "Reboot the server?" : "Shut down the server?"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busyLocal}>Cancel</button>
          <button className="btn danger" onClick={() => void run()} disabled={busyLocal}>
            {busyLocal ? <span className="spinner" /> : null}
            {action === "reboot" ? "Yes, reboot now" : "Yes, shut down now"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        {action === "reboot"
          ? "The server will go down and come back. Active SSH sessions (including this app's) will be dropped."
          : "The server will power off. You will need out-of-band access (provider console) to start it again."}
      </p>
      <div className="sudo-banner">This runs <span className="mono">systemctl {action === "reboot" ? "reboot" : "poweroff"}</span> with sudo.</div>
    </Modal>
  );
}

/* ---------------- chart components ---------------- */

function DonutCard({ icon, title, percent, rows, spark, sparkColor }: {
  icon: React.ReactNode;
  title: string;
  percent: number;
  rows: Array<[string, string]>;
  spark?: number[];
  sparkColor?: string;
}) {
  const p = Math.max(0, Math.min(100, percent));
  const R = 34;
  const C = 2 * Math.PI * R;
  const color = p > 85 ? "var(--red)" : p > 65 ? "var(--yellow)" : "var(--accent)";
  return (
    <div className="donut-card">
      <div className="row"><span style={{ color: "var(--text-dim)", display: "flex" }}>{icon}</span><strong>{title}</strong><div className="spacer" /><span className="faint">{p.toFixed(0)}%</span></div>
      <div className="donut-row">
        <svg width="88" height="88" viewBox="0 0 88 88" role="img" aria-label={`${title} ${p.toFixed(0)}%`}>
          <circle cx="44" cy="44" r={R} fill="none" stroke="var(--bg-3)" strokeWidth="9" />
          <circle
            cx="44" cy="44" r={R} fill="none"
            stroke={color} strokeWidth="9" strokeLinecap="round"
            strokeDasharray={`${(p / 100) * C} ${C}`}
            transform="rotate(-90 44 44)"
            style={{ transition: "stroke-dasharray 0.5s ease" }}
          />
          <text x="44" y="49" textAnchor="middle" fill="var(--text)" fontSize="16" fontWeight="700">{p.toFixed(0)}%</text>
        </svg>
        <div className="grow">
          {rows.map(([k, v]) => (
            <div key={k} className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>
          ))}
        </div>
      </div>
      {spark && spark.length > 1 && <Sparkline data={spark} color={sparkColor ?? color} />}
    </div>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div style={{ height: 8 }} />;
  const W = 220;
  const H = 40;
  const max = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 4) - 2).toFixed(1)}`).join(" ");
  const isRate = max > 1024 * 100;
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: 40 }} role="img" aria-label="history chart">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" />
      <polyline points={`0,${H} ${points} ${W},${H}`} fill={color} opacity="0.12" stroke="none" />
      {isRate && <text x="4" y="12" fontSize="9" fill="var(--text-faint)">{fileSizeStr(max)}/s</text>}
    </svg>
  );
}

function SysChip({ k, v, icon }: { k: string; v: string; icon?: React.ReactNode }) {
  if (!v) return null;
  return (
    <span className="row" style={{ gap: 6, background: "var(--bg-2)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "5px 10px", fontSize: 12.5 }}>
      {icon}
      <span className="muted">{k}:</span>
      <span className="mono" style={{ fontSize: 11.5 }}>{v}</span>
    </span>
  );
}

function uptimeStr(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
