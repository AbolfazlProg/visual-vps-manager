import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { Square, Play, Search, X } from "../components/icons";
import type { LogLine } from "../../shared/protocol";

export function LogsPage({ profileId }: { profileId: string }) {
  const { states, toast } = useApp();
  const connected = states[profileId]?.status === "connected";
  const [mode, setMode] = useState<"journal" | "file">("journal");
  const [unit, setUnit] = useState("");
  const [filePath, setFilePath] = useState("");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<LogLine[]>([]);
  const viewRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    return () => {
      if (streamId) void call(window.vpsm.stopLogStream(streamId)).catch(() => {});
    };
  }, [streamId]);

  useEffect(() => {
    const un = window.vpsm.onEvent((ev) => {
      const e = ev as { type: string; streamId?: string; line?: LogLine };
      if (e.type === "log-line" && e.streamId === streamId && e.line) {
        if (pausedRef.current) return;
        bufferRef.current.push(e.line);
        if (bufferRef.current.length > 5000) bufferRef.current.splice(0, 1000);
        setLines([...bufferRef.current]);
      }
      if (e.type === "log-closed" && e.streamId === streamId) {
        setStreamId(null);
        toast({ kind: "info", title: "Log stream ended", detail: "The remote follow process closed." });
      }
    });
    return un;
  }, [streamId, toast]);

  const start = async () => {
    setError(null);
    try {
      if (mode === "journal" && !unit.trim()) {
        setError("Enter a systemd unit name, e.g. nginx.service");
        return;
      }
      if (mode === "file" && !filePath.trim()) {
        setError("Enter a log file path, e.g. /var/log/nginx/error.log");
        return;
      }
      const id = await call(window.vpsm.startLogStream(profileId, {
        mode,
        unit: mode === "journal" ? unit.trim() : undefined,
        filePath: mode === "file" ? filePath.trim() : undefined
      }));
      bufferRef.current = [];
      setLines([]);
      setStreamId(id);
    } catch (err) {
      const e = err as VpsmApiError;
      setError(e.sErr?.message ?? "failed to start log stream");
    }
  };

  const stop = () => {
    if (streamId) void call(window.vpsm.stopLogStream(streamId));
    setStreamId(null);
  };

  useEffect(() => {
    const el = viewRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  if (!connected) return <div className="center-note"><div>Not connected.</div></div>;

  const visible = filter ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase())) : lines;
  const downloadText = () => {
    const text = lines.map((l) => `${new Date(l.t).toISOString()} ${l.source}: ${l.line}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${mode === "journal" ? unit || "journal" : filePath.split("/").pop() || "log"}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page">
      <div className="row-wrap" style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-soft)" }}>
        <select className="input" style={{ width: 130 }} value={mode} onChange={(e) => setMode(e.target.value as "journal" | "file")} disabled={!!streamId}>
          <option value="journal">systemd unit</option>
          <option value="file">Log file</option>
        </select>
        {mode === "journal" ? (
          <input className="input mono" style={{ maxWidth: 220 }} placeholder="nginx.service" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!!streamId} />
        ) : (
          <input className="input mono" style={{ maxWidth: 300 }} placeholder="/var/log/nginx/error.log" value={filePath} onChange={(e) => setFilePath(e.target.value)} disabled={!!streamId} />
        )}
        {!streamId ? (
          <button className="btn primary small" onClick={() => void start()}><Play size={14} /> Start live stream</button>
        ) : (
          <button className="btn small" onClick={stop}><Square size={14} /> Stop</button>
        )}
        <button className="btn small" onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
        <button className="btn small ghost" onClick={() => { bufferRef.current = []; setLines([]); }}>Clear view</button>
        <button className="btn small ghost" onClick={downloadText} disabled={lines.length === 0}>Download</button>
        <div className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          <Search size={15} />
          <input className="input" style={{ width: 180, minHeight: 30 }} placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && <button className="icon-btn" onClick={() => setFilter("")} aria-label="Clear filter"><X size={13} /></button>}
        </div>
      </div>

      {error && <div style={{ color: "var(--red)", padding: "8px 12px" }}>⚠ {error}</div>}

      <div className="log-view" ref={viewRef}>
        {visible.map((l, i) => {
          const isErr = /error|fatal|critical|failed/i.test(l.line) && !/error_.?log/i.test(l.line);
          const isWarn = /warn(ing)?|deprecated/i.test(l.line);
          return (
            <div key={i} className={`log-line${isErr ? " log-err" : isWarn ? " log-warn" : ""}`}>
              {l.line}
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="faint" style={{ padding: 20 }}>
            {streamId ? "Waiting for output…" : "Start a live stream — journalctl -f for a unit, or tail -F for a file."}
          </div>
        )}
      </div>
      <div className="editor-status">
        <span>{streamId ? "● live" : "○ stopped"}</span>
        <span>{visible.length} lines{filter ? ` (filtered from ${lines.length})` : ""}</span>
        {paused && <span style={{ color: "var(--yellow)" }}>paused — incoming lines are dropped while paused</span>}
      </div>
    </div>
  );
}
