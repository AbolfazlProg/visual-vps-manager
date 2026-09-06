import { useEffect, useState } from "react";
import { useApp } from "../store";
import { call } from "../ipc";
import { ServerIcon } from "../components/icons";

export function SettingsPage() {
  const { theme, setTheme, navigate } = useApp();
  const [info, setInfo] = useState<{ version: string; platform: string; secureStorage: boolean; userDataDir: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await call(window.vpsm.appInfo()));
      } catch { /* noop */ }
    })();
  }, []);

  return (
    <div className="page">
      <div className="page-scroll" style={{ maxWidth: 760 }}>
        <h1 className="page-title" style={{ marginBottom: 12 }}>Settings</h1>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="section-title">Appearance</div>
          <div className="row">
            <button className={`btn ${theme === "dark" ? "primary" : ""}`} onClick={() => setTheme("dark")}>Dark</button>
            <button className={`btn ${theme === "light" ? "primary" : ""}`} onClick={() => setTheme("light")}>Light</button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="section-title">Security</div>
          <div className="kv"><span className="k">Credential storage</span><span className="v">{info?.secureStorage ? "OS secure store (DPAPI/Keychain/libsecret) ✔" : "⚠ OS secure store unavailable — saving credentials is disabled"}</span></div>
          <div className="kv"><span className="k">SSH host keys</span><span className="v">Pinned per server (TOFU), change → warning dialog</span></div>
          <div className="kv"><span className="k">sudo password</span><span className="v">Memory-only, per session, never logged</span></div>
          <div className="kv"><span className="k">Data folder</span><span className="v">{info?.userDataDir ?? "—"}</span></div>
        </div>

        <div className="card">
          <div className="section-title">About</div>
          <div className="row">
            <ServerIcon size={26} />
            <div>
              <strong>Visual VPS Manager</strong>
              <div className="faint">version {info?.version ?? "—"} · platform {info?.platform ?? "—"}</div>
            </div>
            <div className="spacer" />
            <button className="btn" onClick={() => navigate({ view: "servers" })}>Go to servers</button>
          </div>
        </div>
      </div>
    </div>
  );
}
