import type { Sample } from './encode-job.js';

// A picture from Chrome's screencast. Times are in milliseconds.
export interface CaptureFrame {
  file: string;
  t: number;
  tabId: string;
  // The page size in CSS pixels.
  width: number;
  height: number;
}

export type TimelineEvent =
  // An action on an element. x and y are the element's center in CSS pixels.
  | { type: 'action'; t: number; tabId: string; kind: string; x?: number; y?: number }
  // A tool call that changes the page, like navigate or wait_for.
  | { type: 'activity'; start: number; end: number }
  | { type: 'caption'; t: number; text: string }
  // A question for the developer. Its frames and its wait time are cut.
  | { type: 'question'; t: number; open: boolean };

export interface TimelineOptions {
  start: number;
  end: number;
  fps: number;
  // Wait time longer than this is cut down to this.
  idleSeconds: number;
  pointer: boolean;
  captions: boolean;
  // How long the pointer takes to reach an element. A replay sets it from its pace.
  glideMs?: number;
}

// Real time around each action. The pointer moves before it, and the page reacts after it.
export const BEFORE_ACTION = 400;
export const AFTER_ACTION = 1000;
export const CAPTION_HOLD = 1500;
// The last picture stays a little longer, so viewers see how the flow ends.
export const END_HOLD = 1500;
const GLIDE = 350;
const RIPPLE = 500;
const CLICKS = new Set(['click', 'dblclick', 'check', 'uncheck', 'select', 'upload']);

type Span = [number, number];

interface Segment {
  a: number;
  b: number;
  // Where the segment starts and ends in the video.
  va: number;
  vb: number;
}

// Maps real time to video time. Active time plays as it was, wait time shrinks,
// and question time is gone.
export class TimeMap {
  readonly segments: Segment[] = [];

  constructor(start: number, end: number, active: Span[], cut: Span[], idleMs: number) {
    const inside = (spans: Span[], t: number) => spans.some(([a, b]) => t >= a && t < b);
    const points = [
      ...new Set([start, end, ...[...active, ...cut].flat()].filter((p) => p >= start && p <= end)),
    ].sort((x, y) => x - y);
    let v = 0;
    // Wait time in a row shrinks as one piece. Cut time in it counts as nothing,
    // so the wait before and after a question is one wait.
    let idleRun: Array<Segment & { cut: boolean }> = [];
    const closeIdle = () => {
      const real = idleRun.reduce((sum, s) => sum + (s.cut ? 0 : s.b - s.a), 0);
      const scale = real > idleMs ? idleMs / real : 1;
      for (const { cut: isCut, ...s } of idleRun) {
        s.va = v;
        if (!isCut) v += (s.b - s.a) * scale;
        s.vb = v;
        this.segments.push(s);
      }
      idleRun = [];
    };
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as number;
      const b = points[i + 1] as number;
      const mid = (a + b) / 2;
      if (inside(cut, mid)) {
        idleRun.push({ a, b, va: 0, vb: 0, cut: true });
      } else if (inside(active, mid)) {
        closeIdle();
        this.segments.push({ a, b, va: v, vb: v + (b - a) });
        v += b - a;
      } else {
        idleRun.push({ a, b, va: 0, vb: 0, cut: false });
      }
    }
    closeIdle();
  }

  get length(): number {
    return this.segments.at(-1)?.vb ?? 0;
  }

  toVideo(t: number): number {
    for (const s of this.segments) {
      if (t < s.b) return s.vb === s.va ? s.va : s.va + ((t - s.a) * (s.vb - s.va)) / (s.b - s.a);
    }
    return this.length;
  }

  toReal(v: number): number {
    for (const s of this.segments) {
      if (s.vb > s.va && v < s.vb) return s.a + ((v - s.va) * (s.b - s.a)) / (s.vb - s.va);
    }
    return this.segments.at(-1)?.b ?? 0;
  }
}

// Captions switch no faster than one each CAPTION_HOLD, so viewers can read them.
export function captionTimes(events: TimelineEvent[]): Array<{ t: number; text: string }> {
  const out: Array<{ t: number; text: string }> = [];
  for (const e of events) {
    if (e.type !== 'caption') continue;
    const last = out.at(-1);
    if (last?.text === e.text) continue;
    const t = last?.text ? Math.max(e.t, last.t + CAPTION_HOLD) : e.t;
    out.push({ t, text: e.text });
  }
  return out;
}

// Question times, as spans. A question that is still open lasts to the end.
function questionSpans(events: TimelineEvent[], end: number): Span[] {
  const spans: Span[] = [];
  let open: number | undefined;
  for (const e of events) {
    if (e.type !== 'question') continue;
    if (e.open && open === undefined) open = e.t;
    if (!e.open && open !== undefined) {
      spans.push([open, e.t]);
      open = undefined;
    }
  }
  if (open !== undefined) spans.push([open, end]);
  return spans;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// Builds the pictures of the video, at "fps" pictures each second. Pictures in a row that
// look the same become one longer picture.
export function buildSamples(
  frames: CaptureFrame[],
  events: TimelineEvent[],
  options: TimelineOptions,
): Sample[] {
  const sorted = [...events].sort(
    (x, y) => ('t' in x ? x.t : x.start) - ('t' in y ? y.t : y.start),
  );
  const cut = questionSpans(sorted, options.end);
  const captions = options.captions ? captionTimes(sorted) : [];
  const actions = sorted.filter(
    (e): e is Extract<TimelineEvent, { type: 'action' }> => e.type === 'action',
  );
  const active: Span[] = [
    [options.start, options.start + AFTER_ACTION],
    [options.end - AFTER_ACTION, options.end],
    ...actions.map((a): Span => [a.t - BEFORE_ACTION, a.t + AFTER_ACTION]),
    ...sorted.flatMap((e): Span[] =>
      e.type === 'activity' ? [[e.start - BEFORE_ACTION, e.end + AFTER_ACTION]] : [],
    ),
    ...captions.map((c): Span => [c.t, c.t + CAPTION_HOLD]),
  ];
  const map = new TimeMap(options.start, options.end, active, cut, options.idleSeconds * 1000);

  // Pictures taken while a question was open show the panel, so they are left out.
  const usable = frames
    .filter((f) => !cut.some(([a, b]) => f.t >= a && f.t < b))
    .sort((x, y) => x.t - y.t);
  if (usable.length === 0) return [];

  const step = 1000 / options.fps;
  const total = map.length;
  const raw: Sample[] = [];
  let f = 0;
  for (let v = 0; v < total || raw.length === 0; v += step) {
    const t = map.toReal(v);
    while (f + 1 < usable.length && (usable[f + 1] as CaptureFrame).t <= t) f += 1;
    const frame = usable[f] as CaptureFrame;
    const sample: Sample = {
      file: frame.file,
      // The last picture can be shorter. A recording with no time left shows one second.
      duration: (total > 0 ? Math.min(step, total - v) : 1000) / 1000,
      width: frame.width,
      height: frame.height,
    };
    const caption = [...captions].reverse().find((c) => c.t <= t);
    if (caption?.text) sample.caption = caption.text;
    if (options.pointer) {
      const onTab = actions.filter(
        (a) => a.tabId === frame.tabId && a.x !== undefined && a.y !== undefined,
      );
      const before = [...onTab].reverse().find((a) => a.t <= t);
      const next = onTab.find((a) => a.t > t);
      const glide = options.glideMs ?? GLIDE;
      if (next && next.t - t <= glide) {
        const from = before ?? next;
        const k = 1 - (next.t - t) / glide;
        sample.pointer = {
          x: lerp(from.x as number, next.x as number, k),
          y: lerp(from.y as number, next.y as number, k),
        };
      } else if (before) {
        sample.pointer = { x: before.x as number, y: before.y as number };
      }
      if (before && CLICKS.has(before.kind) && t - before.t < RIPPLE) {
        sample.ripple = {
          x: before.x as number,
          y: before.y as number,
          p: (t - before.t) / RIPPLE,
        };
      }
    }
    raw.push(sample);
    if (total <= 0) break;
  }

  // Joins pictures in a row that look the same.
  const same = (a: Sample, b: Sample) =>
    a.file === b.file &&
    a.caption === b.caption &&
    !a.ripple &&
    !b.ripple &&
    a.pointer?.x === b.pointer?.x &&
    a.pointer?.y === b.pointer?.y;
  const out: Sample[] = [];
  for (const sample of raw) {
    const last = out.at(-1);
    if (last && same(last, sample)) last.duration += sample.duration;
    else out.push({ ...sample });
  }
  const last = out.at(-1);
  if (last) {
    // The hold shows the page without a click mark.
    if (last.ripple) out.push({ ...last, ripple: undefined, duration: END_HOLD / 1000 });
    else last.duration += END_HOLD / 1000;
  }
  return out;
}

// The end of a video: the last "seconds" seconds. The first picture gets shorter to fit.
export function lastSeconds(samples: Sample[], seconds: number): Sample[] {
  const out = samples.map((s) => ({ ...s }));
  let total = out.reduce((sum, s) => sum + s.duration, 0);
  while (out.length > 1 && total - (out[0] as Sample).duration >= seconds) {
    total -= (out.shift() as Sample).duration;
  }
  const first = out[0];
  if (first && total > seconds) first.duration -= total - seconds;
  return out;
}
