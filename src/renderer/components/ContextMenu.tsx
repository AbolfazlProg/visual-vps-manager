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

/**
 * Context menu with correct open/close semantics:
 * - closes on ANY mousedown OUTSIDE the menu (the robust pattern)
 * - closes on Escape
 * - NEVER listens for click (a click fires right after contextmenu on some
 *   platforms and would instantly close the menu — the bug where the menu
 *   "flashed" and never opened)
 * - clamps itself inside the viewport (regression-tested)
 */
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
        x: Math.max(4, Math.min(x, window.innerWidth - r.width - 8)),
        y: Math.max(4, Math.min(y, window.innerHeight - r.height - 8))
      });
    }
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onBlur = () => onClose();
    // mousedown, not click — works for left and right buttons alike
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
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
