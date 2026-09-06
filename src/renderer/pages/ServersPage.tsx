import { useApp, statusOf } from "../store";
import { ServerIcon, TerminalIcon, GaugeIcon, FolderTreeIcon, TrashIcon2, ActivityIcon, KeyIcon, SettingsIcon, PlusIcon, dateStr, CopyIcon, EditIcon, MoreIcon } from "../components/icons";
import { useEffect, useState } from "react";
import { ServerEditorDialog } from "../components/ServerEditorDialog";
import { call } from "../ipc";

const STATUS_LABEL: Record<string, string> = {
  offline: "Offline",
  connecting: "Connecting…",
  authenticating: "Authenticating…",
  connected: "Connected",
  error: "Error",
  hostkey: "Host key"
};

export function ServersPage() {
  const { profiles, states, connect, disconnect, deleteProfile, duplicateProfile, navigate, toast, setSudoOk } = useApp();
  void states; void toast;
  const [editorFor, setEditorFor] = useState<{ id?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 14 }}>
          <div>
            <h1 className="page-title">My Servers</h1>
            <div className="faint">Connect to your Linux VPS servers over SSH</div>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setEditorFor({})}>
            <PlusIcon size={16} /> Add Server
          </button>
          <button className="btn ghost" onClick={() => navigate({ view: "settings" })} aria-label="Settings">
            <SettingsIcon size={17} />
          </button>
        </div>

        {profiles.length === 0 && (
          <div className="center-note" style={{ minHeight: 380 }}>
            <ServerIcon size={44} />
            <div style={{ fontSize: 15, color: "var(--text-dim)" }}>No servers yet</div>
            <div className="faint" style={{ maxWidth: 380 }}>
              Add your first VPS — you'll need the IP address, SSH port (default 22), username and a password or private key.
            </div>
            <button className="btn primary" onClick={() => setEditorFor({})}>
              <PlusIcon size={16} /> Add your first server
            </button>
          </div>
        )}

        <div className="col" style={{ gap: 10 }}>
          {profiles.map((p) => {
            const st = states[p.id];
            const status = st?.status ?? "offline";
            return (
              <div key={p.id} className="server-card" onClick={() => void openOrConnect(p.id)}>
                <div className="avatar" style={{ background: p.color }}>
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 14.5 }}>{p.name}</strong>
                    <StatusPill status={status} />
                  </div>
                  <div className="faint mono" style={{ marginTop: 2 }}>
                    {p.username}@{p.host}:{p.port} · {p.authMethod === "key" ? <KeyIconInline /> : "password"}
                  </div>
                  {st?.error && <div className="faint" style={{ color: "var(--red)" }}>{st.error.message}</div>}
                </div>
                <div className="faint" style={{ textAlign: "right", flexShrink: 0 }}>
                  {p.lastConnectedAt ? `Last: ${dateStr(p.lastConnectedAt)}` : "Never connected"}
                </div>
                <div className="row" style={{ gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                  {status === "connected" ? (
                    <>
                      <button className="icon-btn" title="File manager" onClick={() => navigate({ view: "files", profileId: p.id })}><FolderTreeIcon size={17} /></button>
                      <button className="icon-btn" title="Monitor" onClick={() => navigate({ view: "dashboard", profileId: p.id })}><GaugeIcon size={17} /></button>
                      <button className="icon-btn" title="Terminal" onClick={() => navigate({ view: "terminal", profileId: p.id })}><TerminalIcon size={17} /></button>
                      <button className="btn small" onClick={() => void doDisconnect(p.id)}>Disconnect</button>
                    </>
                  ) : (
                    <button className="btn small primary" onClick={() => void openOrConnect(p.id)} disabled={status === "connecting"}>
                      {status === "connecting" ? <span className="spinner" /> : "Connect"}
                    </button>
                  )}
                  <button className="icon-btn" title="More" onClick={(e) => setMenuFor({ id: p.id, x: e.clientX, y: e.clientY })}>
                    <MoreIcon size={17} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editorFor && <ServerEditorDialog profileId={editorFor.id} onClose={() => setEditorFor(null)} />}

      {menuFor && (
        <div className="ctx-menu" style={{ left: menuFor.x, top: menuFor.y }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { setEditorFor({ id: menuFor.id }); setMenuFor(null); }}><EditIcon size={15} /> Edit</button>
          <button className="ctx-item" onClick={() => { void duplicateProfile(menuFor.id); setMenuFor(null); }}><CopyIcon size={15} /> Duplicate</button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { navigate({ view: "trash", profileId: menuFor.id }); setMenuFor(null); }}><TrashIcon2 size={15} /> Trash</button>
          <button className="ctx-item" onClick={() => { navigate({ view: "activity", profileId: menuFor.id }); setMenuFor(null); }}><ActivityIcon size={15} /> Activity log</button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirmDelete(menuFor.id); setMenuFor(null); }}>Delete</button>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
          <div className="modal">
            <div className="modal-head"><h2>Delete server profile?</h2></div>
            <div className="modal-body">
              <p style={{ margin: 0 }}>
                This removes <strong>{profiles.find((p) => p.id === confirmDelete)?.name}</strong> and its stored credentials from this device.
                Nothing on the server itself is affected.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={() => { void deleteProfile(confirmDelete); setConfirmDelete(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  async function openOrConnect(id: string) {
    const status = statusOf(useApp.getState(), id);
    if (status === "connected") {
      navigate({ view: "files", profileId: id });
      return;
    }
    const ok = await connect(id);
    if (ok) {
      // opportunistically probe passwordless sudo
      void probeSudo(id);
      navigate({ view: "files", profileId: id });
    }
  }

  async function doDisconnect(id: string) {
    await disconnect(id);
    setSudoOk(id, false);
  }

  async function probeSudo(id: string) {
    try {
      const r = await call(window.vpsm.verifySudo(id, ""));
      void r;
    } catch {
      // needs password — normal; sudoOk stays false
    }
  }
}

function KeyIconInline() {
  return <span style={{ verticalAlign: "-2px", display: "inline-flex" }}><KeyIcon size={12} /></span>;
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === "connected" ? "connected" : status === "connecting" || status === "authenticating" ? "connecting" : status === "error" ? "error" : status === "hostkey" ? "hostkey" : "offline";
  return (
    <span className={`status-pill ${cls}`}>
      <span className="dot" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
