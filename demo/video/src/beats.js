// The cut, beat by beat, tuned to the last capture. Plain data so node scripts
// can import it too.
export const FPS = 30;

// id matches the clip file prefix ("20" -> 20-tree.mp4). Each clip beat has one caption, shown
// for the whole beat. Optional per beat:
//   segments: [{ from, to?, speed }] in source-clip seconds, to speed up waits inside a clip;
//             without it the whole clip plays at one automatic speed.
//   highlights: [{ from, to, rect: [x, y, w, h] }]: from/to in seconds of the beat, rect in
//             page pixels of the 1280x720 capture, measured from clip frames. The rect is
//             outlined and everything else dimmed.
export const BEATS = [
  { id: 'title', seconds: 4 },
  {
    id: '10',
    seconds: 10,
    caption: 'You give one agent the task.',
    // The dialog is typed by 4s; the empty frame at 4s to 5s, before the node appears, is cut.
    segments: [{ from: 0, to: 4, speed: 1 }, { from: 5, speed: 1 }],
  },
  {
    id: '20',
    seconds: 15,
    caption: 'It splits the work and spawns workers, each in its own git worktree.',
    // Workers appear from 3s to 10s; the orchestrator's summary lands at 17s and is held.
    segments: [{ from: 0, to: 3, speed: 2 }, { from: 3, to: 11, speed: 1 }, { from: 11, to: 17, speed: 3 }, { from: 17, speed: 1 }],
    highlights: [{ from: 1.5, to: 11.3, rect: [6, 132, 312, 168] }],
  },
  {
    id: '30',
    seconds: 9,
    caption: 'Rows show state, cost and the last message. Nothing to babysit.',
    highlights: [{ from: 0.8, to: 8.5, rect: [962, 94, 310, 336] }],
  },
  {
    id: '40',
    seconds: 12,
    caption: "Review a worker's branch in place and send comments back as its next message.",
    // The diff opens at 1s, the comment is typed from 5s and added at 8s, and sent at about 12s.
    segments: [{ from: 1, to: 5, speed: 2 }, { from: 5, to: 9, speed: 1 }, { from: 9, to: 12, speed: 3 }, { from: 12, speed: 1 }],
    highlights: [{ from: 2, to: 11.5, rect: [600, 122, 680, 240] }],
  },
  {
    id: '50',
    seconds: 9,
    caption: 'A reviewer node checks the work.',
    highlights: [
      { from: 0.8, to: 3.8, rect: [4, 132, 314, 66] },
      { from: 4, to: 8.7, rect: [336, 164, 924, 204] },
    ],
  },
  // Played at 2x: the closed workers leave the tree, and the merged summary arrives at the end.
  {
    id: '55',
    seconds: 6,
    caption: 'The orchestrator merges and closes the workers.',
    highlights: [{ from: 0.6, to: 4.5, rect: [332, 470, 930, 36] }],
  },
  {
    id: '60',
    seconds: 8,
    caption: 'Closed nodes stay in history: read them, follow up or fork.',
    highlights: [{ from: 0.5, to: 7.5, rect: [4, 140, 314, 268] }],
  },
  { id: 'end', seconds: 5 },
];

export const isCard = (beat) => beat.id === 'title' || beat.id === 'end';
export const totalFrames = () => BEATS.reduce((n, b) => n + b.seconds * FPS, 0);

// Speed for a clip played whole: 1x if it is at most 1.5x too long (the end is trimmed), else
// the smallest whole multiple up to 4x that fits; anything still too long is trimmed at the end.
export const autoSpeed = (clipSeconds, targetSeconds) =>
  clipSeconds / targetSeconds <= 1.5 ? 1 : Math.min(4, Math.ceil(clipSeconds / targetSeconds));

// Lays a beat's clip onto its target length: [{ trimBefore, frames, speed }] in composition
// frames, back to back. Whatever the segments leave of the target is a freeze on the last frame.
export function planBeat(beat, clipSeconds) {
  const target = beat.seconds * FPS;
  const segments = beat.segments ?? [{ from: 0, speed: autoSpeed(clipSeconds, beat.seconds) }];
  const out = [];
  let used = 0;
  for (const s of segments) {
    const to = Math.min(s.to ?? clipSeconds, clipSeconds);
    const frames = Math.min(Math.round(((to - s.from) * FPS) / s.speed), target - used);
    if (frames <= 0) continue;
    out.push({ trimBefore: Math.round(s.from * FPS), frames, speed: s.speed });
    used += frames;
  }
  return out;
}
