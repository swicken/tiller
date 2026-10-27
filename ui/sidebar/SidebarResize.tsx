import { useLayoutEffect, useState } from 'react';
import { readPreference, savePreference, useResizeHandle } from './useResizeHandle';

const WIDTH = { key: 'tl.sidebarWidth', initial: 320, min: 240, max: 640 };

/** Reserve the open details panel, then keep 360px for the terminal (60% of narrower remaining space). */
export function sidebarBounds(viewport: number, panelOpen = false) {
  const available = Math.max(0, viewport - (panelOpen ? 320 : 0));
  const max = Math.floor(Math.min(WIDTH.max, available - Math.min(360, available * 0.6)));
  return { min: Math.min(WIDTH.min, max), max };
}

export function sidebarWidth(preferred: number, viewport: number, panelOpen = false) {
  const { min, max } = sidebarBounds(viewport, panelOpen);
  return Math.round(Math.min(max, Math.max(min, preferred)));
}

export const readSidebarWidth = () => readPreference(WIDTH);
export const saveSidebarWidth = (width: number) => savePreference(WIDTH, width);

/** Local layout preference: resizing the window clamps the view without changing the saved desktop width. */
export function SidebarResize({ panelOpen }: { panelOpen: boolean }) {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const { size: width, props } = useResizeHandle(WIDTH, sidebarBounds(viewport, panelOpen), (preferred) => sidebarWidth(preferred, viewport, panelOpen), 'x');

  useLayoutEffect(() => {
    const app = props.ref.current!.closest<HTMLElement>('.app')!;
    const previous = app.style.getPropertyValue('--sidebar-width');
    setViewport(app.clientWidth);
    const observer = new ResizeObserver(() => setViewport(app.clientWidth));
    observer.observe(app);
    return () => {
      observer.disconnect();
      if (previous) app.style.setProperty('--sidebar-width', previous);
      else app.style.removeProperty('--sidebar-width');
    };
  }, []);

  useLayoutEffect(() => {
    props.ref.current?.closest<HTMLElement>('.app')?.style.setProperty('--sidebar-width', `${width}px`);
  }, [width]);

  return <div {...props} className="sidebar-resize" aria-label="Sidebar width"
    title="Drag to resize sidebar. Arrow keys resize; Home/End set minimum/maximum. Double-click to reset." />;
}
