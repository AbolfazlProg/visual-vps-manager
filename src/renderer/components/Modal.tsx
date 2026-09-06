import React, { useEffect, useState } from "react";

export function Modal({ title, children, onClose, footer, wide }: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, detail, danger, confirmLabel, onConfirm, onCancel, busy }: {
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" style={{ borderTopColor: "currentColor", borderLeftColor: "currentColor" }} /> : null}
            {confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 14 }}>{message}</div>
      {detail && <div className="card" style={{ fontSize: 12.5 }}>{detail}</div>}
    </Modal>
  );
}

/** Simple prompt-style dialog with input validation. */
export function PromptDialog({ title, label, initial, placeholder, confirmLabel, validate, onConfirm, onCancel }: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (v: string) => string | null;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const v = value.trim();
    const err = validate?.(v) ?? null;
    if (err) {
      setError(err);
      return;
    }
    onConfirm(v);
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}> {confirmLabel ?? "OK"} </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="prompt-input">{label}</label>
        <input
          id="prompt-input"
          className="input mono"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        {error && <div style={{ color: "var(--red)", fontSize: 12.5 }}>{error}</div>}
      </div>
    </Modal>
  );
}
