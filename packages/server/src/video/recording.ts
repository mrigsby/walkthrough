import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { maskSecretFields } from '../evidence/annotate.js';
import { checkMediaPath } from '../guards/paths.js';
import { onShutdown } from '../lifecycle.js';
import type { Rect } from '../panel/controller.js';
import { adhocVideoDir, fileStamp } from '../project-files.js';
import { latestRunId, RunStore } from '../run/run-store.js';
import { slug } from '../text.js';
import { VideoCapture } from './capture.js';
import type { Sample } from './encode-job.js';
import { type EncodeOutput, encodeVideo } from './encoder.js';
import { chooseFormat, type VideoFormat } from './formats.js';
import { buildSamples, lastSeconds } from './timeline.js';

// Pictures each second in WebM and MP4. GIF uses the gifFps setting.
const VIDEO_FPS = 15;
// The bug clip buffer keeps this much real time. The clip is the last replaySeconds of
// it, after wait time is cut.
const RING_KEEP_MS = 3 * 60 * 1000;
// Each picture of a slideshow shows this long.
const SLIDE_SECONDS = 2;

export interface VideoRecording {
  capture: VideoCapture;
  name: string;
  // The run that the recording belongs to. Step titles become captions.
  runId?: string;
  // Started by run_start for the whole run. run_finish saves it as video/run.<ext>.
  whole: boolean;
  format?: VideoFormat;
  path?: string;
  captions: boolean;
  // Removes the cleanup for a server stop.
  forget: () => void;
}

// The caption for the step that comes next: its caption key, or its "do" text.
export function stepCaption(store: RunStore): string {
  const next = store.nextPending();
  return next ? (next.caption ?? next.title) : '';
}

// The recordings that watch the page now: a video, and the bug clip buffer of a run.
export function liveCaptures(ctx: Context): VideoCapture[] {
  return [ctx.video?.capture, ctx.ring].filter((c): c is VideoCapture => Boolean(c?.recording));
}

// What an action tells the recordings.
export interface VideoHooks {
  action(tabId: string, kind: string, rect?: Rect): void;
  // Hides a field before a secret goes in, until the last recording stops.
  maskSecret(handle: ElementHandle): Promise<void>;
}

export function videoHooks(ctx: Context): VideoHooks | undefined {
  const captures = liveCaptures(ctx);
  if (captures.length === 0) return undefined;
  return {
    action: (tabId, kind, rect) => {
      for (const c of captures) c.action(tabId, kind, rect);
    },
    maskSecret: async (handle) => {
      ctx.videoMasks.push(await maskSecretFields([handle]));
    },
  };
}

// Secrets that are already typed stay hidden while anything records.
async function maskTypedSecrets(ctx: Context): Promise<void> {
  const driver = ctx.driver;
  if (driver) ctx.videoMasks.push(await maskSecretFields(driver.secretFields));
}

// Shows the hidden fields again when no recording is left.
async function unmaskWhenIdle(ctx: Context): Promise<void> {
  if (liveCaptures(ctx).length > 0) return;
  const restores = ctx.videoMasks.reverse();
  ctx.videoMasks = [];
  for (const restore of restores) await restore().catch(() => undefined);
}

// A new caption for the recordings of a run: the step that comes next.
export function setRunCaption(ctx: Context, store: RunStore): void {
  const caption = stepCaption(store);
  const video = ctx.video;
  if (video?.capture.recording && video.runId === store.run.id && video.captions)
    video.capture.setCaption(caption);
  if (ctx.ring?.recording) ctx.ring.setCaption(caption);
}

export async function startVideo(
  ctx: Context,
  options: {
    name?: string;
    showPanel?: boolean;
    captions?: boolean;
    whole?: boolean;
    format?: VideoFormat;
    path?: string;
  } = {},
): Promise<VideoRecording> {
  if (ctx.video?.capture.recording) {
    throw new ToolError(
      `A video is recording already ("${ctx.video.name}"). Call video with action stop first.`,
      'video_active',
    );
  }
  // A stopped recording that was never saved goes away.
  await dropVideo(ctx);
  const config = await ctx.config();
  const driver = ctx.requireDriver();
  driver.activeTab();
  const run = ctx.run?.run.status === 'running' ? ctx.run : undefined;
  const capture = new VideoCapture(driver, {
    maxWidth: config.video.width,
    showPanel: options.showPanel ?? config.video.showPanel,
  });
  const recording: VideoRecording = {
    capture,
    name: options.name ?? (options.whole ? 'run' : 'video'),
    runId: run?.run.id,
    whole: options.whole ?? false,
    format: options.format,
    path: options.path,
    captions: options.captions ?? config.video.captions,
    forget: () => undefined,
  };
  await maskTypedSecrets(ctx);
  await capture.start();
  if (run && recording.captions) capture.setCaption(stepCaption(run));
  // When the server stops, the pictures go away. A run notes that its video is lost.
  recording.forget = onShutdown(() => {
    capture.discard();
    if (run?.run.status === 'running') {
      run.run.videoNote = 'The server stopped before Walkthrough saved the video of this run.';
      run.save();
    }
  });
  ctx.video = recording;
  return recording;
}

// Removes a recording and its pictures without saving it.
export async function dropVideo(ctx: Context): Promise<void> {
  if (!ctx.video) return;
  const { capture, forget } = ctx.video;
  ctx.video = undefined;
  await capture.stop().catch(() => undefined);
  capture.discard();
  forget();
  await unmaskWhenIdle(ctx);
}

export interface SavedVideo {
  lines: string[];
  // A picture from the video, as base64.
  preview?: string;
  previewType?: string;
  // The run that got the video.
  store?: RunStore;
}

const size = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

// Stops the recording and saves the video. When this fails, the recording stays,
// so video stop can try again, for example with another format.
export async function stopVideo(
  ctx: Context,
  options: { format?: VideoFormat; path?: string; name?: string } = {},
): Promise<SavedVideo> {
  const recording = ctx.video;
  if (!recording) {
    throw new ToolError('No video is recording. Call video with action start first.', 'no_video');
  }
  const config = await ctx.config();
  const { capture } = recording;
  await capture.stop();
  await unmaskWhenIdle(ctx);
  const pathArg = options.path ?? recording.path;
  const format = chooseFormat(options.format ?? recording.format, pathArg, config.video.runFormat);
  const target = pathArg
    ? checkMediaPath(pathArg, config.projectDir, config.screenshotRoots)
    : undefined;
  const samples = buildSamples(capture.frames, capture.events, {
    start: capture.startedAt,
    end: capture.stoppedAt ?? Date.now(),
    fps: format === 'gif' ? config.video.gifFps : VIDEO_FPS,
    idleSeconds: config.video.idleSeconds,
    pointer: config.video.pointer,
    captions: recording.captions,
  });
  if (samples.length === 0) {
    await dropVideo(ctx);
    throw new ToolError(
      'The recording has no pictures, so Walkthrough saved no video. Chrome sends a picture each time the page changes. Keep a tab open while the video records.',
      'video_empty',
    );
  }
  const seconds = samples.reduce((sum, s) => sum + s.duration, 0);
  if (format === 'gif' && seconds > config.video.maxGifSeconds) {
    throw new ToolError(
      `The video is ${Math.round(seconds)} seconds long. Walkthrough makes GIF files of up to ${config.video.maxGifSeconds} seconds (maxGifSeconds), because longer ones get very large. Call video with action stop and format mp4 or webm.`,
      'video_too_long',
    );
  }

  const store =
    recording.runId === undefined
      ? undefined
      : ctx.run?.run.id === recording.runId
        ? ctx.run
        : RunStore.open(config.projectDir, recording.runId);
  const dir = store ? join(store.dir, 'video') : adhocVideoDir(config.projectDir);
  mkdirSync(dir, { recursive: true });
  const base = recording.whole ? 'run' : fileStamp(options.name ?? recording.name);
  const middle = samples[Math.floor(samples.length / 2)];
  const preview = middle
    ? readFileSync(join(capture.dir, middle.file)).toString('base64')
    : undefined;
  const out = await encodeVideo({
    config,
    framesDir: capture.dir,
    samples,
    format,
    outFile: join(dir, `${base}.${format}`),
  });
  capture.discard();
  recording.forget();
  ctx.video = undefined;

  const { lines, copied } = describeSaved(config.projectDir, out, format, target);
  const actions = capture.events.filter((e) => e.type === 'action').length;
  lines.push(
    `It shows ${actions} action(s). Walkthrough cut each wait to ${config.video.idleSeconds} second(s), and cut the time that a question was open in the panel.`,
  );
  if (store) {
    store.run.videos ??= [];
    store.run.videos.push({
      file: relative(store.dir, out.file),
      format: out.format,
      seconds: Math.round(out.seconds * 10) / 10,
      bytes: out.bytes,
      name: recording.name,
      ...(recording.whole ? { whole: true } : {}),
      ...(copied ? { path: copied } : {}),
    });
    store.save();
  }
  return { lines, preview, previewType: 'image/jpeg', store };
}

// The reply lines for a saved video. It also copies the video to the exact path.
function describeSaved(
  projectDir: string,
  out: EncodeOutput,
  format: VideoFormat,
  target?: { path: string; display: string },
): { lines: string[]; copied?: string } {
  const lines = [
    `Saved the video (${out.format.toUpperCase()}, ${out.seconds.toFixed(1)} seconds, ${size(out.bytes)}, ${out.width}x${out.height}): ${relative(projectDir, out.file)}`,
  ];
  let copied: string | undefined;
  if (target && out.format === format) {
    mkdirSync(dirname(target.path), { recursive: true });
    copyFileSync(out.file, target.path);
    copied = target.display;
    lines.push(`Also saved it to ${target.display}. It replaced any file that was there.`);
  } else if (target) {
    lines.push(`Walkthrough did not write ${target.display}, because the video is not ${format}.`);
  }
  if (out.note) lines.push(out.note);
  return { lines, copied };
}

// Starts the bug clip buffer of a run. It keeps the last minutes of the tab, so a bug
// gets a video of what led to it. The panel stays, because the developer uses it.
export async function startRing(ctx: Context): Promise<void> {
  const config = await ctx.config();
  const store = ctx.run;
  if (config.video.replaySeconds <= 0 || ctx.ring || !ctx.driver?.hasActiveTab || !store) return;
  const ring = new VideoCapture(ctx.driver, {
    maxWidth: config.video.width,
    showPanel: true,
    keepMs: RING_KEEP_MS,
  });
  await maskTypedSecrets(ctx);
  await ring.start();
  if (config.video.captions) ring.setCaption(stepCaption(store));
  ctx.ring = ring;
  ctx.forgetRing = onShutdown(() => ring.discard());
}

export async function stopRing(ctx: Context): Promise<void> {
  const ring = ctx.ring;
  if (!ring) return;
  ctx.ring = undefined;
  await ring.stop().catch(() => undefined);
  ring.discard();
  ctx.forgetRing?.();
  ctx.forgetRing = undefined;
  await unmaskWhenIdle(ctx);
}

// Saves the last seconds before a bug as video/bug-<step>.<bugFormat> in the run folder.
// Returns the file from the project folder, or undefined when nothing records.
export async function bugClip(
  ctx: Context,
  store: RunStore,
  stepId: string,
): Promise<{ file: string; seconds: number } | undefined> {
  const config = await ctx.config();
  if (config.video.replaySeconds <= 0) return undefined;
  const video = ctx.video?.capture.recording ? ctx.video : undefined;
  const capture = video?.runId === store.run.id ? video.capture : ctx.ring;
  if (!capture?.recording) return undefined;
  const format = config.video.bugFormat;
  return capture.hold(async () => {
    const samples = lastSeconds(
      buildSamples(capture.frames, capture.events, {
        start: capture.since,
        end: Date.now(),
        fps: format === 'gif' ? config.video.gifFps : VIDEO_FPS,
        idleSeconds: config.video.idleSeconds,
        pointer: config.video.pointer,
        captions: config.video.captions,
      }),
      config.video.replaySeconds,
    );
    if (samples.length === 0) return undefined;
    const dir = join(store.dir, 'video');
    mkdirSync(dir, { recursive: true });
    let name = `bug-${slug(stepId, 40, 'step')}`;
    for (let n = 2; existsSync(join(dir, `${name}.${format}`)); n++)
      name = `bug-${slug(stepId, 40, 'step')}-${n}`;
    const out = await encodeVideo({
      config,
      framesDir: capture.dir,
      samples,
      format,
      outFile: join(dir, `${name}.${format}`),
    });
    return { file: relative(config.projectDir, out.file), seconds: out.seconds };
  });
}

// A slideshow of the screenshots of a run. Each picture shows for two seconds, with the
// step title as the caption.
export async function slideshow(
  ctx: Context,
  options: { runId?: string; format?: VideoFormat; path?: string },
): Promise<SavedVideo> {
  const config = await ctx.config();
  const id =
    options.runId ??
    (ctx.run?.run.status === 'running' ? ctx.run.run.id : latestRunId(config.projectDir));
  if (!id) throw new ToolError('There are no runs yet.', 'no_run');
  const store = ctx.run?.run.id === id ? ctx.run : RunStore.open(config.projectDir, id);
  const format = chooseFormat(options.format, options.path, 'gif');
  const target = options.path
    ? checkMediaPath(options.path, config.projectDir, config.screenshotRoots)
    : undefined;

  // The pictures get plain numbered names in a temp folder, for the encoder.
  const dir = mkdtempSync(join(tmpdir(), 'uiwalk-slides-'));
  try {
    const samples: Sample[] = [];
    for (const step of store.run.steps) {
      for (const shot of step.screenshots) {
        const file = join(store.dir, shot);
        if (!existsSync(file)) continue;
        const name = `${String(samples.length + 1).padStart(6, '0')}${extname(file).toLowerCase()}`;
        copyFileSync(file, join(dir, name));
        samples.push({
          file: name,
          duration: SLIDE_SECONDS,
          width: 0,
          height: 0,
          caption: `${step.index}. ${step.caption ?? step.title}`,
        });
      }
    }
    if (samples.length === 0) {
      throw new ToolError(
        `The run "${store.run.name}" has no screenshots. Save screenshots in the steps, or record a video.`,
        'no_screenshots',
      );
    }
    if (format === 'gif' && samples.length * SLIDE_SECONDS > config.video.maxGifSeconds) {
      throw new ToolError(
        `The slideshow is ${samples.length * SLIDE_SECONDS} seconds long. Walkthrough makes GIF files of up to ${config.video.maxGifSeconds} seconds (maxGifSeconds). Use format mp4 or webm.`,
        'video_too_long',
      );
    }
    const width = format === 'gif' ? config.video.gifWidth : config.video.width;
    const videoDir = join(store.dir, 'video');
    mkdirSync(videoDir, { recursive: true });
    const out = await encodeVideo({
      config,
      framesDir: dir,
      samples,
      format,
      outFile: join(videoDir, `slideshow.${format}`),
      title: store.run.name,
      width,
      height: Math.round((width * 10) / 16),
    });
    const preview = readFileSync(join(dir, (samples[0] as Sample).file)).toString('base64');
    const { lines, copied } = describeSaved(config.projectDir, out, format, target);
    lines.push(`It shows ${samples.length} screenshot(s) from the run "${store.run.name}".`);
    store.run.videos = [
      ...(store.run.videos ?? []).filter((v) => v.name !== 'slideshow'),
      {
        file: relative(store.dir, out.file),
        format: out.format,
        seconds: Math.round(out.seconds * 10) / 10,
        bytes: out.bytes,
        name: 'slideshow',
        ...(copied ? { path: copied } : {}),
      },
    ];
    store.save();
    const ext = extname((samples[0] as Sample).file);
    const previewType = ext === '.png' ? 'image/png' : ext === '.webp' ? undefined : 'image/jpeg';
    return { lines, preview: previewType ? preview : undefined, previewType, store };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
