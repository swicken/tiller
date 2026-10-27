import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** A length the viewer prefers, saved in localStorage under `key` within [min, max]. */
export interface ResizePreference { key: string; initial: number; min: number; max: number }

const clamp = ({ min, max }: ResizePreference, value: number) => Math.round(Math.min(max, Math.max(min, value)));

export function readPreference(pref: ResizePreference): number {
  try {
    const raw = localStorage.getItem(pref.key), value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value) && value >= pref.min && value <= pref.max) return value;
  } catch { /* per-viewer convenience only */ }
  return pref.initial;
}

export function savePreference(pref: ResizePreference, value: number) {
  try { localStorage.setItem(pref.key, String(clamp(pref, value))); } catch { /* resizing still works without storage */ }
}

/**
 * A role="separator" handle: drag, arrow keys (Shift for bigger steps), Home/End and double-click to reset.
 * `fit` clamps a preference to the current layout, whose limits are `bounds`. Axis 'x' grows rightward;
 * 'y' sits above its panel, so it grows upward. Only deliberate changes are saved.
 */
export function useResizeHandle(pref: ResizePreference, bounds: { min: number; max: number }, fit: (preferred: number) => number, axis: 'x' | 'y') {
  const handle = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(() => readPreference(pref));
  const latest = useRef(preferred);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ id: number; at: number; size: number; preferred: number } | null>(null);
  const size = fit(preferred);
  const { min, max } = bounds;
  const position = (e: PointerEvent) => (axis === 'x' ? e.clientX : -e.clientY);
  const [grow, shrink] = axis === 'x' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowUp', 'ArrowDown'];
  const change = (value: number) => {
    latest.current = clamp(pref, value);
    setPreferred(latest.current);
  };

  useLayoutEffect(() => {
    const el = handle.current;
    return () => {
      const active = drag.current;
      drag.current = null;
      if (active && el?.hasPointerCapture(active.id)) el.releasePointerCapture(active.id);
    };
  }, []);

  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (commit) savePreference(pref, latest.current);
    else change(active.preferred);
    setResizing(false);
    if (handle.current?.hasPointerCapture(active.id)) handle.current.releasePointerCapture(active.id);
  };

  return { size, props: {
    ref: handle, role: 'separator', tabIndex: 0, 'aria-orientation': axis === 'x' ? 'vertical' as const : 'horizontal' as const,
    'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': size, 'aria-valuetext': `${size} pixels`,
    'data-resizing': resizing || undefined,
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, at: position(e), size, preferred: latest.current };
      setResizing(true);
    },
    onPointerMove: (e: PointerEvent) => {
      const active = drag.current;
      if (!active || active.id !== e.pointerId) return;
      const next = fit(active.size + position(e) - active.at);
      if (next !== fit(latest.current)) change(next);
    },
    onPointerUp: (e: PointerEvent) => { if (drag.current?.id === e.pointerId) finish(true); },
    onPointerCancel: (e: PointerEvent) => { if (drag.current?.id === e.pointerId) finish(false); },
    onLostPointerCapture: () => finish(false),
    onDoubleClick: () => { change(pref.initial); savePreference(pref, pref.initial); },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || drag.current) return;
      const step = e.shiftKey ? 40 : 16;
      const next = e.key === 'Home' ? min : e.key === 'End' ? max
        : e.key === shrink ? Math.max(min, size - step) : e.key === grow ? Math.min(max, size + step) : undefined;
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (next !== size) { change(next); savePreference(pref, next); }
    },
  } };
}
