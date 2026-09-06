import { useEffect } from "react";
import { useApp } from "../store";
import { ShieldIcon } from "./icons";

/**
 * Host-key safety dialog (TOFU + change warning).
 * Shown when a connect attempt ends in EHOSTKEY. The user must explicitly
 * accept the fingerprint before the registry pins it and retries.
 */
export function HostKeyDialog() {
  const { states, connect, disconnect, navigate } = useApp();
  const pending = Object.values(states).find((s) => s.status === "hostkey");

  const accept = async () => {
    if (!pending) return;
    const id = pending.id;
    const ok = await connect(id, true);
    if (ok) navigate({ view: "files", profileId: id });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending) void disconnect(pending.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, disconnect]);

  if (!pending) return null;
  const hk = pending.hostKey;
  const wasKnown = pending.message === "SSH host key changed";

  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="SSH host key verification" style={{ zIndex: 900 }}>
      <div className="modal">
        <div className="modal-head">
          <ShieldIcon size={20} />
          <h2>{wasKnown ? "SSH host key changed" : "Verify server identity"}</h2>
        </div>
        <div className="modal-body">
          {wasKnown ? (
            <div className="sudo-banner" style={{ color: "#f87171", borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.09)" }}>
              WARNING: The SSH host key for this server has changed. This can indicate a man-in-the-middle attack,
              or that the server was reinstalled / its keys regenerated.
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              This is the first time you connect to this server, or its key was not pinned yet.
              Verify the fingerprint out-of-band (e.g. run <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> on the server) before trusting it.
            </p>
          )}
          <div className="card" style={{ padding: 10 }}>
            <div className="kv"><span className="k">Fingerprint (SHA256)</span><span className="v">{hk?.fingerprint ?? "—"}</span></div>
            <div className="kv"><span className="k">Key type</span><span className="v">{hk?.keyType ?? "ssh"}</span></div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => void disconnect(pending.id)}>Reject &amp; Disconnect</button>
          <button className="btn primary" onClick={() => void accept()}>
            Accept &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
