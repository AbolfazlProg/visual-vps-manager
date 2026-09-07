import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, StreamLanguage } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { useApp } from "../store";
import { call, VpsmApiError } from "../ipc";
import { Save, X } from "./icons";
import { basenameOf } from "../../shared/paths";
import type { TextEncoding } from "../../shared/encoding";

const ENCODING_LABEL: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 (BOM)",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE"
};

/* ---- dark, professional theme (GitHub-dark inspired, matches the app) ---- */
const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#0d1117", color: "#c9d1d9", fontSize: "13.5px" },
    ".cm-scroller": { overflow: "auto", fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace', lineHeight: "1.55" },
    ".cm-content": { caretColor: "#58a6ff", paddingBottom: "24px" },
    ".cm-gutters": { backgroundColor: "#0d1117", color: "#484f58", border: "none", paddingRight: "6px" },
    ".cm-activeLine": { backgroundColor: "rgba(110,118,129,0.10)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(110,118,129,0.15)", color: "#c9d1d9" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(88,166,255,0.28) !important" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#58a6ff" },
    ".cm-selectionMatch": { backgroundColor: "rgba(63,185,80,0.25)" },
    ".cm-panels": { backgroundColor: "#161b22", color: "#c9d1d9", borderColor: "#30363d" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #30363d" },
    ".cm-searchMatch": { backgroundColor: "rgba(210,153,34,0.33)" },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(249,115,22,0.45)" },
    ".cm-tooltip": { backgroundColor: "#161b22", border: "1px solid #30363d", color: "#c9d1d9" },
    ".cm-foldPlaceholder": { backgroundColor: "#30363d", color: "#8b949e", border: "none" }
  },
  { dark: true }
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#ff7b72" },
  { tag: tags.moduleKeyword, color: "#ff7b72" },
  { tag: tags.controlKeyword, color: "#ff7b72" },
  { tag: tags.comment, color: "#8b949e", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#a5d6ff" },
  { tag: [tags.number, tags.bool, tags.null], color: "#79c0ff" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#d2a8ff" },
  { tag: tags.definition(tags.variableName), color: "#ffa657" },
  { tag: tags.typeName, color: "#ffa657" },
  { tag: tags.className, color: "#ffa657" },
  { tag: tags.propertyName, color: "#79c0ff" },
  { tag: tags.operator, color: "#ff7b72" },
  { tag: tags.tagName, color: "#7ee787" },
  { tag: tags.attributeName, color: "#79c0ff" },
  { tag: tags.link, color: "#a5d6ff", textDecoration: "underline" },
  { tag: tags.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.invalid, color: "#f85149" }
]);

function languageFor(filename: string) {
  const lower = filename.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "js": case "mjs": case "cjs": case "jsx": return javascript();
    case "ts": case "tsx": case "mts": case "cts": return javascript({ typescript: true, jsx: ext.endsWith("x") });
    case "py": case "pyw": case "pyi": return python();
    case "php": case "phtml": return php();
    case "html": case "htm": case "xhtml": case "vue": case "svelte": return html();
    case "css": case "scss": case "less": case "sass": return css();
    case "json": case "jsonc": case "json5": case "webmanifest": return json();
    case "md": case "markdown": case "mdown": return markdown();
    case "sql": return sql();
    case "yml": case "yaml": case "toml": return StreamLanguage.define(yaml);
    case "sh": case "bash": case "zsh": case "ksh": case "command": return StreamLanguage.define(shell);
    case "xml": case "svg": case "xsl": case "xslt": case "rss": case "atom": case "wsdl": case "service": case "socket": case "timer": case "plist": return StreamLanguage.define(xml);
    case "conf": case "ini": case "env": case "properties": case "cnf": return StreamLanguage.define(shell);
    default: return [];
  }
}

interface Props {
  profileId: string;
  path: string;
  onClose(): void;
  onSaved(): void;
}

export function EditorOverlay({ profileId, path, onClose, onSaved }: Props) {
  const { toast } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<{ size: number; truncated: boolean; encoding: TextEncoding; crlf: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const originalRef = useRef<string>("");
  const mtimeRef = useRef<number>(0);
  const truncatedRef = useRef(false);
  const encodingRef = useRef<TextEncoding>("utf8");
  const langComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const [wrapOn, setWrapOn] = useState(false);

  const name = basenameOf(path);

  /* ---------------- load ---------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call(window.vpsm.readFile(profileId, path));
        if (cancelled) return;
        originalRef.current = res.content;
        mtimeRef.current = res.mtimeMs;
        truncatedRef.current = res.truncated;
        encodingRef.current = (res.encoding ?? "utf8") as TextEncoding;
        setInfo({ size: res.size, truncated: res.truncated, encoding: (res.encoding ?? "utf8") as TextEncoding, crlf: res.content.includes("\r\n") });
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

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of("    "),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      editorTheme,
      syntaxHighlighting(highlight),
      langComp.current.of(languageFor(name)),
      wrapComp.current.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(u.state.doc.toString() !== originalRef.current);
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          setCursor({ line: line.number, col: head - line.from + 1 });
        }
      })
    ];
    // preserve CRLF line endings exactly as stored on the server
    if (content.includes("\r\n")) extensions.push(EditorState.lineSeparator.of("\r\n"));
    if (truncated) extensions.push(EditorState.readOnly.of(true));

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
  };

  /* ---------------- save ---------------- */
  const save = async () => {
    if (!viewRef.current) return;
    if (truncatedRef.current) {
      toast({ kind: "warn", title: "Read-only preview", detail: "This file is larger than the editor limit — download it to edit." });
      return;
    }
    setSaving(true);
    try {
      await call(window.vpsm.runOperation(profileId, {
        kind: "writeFile",
        path,
        content: viewRef.current.state.doc.toString(),
        expectedMtime: mtimeRef.current || undefined,
        encoding: encodingRef.current
      }));
      originalRef.current = viewRef.current.state.doc.toString();
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

  const toggleWrap = () => {
    const next = !wrapOn;
    setWrapOn(next);
    viewRef.current?.dispatch({
      effects: wrapComp.current.reconfigure(next ? EditorView.lineWrapping : [])
    });
  };

  const revert = () => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: originalRef.current }
    });
    setDirty(false);
  };

  return (
    <div className="editor-overlay">
      <div className="editor-shell">
        <div className="editor-bar">
          <strong style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{path}</strong>
          {dirty && <span className="badge" style={{ color: "var(--yellow)" }}>● unsaved</span>}
          {info?.truncated && <span className="badge" style={{ color: "var(--orange)" }}>read-only preview — file too large</span>}
          <div className="spacer" />
          <button className="btn small" onClick={toggleWrap} title="Toggle word wrap">↵ Wrap {wrapOn ? "on" : "off"}</button>
          <button className="btn small" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <span className="spinner" /> : <Save size={14} />} Save
          </button>
          <button className="icon-btn" onClick={requestClose} aria-label="Close editor"><X size={17} /></button>
        </div>
        {error ? (
          <div className="center-note">
            <div style={{ color: "var(--red)", fontSize: 15 }}>⚠ {error}</div>
            <div className="faint" style={{ maxWidth: 460 }}>
              Binary files (images, archives, executables…) can't be opened in the text editor — download them instead.
            </div>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="editor-host" ref={hostRef} />
        )}
        <div className="editor-status">
          <span>{(name.split(".").pop() ?? "txt").toUpperCase()}</span>
          <span>{info ? `${ENCODING_LABEL[info.encoding]}` : ""}{info?.crlf ? " · CRLF" : " · LF"}</span>
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <span>Ctrl+S to save</span>
          <div className="spacer" />
          <button className="btn small ghost" onClick={revert} disabled={!dirty}>Revert</button>
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
