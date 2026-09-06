import { useApp } from "../store";
import { X, Check, AlertTriangle, Info } from "./icons";

export function ToastHost() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <ToastGlyph kind={t.kind} />
          <div className="grow">
            <div className="title">{t.title}</div>
            {t.detail && <div className="detail">{t.detail}</div>}
          </div>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ToastGlyph({ kind }: { kind: "success" | "error" | "info" | "warn" }) {
  const size = 17;
  if (kind === "success") return <Check size={size} color="var(--green)" />;
  if (kind === "error") return <AlertTriangle size={size} color="var(--red)" />;
  if (kind === "warn") return <AlertTriangle size={size} color="var(--orange)" />;
  return <Info size={size} color="var(--accent)" />;
}
