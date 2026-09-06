import { useEffect, useState } from "react";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { RefreshCw } from "../components/icons";
import { dateStr } from "../components/icons";
import type { ActivityEntry } from "../../shared/protocol";

const KIND_COLOR: Record<string, string> = {
  fs: "var(--accent)",
  service: "var(--purple)",
  process: "var(--orange)",
  session: "var(--green)",
  transfer: "var(--cyan)",
  security: "var(--red)",
  system: "var(--yellow)"
};

export function ActivityPage({ profileId }: { profileId: string }) {
  const { toast } = useApp();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries(await call(window.vpsm.listActivity(profileId)));
      } catch (err) {
        const e = err as VpsmApiError;
        toast({ kind: "error", title: "Cannot load activity", detail: e.sErr?.message });
        setEntries([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 12 }}>
          <h1 className="page-title">Activity log</h1>
          <div className="spacer" />
          <button className="btn small" onClick={() => void (async () => { try { setEntries(await call(window.vpsm.listActivity(profileId))); } catch { /* noop */ } })()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        {!entries ? (
          <div className="center-note"><span className="spinner" /></div>
        ) : entries.length === 0 ? (
          <div className="center-note"><div>No activity recorded yet.</div></div>
        ) : (
          <div className="card">
            {entries.map((e, i) => (
              <div key={i} className="activity-row">
                <div className="activity-time">{dateStr(e.at).slice(11)}</div>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="dot" style={{ width: 7, height: 7, borderRadius: "50%", background: KIND_COLOR[e.kind] ?? "var(--text-faint)", display: "inline-block" }} />
                    <span style={{ fontSize: 13.5 }}>{e.summary}</span>
                  </div>
                  {e.detail && <div className="activity-detail">{e.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="faint" style={{ marginTop: 8 }}>
          Secrets (passwords, keys, sudo password) are never written to this log.
        </div>
      </div>
    </div>
  );
}
