import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SecretStore } from '../../src/guards/secrets.js';
import { validatePlanText } from '../../src/run/plans.js';
import { chooseFormat } from '../../src/video/formats.js';
import {
  blurAt,
  buildSamples,
  type CaptureFrame,
  captionTimes,
  END_HOLD,
  lastSeconds,
  type TimelineEvent,
  TimeMap,
} from '../../src/video/timeline.js';

import { tempDir } from '../helpers/temp.js';

const frame = (file: string, t: number, tabId = 't1'): CaptureFrame => ({
  file,
  t,
  tabId,
  width: 1280,
  height: 800,
});
const options = (end: number) => ({
  start: 0,
  end,
  fps: 10,
  idleSeconds: 1,
  pointer: true,
  captions: true,
});
const length = (samples: Array<{ duration: number }>) =>
  samples.reduce((sum, s) => sum + s.duration, 0);

describe('video timeline', () => {
  it('cuts 3 minutes of waiting down to about one second', () => {
    const frames = [frame('a', 0), frame('b', 1100), frame('c', 181_100)];
    const events: TimelineEvent[] = [
      { type: 'action', t: 1000, tabId: 't1', kind: 'click', x: 100, y: 100 },
      { type: 'action', t: 181_000, tabId: 't1', kind: 'click', x: 300, y: 200 },
    ];
    const samples = buildSamples(frames, events, options(183_000));
    // 2 s at the start, 1 s of wait, 1.4 s around the second click, the last second, the hold.
    expect(length(samples)).toBeCloseTo(2 + 1 + 1.4 + 1 + END_HOLD / 1000, 1);
    expect(length(samples)).toBeLessThan(20);
    expect(samples.map((s) => s.file)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('leaves out question time and the pictures of the question', () => {
    const frames = [frame('page', 0), frame('question', 3000), frame('after', 60_500)];
    const events: TimelineEvent[] = [
      { type: 'question', t: 2500, open: true },
      { type: 'question', t: 60_000, open: false },
    ];
    const samples = buildSamples(frames, events, options(62_000));
    expect(samples.map((s) => s.file)).not.toContain('question');
    expect(length(samples)).toBeLessThan(6);
  });

  it('keeps each caption on screen long enough to read', () => {
    const times = captionTimes([
      { type: 'caption', t: 0, text: 'Open the shop' },
      { type: 'caption', t: 200, text: 'Add the mug' },
      { type: 'caption', t: 300, text: 'Add the mug' },
      { type: 'caption', t: 5000, text: 'Open the cart' },
    ]);
    expect(times).toEqual([
      { t: 0, text: 'Open the shop' },
      { t: 1500, text: 'Add the mug' },
      { t: 5000, text: 'Open the cart' },
    ]);
  });

  it('moves the pointer to each target and marks clicks', () => {
    const events: TimelineEvent[] = [
      { type: 'action', t: 1000, tabId: 't1', kind: 'click', x: 100, y: 100 },
      { type: 'action', t: 3000, tabId: 't1', kind: 'click', x: 500, y: 300 },
    ];
    const samples = buildSamples([frame('a', 0)], events, options(4000));
    const pointers = samples.filter((s) => s.pointer).map((s) => s.pointer?.x);
    // It glides from 100 to 500, so some positions are between them.
    expect(pointers.some((x) => x !== undefined && x > 100 && x < 500)).toBe(true);
    expect(samples.some((s) => s.ripple && s.ripple.x === 500)).toBe(true);
    // A pointer from another tab does not show.
    const other = buildSamples([frame('a', 0, 't2')], events, options(4000));
    expect(other.some((s) => s.pointer)).toBe(false);
  });

  it('maps video time back to real time', () => {
    const map = new TimeMap(0, 10_000, [[0, 1000]], [[5000, 6000]], 1000);
    expect(map.length).toBe(2000);
    expect(map.toReal(500)).toBe(500);
    expect(map.toVideo(6500)).toBeGreaterThan(1000);
  });
});

describe('bug clips', () => {
  it('keeps only the last seconds, and cuts the first picture to fit', () => {
    const samples = [5, 10, 3, 4].map((duration, i) => ({
      file: String(i),
      duration,
      width: 1,
      height: 1,
    }));
    const clip = lastSeconds(samples, 15);
    expect(clip.map((s) => s.file)).toEqual(['1', '2', '3']);
    expect(clip[0]?.duration).toBe(8);
    expect(length(clip)).toBe(15);
    expect(lastSeconds(samples, 60)).toHaveLength(4);
  });
});

describe('video format', () => {
  it('takes the format, then the path, then the setting', () => {
    expect(chooseFormat('gif', undefined, 'mp4')).toBe('gif');
    expect(chooseFormat(undefined, 'docs/cart.webm', 'mp4')).toBe('webm');
    expect(chooseFormat(undefined, undefined, 'mp4')).toBe('mp4');
    expect(() => chooseFormat('gif', 'docs/cart.mp4', 'mp4')).toThrow(/ends in \.mp4/);
  });
});

describe('blurred secrets in videos', () => {
  const box = (x: number) => ({ x, y: 10, width: 100, height: 20 });

  it('blurs the boxes of the time of each picture, and both places around a move', () => {
    const masks = [
      { t: 100, boxes: [box(1)] },
      { t: 1000, boxes: [box(2)] },
    ];
    // Before the first report, the first boxes count.
    expect(blurAt(masks, 50)).toEqual([box(1)]);
    expect(blurAt(masks, 500)).toEqual([box(1)]);
    // Just before a move and just after it, both places are blurred.
    expect(blurAt(masks, 900)).toEqual([box(1), box(2)]);
    expect(blurAt(masks, 1100)).toEqual([box(2), box(1)]);
    expect(blurAt(masks, 2000)).toEqual([box(2)]);
    expect(blurAt([], 100)).toBeUndefined();
    expect(blurAt([{ t: 0, boxes: [] }], 100)).toBeUndefined();
  });

  it('puts the boxes of the right tab on each picture', () => {
    const events: TimelineEvent[] = [
      { type: 'mask', t: 10, tabId: 't1', boxes: [box(5)] },
      { type: 'mask', t: 10, tabId: 't2', boxes: [box(9)] },
    ];
    const samples = buildSamples(
      [frame('a.jpg', 20), frame('b.jpg', 600, 't2')],
      events,
      options(1000),
    );
    expect(samples.find((x) => x.file === 'a.jpg')?.blur).toEqual([box(5)]);
    expect(samples.find((x) => x.file === 'b.jpg')?.blur).toEqual([box(9)]);
  });

  it('gives videos the secrets of this environment, long ones only', () => {
    const dir = tempDir('video-secrets');
    mkdirSync(join(dir, '.walkthrough'));
    writeFileSync(join(dir, '.walkthrough', '.env'), 'API_KEY=sk_test_123456\nPIN=1234\n');
    writeFileSync(join(dir, '.walkthrough', '.env.staging'), 'STAGING_KEY=staging-only-value\n');
    const store = SecretStore.forProject(dir);
    expect(store.videoValues()).toEqual(['sk_test_123456']);
    const staging = SecretStore.forProject(dir, { name: 'staging', protected: false, rename: {} });
    expect(staging.videoValues().sort()).toEqual(['sk_test_123456', 'staging-only-value']);
  });

  it('reads mask selectors from config.yaml and from a plan', () => {
    const dir = tempDir('video-mask');
    mkdirSync(join(dir, '.walkthrough'));
    writeFileSync(join(dir, '.walkthrough', 'config.yaml'), 'video:\n  mask: [".customer-name"]\n');
    expect(loadConfig(dir).video.mask).toEqual(['.customer-name']);
    expect(loadConfig(tempDir('video-mask-none')).video.mask).toEqual([]);
    const plan = validatePlanText(
      'name: V\nvideo: { mask: [".email", "#phone"] }\nsteps:\n  - do: x\n',
    );
    expect(plan.ok).toBe(true);
  });
});
