import { useEffect, useRef, useState, type ReactNode } from "react";
import { strings } from "../strings";

const ST = strings.he.app.home.statusTooltip;

// The small "i" affordance and its popover, extracted from Home's StatusInfo
// (AIC-134) so the admin forms can use the same one. Everything non-obvious
// here was earned by the original: hover lives on the WRAPPER so moving the
// pointer from the "i" into the popover doesn't dismiss it mid-read; the
// popover is position:fixed and re-measured on scroll/resize so it never gets
// clipped by an overflow container; and it opens on focus and closes on Escape
// or an outside pointer-down, because hover alone is unusable on a touch
// screen — which is where an operator on a call actually is.
export function InfoTip({ children, label }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 280 });
  const popId = useRef(`info-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    if (!open) return;
    function reposition() {
      const btn = btnRef.current;
      if (!btn) return;
      const margin = 8;
      const width = Math.min(300, window.innerWidth - margin * 2);
      const r = btn.getBoundingClientRect();
      let left = r.left + r.width / 2 - width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
      const estHeight = popRef.current?.offsetHeight ?? 150;
      let top = r.bottom + 8;
      if (top + estHeight > window.innerHeight - margin) top = Math.max(margin, r.top - estHeight - 8);
      setPos({ top, left, width });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        className="info-affordance"
        aria-label={label ?? ST.infoLabel}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}
      >
        <span className="info-affordance-dot">i</span>
      </button>
      {open && (
        <div
          id={popId}
          role="tooltip"
          ref={popRef}
          className="info-popover"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
        >
          {children}
        </div>
      )}
    </span>
  );
}
