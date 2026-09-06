import { useState } from "react";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { Lock, Eye, EyeOff } from "./icons";

/** Sudo unlock panel: verifies once, keeps the password in main-process memory
 *  only (never persisted, never logged). Elevated operations use it via stdin. */
export function SudoPanel({ profileId }: { profileId: string }) {
  const { sudoOk, setSudoOk, toast } = useApp();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  if (sudoOk[profileId]) {
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Elevated privileges</div>
        <div className="row">
          <span style={{ color: "var(--green)" }}>● sudo unlocked</span>
          <span className="faint">Privileged operations (service control, chown, power) will use it.</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => { void call(window.vpsm.forgetSudo(profileId)); setSudoOk(profileId, false); }}>Forget</button>
        </div>
      </div>
    );
  }

  const verify = async () => {
    if (!password) return;
    setBusy(true);
    try {
      const r = await call(window.vpsm.verifySudo(profileId, password));
      if (r.ok) {
        setSudoOk(profileId, true);
        setPassword("");
        toast({ kind: "success", title: "sudo unlocked for this session" });
      } else {
        toast({ kind: "error", title: r.error?.message ?? "sudo verification failed", detail: r.error?.detail });
      }
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: e.sErr?.message ?? "sudo failed", detail: e.sErr?.detail });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="section-title">Elevated privileges (sudo)</div>
      <div className="row">
        <Lock size={16} />
        <span className="muted" style={{ fontSize: 13 }}>
          Unlock once to allow service restarts, chown and power actions. The password is kept in app memory only — never saved, never logged.
        </span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          className="input" style={{ maxWidth: 260 }} type={show ? "text" : "password"}
          placeholder="your sudo password" value={password} disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void verify(); }}
        />
        <button className="icon-btn" onClick={() => setShow((v) => !v)} aria-label="Toggle visibility">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button className="btn primary" onClick={() => void verify()} disabled={busy || !password}>
          {busy ? <span className="spinner" /> : null} Unlock sudo
        </button>
      </div>
    </div>
  );
}
