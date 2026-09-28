import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { checkMediaPath } from '../guards/paths.js';
import { onShutdown } from '../lifecycle.js';
import { adhocVideoDir, fileStamp } from '../project-files.js';
import { RunStore } from '../run/run-store.js';
import { VideoCapture } from './capture.js';
import { encodeVideo } from './encoder.js';
import { chooseFormat, type VideoFormat } from './formats.js';
import { buildSamples } from './timeline.js';

// Pictures each second in WebM and MP4. GIF uses the gifFps setting.
const VIDEO_FPS = 15;

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
  dropVideo(ctx);
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
export function dropVideo(ctx: Context): void {
  if (!ctx.video) return;
  void ctx.video.capture.stop().catch(() => undefined);
  ctx.video.capture.discard();
  ctx.video.forget();
  ctx.video = undefined;
}

export interface SavedVideo {
  lines: string[];
  // A JPEG picture from the middle of the video, as base64.
  preview?: string;
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
    dropVideo(ctx);
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

  const shown = (file: string) => relative(config.projectDir, file);
  const lines = [
    `Saved the video (${out.format.toUpperCase()}, ${out.seconds.toFixed(1)} seconds, ${size(out.bytes)}, ${out.width}x${out.height}): ${shown(out.file)}`,
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
  return { lines, preview, store };
}
