import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { PlusIcon, X, TrashIcon2 } from "./icons";

interface TermTab {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  disposed: boolean;
}

export function TerminalPage({ profileId }: { profileId: string }) {
  const { profiles, states } = useApp();
  const profile = profiles.find((p) => p.id === profileId);
  const connected = states[profileId]?.status === "connected";

  const hostRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<TermTab[]>([]);
  const [tabs, setTabs] = useState<Array<{ id: string; title: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (connected && tabs.length === 0) void openTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  /* fit on resize */
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t) {
        try { t.fit.fit(); } catch { /* noop */ }
      }
    });
    if (hostRef.current) ro.observe(hostRef.current);
    return () => ro.disconnect();
  }, [activeId]);

  useEffect(() => {
    return () => {
      for (const t of tabsRef.current) {
        t.disposed = true;
        try { t.term.dispose(); } catch { /* noop */ }
        void call(window.vpsm.closeTerminal(t.id)).catch(() => {});
      }
      tabsRef.current = [];
    };
  }, []);

  const openTab = async () => {
    if (!hostRef.current) return;
    try {
      const term = new Terminal({
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        theme: {
          background: "#0d1117",
          foreground: "#c9d1d9",
          cursor: "#58a6ff",
          selectionBackground: "rgba(88,166,255,0.3)",
          black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
          blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
          brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
          brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd", brightWhite: "#f0f6fc"
        },
        scrollback: 8000
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon());

      const termId = await call(window.vpsm.openTerminal(profileId, { cols: term.cols, rows: term.rows }));
      term.onData((d) => void call(window.vpsm.terminalInput(termId, d)).catch(() => {}));
      term.onResize(({ cols, rows }) => void call(window.vpsm.resizeTerminal(termId, { cols, rows })));
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "c") {
          document.execCommand("copy");
          return false;
        }
        if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "v") {
          void navigator.clipboard.readText().then((t) => term.write(t));
          return false;
        }
        return true;
      });

      const onEventUn = window.vpsm.onEvent((ev) => {
        const e = ev as { type: string; termId?: string; data?: string };
        if (e.type === "terminal-output" && e.termId === termId && e.data) {
          term.write(e.data);
        }
        if (e.type === "terminal-exit" && e.termId === termId) {
          term.write("\r\n\x1b[90m[session closed — this tab can be closed]\x1b[0m\r\n");
        }
      });

      term.open(hostRef.current);
      try { fit.fit(); } catch { /* noop */ }
      term.focus();

      const tab: TermTab = { id: termId, title: `shell ${tabsRef.current.length + 1}`, term, fit, search, disposed: false };
      tab.term._vpsmUn = onEventUn;
      tabsRef.current.push(tab);
      setTabs(tabsRef.current.map((t) => ({ id: t.id, title: t.title })));
      setActiveId(termId);
    } catch (err) {
      const e = err as VpsmApiError;
      useApp.getState().toast({ kind: "error", title: "Cannot open terminal", detail: e.sErr?.message });
    }
  };

  const showTab = (id: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    for (const other of tabsRef.current) {
      try { other.term.element?.style.setProperty("display", other.id === id ? "block" : "none"); } catch { /* noop */ }
    }
    setActiveId(id);
    try { t.fit.fit(); t.term.focus(); } catch { /* noop */ }
  };

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const t = tabsRef.current[idx];
    t.disposed = true;
    t.term._vpsmUn?.();
    try { t.term.dispose(); } catch { /* noop */ }
    void call(window.vpsm.closeTerminal(id)).catch(() => {});
    tabsRef.current.splice(idx, 1);
    setTabs(tabsRef.current.map((x) => ({ id: x.id, title: x.title })));
    if (activeId === id) {
      const next = tabsRef.current[Math.max(0, idx - 1)];
      if (next) showTab(next.id);
      else setActiveId(null);
    }
  };

  const clearActive = () => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    t?.term.clear();
    t?.term.write("\x1b[2J\x1b[H");
  };

  return (
    <div className="page">
      <div className="term-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`term-tab${t.id === activeId ? " active" : ""}`} onClick={() => showTab(t.id)}>
            <span>{t.title}</span>
            <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="Close tab">
              <X size={12} />
            </button>
          </div>
        ))}
        {connected && (
          <button className="btn small ghost" onClick={() => void openTab()}><PlusIcon size={14} /> New</button>
        )}
        <div className="spacer" />
        <button className="btn small ghost" onClick={clearActive} disabled={!activeId}>Clear</button>
      </div>

      {!connected ? (
        <div className="center-note">
          <div>Not connected. Connect to this server first.</div>
        </div>
      ) : (
        <div className="term-wrap">
          <div className="term-host" ref={hostRef} />
          {activeId === null && (
            <div className="center-note" style={{ position: "absolute", inset: 0 }}>
              <button className="btn primary" onClick={() => void openTab()}>Open shell session</button>
            </div>
          )}
        </div>
      )}
      <div className="editor-status">
        <span>{profile?.name} — {profile?.username}@{profile?.host}</span>
        <span>Ctrl+Shift+C / Ctrl+Shift+V copy-paste</span>
        <div className="spacer" />
        <span className="faint"><TrashIcon2 size={11} /> closing a tab ends the remote session</span>
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@xterm/xterm" {
  interface Terminal {
    _vpsmUn?: () => void;
  }
}
