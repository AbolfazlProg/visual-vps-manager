import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { Save, X } from "./icons";
import { basenameOf } from "../../shared/paths";

export function EditorOverlay({ profileId, path, onClose, onSaved }: {
  profileId: string;
  path: string;
  onClose(): void;
  onSaved(): void;
}) {
  const { toast } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<{ size: number; mtimeMs: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const originalRef = useRef<string>("");
  const mtimeRef = useRef<number>(0);

  const name = basenameOf(path);

  /* load */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call(window.vpsm.readFile(profileId, path));
        if (cancelled) return;
        originalRef.current = res.content;
        mtimeRef.current = res.mtimeMs;
        setInfo({ size: res.size, mtimeMs: res.mtimeMs, truncated: res.truncated });
        setError(null);
        mountEditor(res.content, res.truncated);
      } catch (err) {
        const e = err as VpsmApiError;
        setError(e.sErr ? `${e.sErr.message}${e.sErr.detail ? " — " + e.sErr.detail : ""}` : String(err));
      }
    })();
    return () => { cancelled = true; viewRef.current?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, path]);

  const mountEditor = (content: string, truncated: boolean) => {
    if (!hostRef.current) return;
    viewRef.current?.destroy();
    const langComp = new Compartment();
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        langComp.of(languageFor(name)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setDirty(u.state.doc.toString() !== originalRef.current);
        }),
        truncated ? [] : []
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
  };

  const save = async () => {
    if (!viewRef.current) return;
    setSaving(true);
    try {
      await call(window.vpsm.runOperation(profileId, {
        kind: "writeFile",
        path,
        content: viewRef.current.state.doc.toString(),
        expectedMtime: mtimeRef.current || undefined
      }));
      originalRef.current = viewRef.current.state.doc.toString();
      // refresh mtime for future conflict detection
      try {
        const st = await call(window.vpsm.stat(profileId, path));
        mtimeRef.current = st.mtimeMs;
      } catch { /* ignore */ }
      setDirty(false);
      toast({ kind: "success", title: `Saved ${name}` });
      onSaved();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({
        kind: "error",
        title: e.sErr?.message ?? "Save failed",
        detail: e.sErr?.code === "EEXIST"
          ? "The file changed on the server while you were editing. Copy your changes, reload the file, and re-apply."
          : e.sErr?.detail
      });
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="modal-backdrop" style={{ padding: 0 }}>
      <div className="editor-shell" style={{ position: "absolute", inset: 0 }}>
        <div className="editor-bar">
          <strong style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{path}</strong>
          {dirty && <span className="badge" style={{ color: "var(--yellow)" }}>● unsaved</span>}
          {info?.truncated && <span className="badge" style={{ color: "var(--orange)" }}>truncated preview (file too large)</span>}
          <div className="spacer" />
          <button className="btn small" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <span className="spinner" /> : <Save size={14} />} Save
          </button>
          <button className="icon-btn" onClick={requestClose} aria-label="Close editor"><X size={17} /></button>
        </div>
        {error ? (
          <div className="center-note">
            <div style={{ color: "var(--red)" }}>⚠ {error}</div>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="editor-host" ref={hostRef} />
        )}
        <div className="editor-status">
          <span>{name.split(".").pop()?.toUpperCase() ?? "TXT"}</span>
          <span>{info ? `${(info.size / 1024).toFixed(1)} KB` : ""}</span>
          <span>Ctrl+S to save</span>
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => { if (viewRef.current) { viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: originalRef.current } }); } }}>Revert</button>
        </div>
      </div>

      {confirmClose && (
        <div className="modal-backdrop" style={{ zIndex: 600 }}>
          <div className="modal">
            <div className="modal-head"><h2>Unsaved changes</h2></div>
            <div className="modal-body">
              <p style={{ margin: 0 }}>Save changes to <span className="mono">{path}</span> before closing?</p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => { setConfirmClose(false); onClose(); }}>Discard</button>
              <button className="btn primary" onClick={() => { setConfirmClose(false); void save().then(onClose); }}>Save &amp; close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function languageFor(filename: string) {
  const lower = filename.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "js": case "mjs": case "cjs": case "jsx": return javascript();
    case "ts": case "tsx": case "mts": return javascript({ typescript: true, jsx: ext.endsWith("x") });
    case "py": return python();
    case "php": return php();
    case "html": case "htm": return html();
    case "css": case "scss": case "less": return css();
    case "json": return json();
    case "md": case "markdown": return markdown();
    case "sql": return sql();
    case "yml": case "yaml": return StreamLanguage.define(yaml);
    case "sh": case "bash": case "zsh": case "env": return StreamLanguage.define(shell);
    case "xml": case "svg": case "conf": case "ini": case "service": return StreamLanguage.define(xml);
    case "toml": case "ini2": return StreamLanguage.define(yaml);
    default: return [];
  }
}
