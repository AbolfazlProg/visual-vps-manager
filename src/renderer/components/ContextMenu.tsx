import { useEffect, useRef, useState } from "react";
import { VpsmApiError } from "../ipc";

export interface CtxItem {
  label?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  sep?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number;
  items: CtxItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(x, window.innerWidth - r.width - 8),
        y: Math.min(y, window.innerHeight - r.height - 8)
      });
    }
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, x, y]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => { onClose(); it.action?.(); }}
          >
            {it.icon}
            {it.label}
          </button>
        )
      )}
    </div>
  );
}

void VpsmApiError;
