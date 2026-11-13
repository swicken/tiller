const PATHS = {
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M7 5l12 7-12 7V5z',
  chevron: 'M9 6l6 6-6 6',
  updown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  panel: 'M4 5h16v14H4V5zM15 5v14',
  subnode: 'M6 4v9a3 3 0 003 3h9M14 12l4 4-4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  restart: 'M20 12a8 8 0 11-2.4-5.7M20 4v5h-5',
  merge: 'M7 4v16M7 8a7 7 0 007 7h5M16 12l3 3-3 3',
  bell: 'M6 16v-5a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4',
  fork: 'M6 4v4a4 4 0 004 4h4a4 4 0 014 4v4M18 4v4a4 4 0 01-4 4M6 20v-4',
  history: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
  bellOff: 'M6 16v-5a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4M3 3l18 18',
  inbox: 'M4 13l2.5-8h11l2.5 8v6H4v-6zM4 13h5l1 2h4l1-2h5',
  check: 'M5 12l5 5L19 7',
  alert: 'M12 9v4M12 17h.01M10.3 4.3L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z',
  info: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 11v5M12 8h.01',
  copy: 'M9 9h10v10H9zM5 15V5h10',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
