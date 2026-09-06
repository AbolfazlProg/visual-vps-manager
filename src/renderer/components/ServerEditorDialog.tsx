import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { KeyIcon, Eye, EyeOff } from "./icons";
import type { SerializedVpsmError } from "../../shared/errors";

interface Props {
  profileId?: string;
  onClose(): void;
}

export function ServerEditorDialog({ profileId, onClose }: Props) {
  const { profiles, saveProfile, connect, navigate, toast } = useApp();
  const editing = profileId ? profiles.find((p) => p.id === profileId) : undefined;

  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "root");
  const [authMethod, setAuthMethod] = useState<"password" | "key">(editing?.authMethod ?? "password");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState<{ kind: "idle" | "running" | "ok" | "fail"; msg?: string; fingerprint?: string }>({ kind: "idle" });

  useEffect(() => {
    if (editing) setSaved(Boolean(editing.hasCredential));
  }, [editing]);

  const submit = async (): Promise<string | null> => {
    if (!host.trim()) return "Host / IP is required";
    if (!/^\d{1,5}$/.test(port.trim()) || +port < 1 || +port > 65535) return "Port must be 1–65535";
    if (!username.trim()) return "Username is required";
    if (!saved && !secret.trim()) {
      return authMethod === "password" ? "Password is required" : "Private key is required";
    }
    setBusy(true);
    try {
      const profile = await saveProfile({
        id: profileId,
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        authMethod,
        secret: secret.trim() ? secret : undefined,
        passphrase: passphrase ? passphrase : undefined
      });
      setSecret("");
      setPassphrase("");
      setSaved(true);
      toast({ kind: "success", title: editing ? "Server updated" : "Server saved", detail: "Credentials are stored encrypted (OS key store)." });
      return profile.id;
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: e.sErr?.message ?? "Save failed", detail: e.sErr?.detail });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveAndConnect = async () => {
    const id = await submit();
    if (!id) return;
    const ok = await connect(id);
    if (ok) navigate({ view: "files", profileId: id });
  };

  const testConn = async () => {
    const id = await submit();
    if (!id) return;
    setTestState({ kind: "running" });
    try {
      await call(window.vpsm.connect(id, {}));
      await call(window.vpsm.disconnect(id));
      setTestState({ kind: "ok", msg: "Connection successful — authentication and host key verified." });
    } catch (err) {
      const e = err as VpsmApiError;
      setTestState({ kind: "fail", msg: friendlyTestError(e.sErr) });
    }
  };

  return (
    <Modal
      title={editing ? "Edit server" : "Add server"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={testConn} disabled={busy || !host.trim()}>
            {testState.kind === "running" ? <span className="spinner" /> : null}
            Test connection
          </button>
          <button className="btn" onClick={() => void submit()} disabled={busy}>Save</button>
          <button className="btn primary" onClick={() => void saveAndConnect()} disabled={busy || !host.trim()}>
            Save &amp; Connect
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10 }}>
        <div className="field grow">
          <label htmlFor="srv-name">Server name</label>
          <input id="srv-name" className="input" placeholder="My production server" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ width: 130 }}>
          <label htmlFor="srv-port">Port</label>
          <input id="srv-port" className="input mono" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      <div className="field">
        <label htmlFor="srv-host">IP address / hostname</label>
        <input id="srv-host" className="input mono" placeholder="203.0.113.10" value={host} onChange={(e) => setHost(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="srv-user">Username</label>
        <input id="srv-user" className="input mono" placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>

      <div className="field">
        <label>Authentication</label>
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn ${authMethod === "password" ? "primary" : ""}`} onClick={() => setAuthMethod("password")}>Password</button>
          <button className={`btn ${authMethod === "key" ? "primary" : ""}`} onClick={() => setAuthMethod("key")}>
            <KeyIcon size={15} /> SSH private key
          </button>
        </div>
      </div>

      {authMethod === "password" ? (
        <div className="field">
          <label htmlFor="srv-pass">{saved ? "New password (leave empty to keep stored)" : "Password"}</label>
          <div style={{ position: "relative" }}>
            <input
              id="srv-pass" className="input mono" type={showSecret ? "text" : "password"}
              placeholder={saved ? "••••••••" : "server password"}
              value={secret} onChange={(e) => setSecret(e.target.value)}
              style={{ paddingRight: 38 }}
            />
            <button className="icon-btn" style={{ position: "absolute", right: 3, top: 3 }} onClick={() => setShowSecret((v) => !v)} aria-label="Toggle visibility">
              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="srv-key">{saved ? "New private key (leave empty to keep stored)" : "Private key (OpenSSH format)"}</label>
            <textarea
              id="srv-key" className="input mono" rows={5} spellCheck={false}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
              value={secret} onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="srv-keypass">Key passphrase (optional)</label>
            <input id="srv-keypass" className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={saved && editing?.hasPassphrase ? "••••••••" : ""} />
          </div>
        </>
      )}

      {testState.kind !== "idle" && testState.kind !== "running" && (
        <div className={testState.kind === "ok" ? "toast success" : "toast error"} style={{ position: "static", animation: "none" }}>
          <div>
            <div className="title">{testState.kind === "ok" ? "Success" : "Failed"}</div>
            <div className="detail">{testState.msg}</div>
          </div>
        </div>
      )}
      {saved && (
        <div className="faint">
          ✔ Credentials stored — encrypted with the operating system key store. They are never written to disk in plain text.
        </div>
      )}
    </Modal>
  );
}

function friendlyTestError(e?: SerializedVpsmError): string {
  switch (e?.code) {
    case "EAUTH": return "Authentication failed. Check username/password/key. For password auth over servers that only allow keyboard-interactive, this app tries both automatically.";
    case "ECONN": return `Could not reach the server. ${e.detail ?? ""}`;
    case "EHOSTKEY": return "Host key must be verified first. Close this dialog and connect once — you'll be asked to verify the fingerprint.";
    case "ETIMEDOUT": return "Connection timed out. Check the IP, port, and firewall.";
    default: return e?.message ?? "Unknown error";
  }
}
