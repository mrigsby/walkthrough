import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Config } from '../config.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { checkMediaPath } from '../guards/paths.js';
import { buildVars } from '../page/tokens.js';
import { fileStamp } from '../project-files.js';
import type { Plan } from '../run/plan-schema.js';
import { loadRunPlan } from '../run/plans.js';
import { latestRunId, type Run, RunStore } from '../run/run-store.js';
import { openBrowser } from '../tools/browser-tools.js';
import { VideoCapture } from '../video/capture.js';
import { encodeVideo } from '../video/encoder.js';
import { chooseFormat, type VideoFormat } from '../video/formats.js';
import { liveCaptures, size } from '../video/recording.js';
import { buildSamples } from '../video/timeline.js';
import { ReplayEngine, StepError, sleep } from './engine.js';
import { buildOps } from './ops.js';
import { Rebaser } from './rebase.js';
import { VideoStage } from './stage.js';

// How fast a replay goes. Typing is per character. The pointer glides before each action,
// and each step holds at its end, so viewers can see the result.
export const PACES = {
  slow: { typeMs: 90, glideMs: 600, holdMs: 1800 },
  normal: { typeMs: 50, glideMs: 400, holdMs: 1200 },
  fast: { typeMs: 20, glideMs: 200, holdMs: 700 },
} as const;
export type Pace = keyof typeof PACES;

// Pictures each second in WebM and MP4. GIF uses the gifFps setting.
const VIDEO_FPS = 15;

export interface ReplayInput {
  runId?: string;
  formats?: VideoFormat[];
  paths?: string[];
  pace: Pace;
  session?: string;
  captions?: boolean;
  pointer?: boolean;
  titleCard?: boolean;
  width?: number;
  // Called at the start of each step, for progress notes.
  onStep?: (text: string) => void;
}

export interface ReplayResult {
  ok: boolean;
  lines: string[];
  preview?: string;
  previewType?: string;
  store: RunStore;
}

// Values for {{var:NAME}} in a replay: the run's own values, with the vars of the
// environment in use on top, so a replay elsewhere uses that environment's values.
export function replayVars(run: Run, config: Config): Record<string, string> {
  return { ...run.vars, ...buildVars(config, planOf(run, config)?.vars) };
}

function planOf(run: Run, config: Config): Plan | undefined {
  return loadRunPlan(config.projectDir, run.planFile);
}

// Records a finished run again in a new login, at an even pace, and saves the video.
export async function replayRun(ctx: Context, input: ReplayInput): Promise<ReplayResult> {
  const config = await ctx.config();
  if (ctx.run?.run.status === 'running') {
    throw new ToolError('A run is going. Call run_finish first, then replay it.', 'run_active');
  }
  if (liveCaptures(ctx).length > 0) {
    throw new ToolError('A video is recording. Call video with action stop first.', 'video_active');
  }
  const id = input.runId ?? latestRunId(config.projectDir, { finishedOnly: true });
  if (!id) throw new ToolError('There is no finished run to replay.', 'no_run');
  const store = RunStore.open(config.projectDir, id);
  const run = store.run;
  // A plan can say where it may run.
  const allowed = planOf(run, config)?.environments;
  if (allowed && !allowed.includes(config.environment.name)) {
    throw new ToolError(
      `The plan of this run may run only in these environments: ${allowed.join(', ')}. The session uses "${config.environment.name}".`,
      'environment_not_allowed',
    );
  }
  const plan = buildOps(run);
  if (plan.missingSelectors.length) {
    throw new ToolError(
      [
        `Walkthrough cannot replay the run "${run.name}", because these actions have no stable selector:`,
        ...plan.missingSelectors.map((m) => `- ${m}`),
        'Add an exact action to these plan steps, and run the plan again.',
      ].join('\n'),
      'replay_blocked',
    );
  }
  if (!plan.steps.some((s) => s.ops.some((o) => o.type === 'action'))) {
    throw new ToolError(`The run "${run.name}" has no actions to replay.`, 'nothing_to_do');
  }

  // The formats to make, and the exact files. A path adds its own format.
  const targets = (input.paths ?? []).map((p) => ({
    format: chooseFormat(undefined, p, config.video.runFormat),
    ...checkMediaPath(p, config.projectDir, config.screenshotRoots),
  }));
  const formats = [...new Set([...(input.formats ?? []), ...targets.map((t) => t.format)])];
  if (formats.length === 0) formats.push(config.video.runFormat);

  if (!ctx.driver?.alive) await openBrowser(ctx, {});
  const driver = ctx.requireDriver();
  const width = input.width ?? config.video.width;
  const pace = PACES[input.pace];
  let capture: VideoCapture | undefined;
  const replay = new ReplayEngine({
    driver,
    config,
    secrets: await ctx.secrets(),
    vars: replayVars(run, config),
    pace,
    stage: new VideoStage(() => capture, input.captions ?? config.video.captions),
    rebase: Rebaser.forRun(run, config),
  });

  const failure = async (stepTitle: string, message: string): Promise<ReplayResult> => {
    const lines = [
      `The replay stopped at step ${stepTitle}: ${message}`,
      'Walkthrough saved no video. Fix the step or the app, and replay again.',
    ];
    let preview: string | undefined;
    try {
      const shot = await replay.tab.page.screenshot({ type: 'jpeg', quality: 80 });
      preview = Buffer.from(shot).toString('base64');
      const file = join(store.dir, 'video', `replay-failed-${fileStamp('step')}.jpg`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, shot);
      lines.push(`Screenshot: ${relative(config.projectDir, file)}`);
    } catch {}
    return { ok: false, lines, preview, previewType: preview ? 'image/jpeg' : undefined, store };
  };

  try {
    // The run's screen and settings. Without a device, a fixed 16:10 size.
    await replay.open({
      emulation: run.emulation,
      width,
      session: input.session ?? run.session,
      startUrl: run.baseUrl ?? config.baseUrl,
    });

    capture = new VideoCapture(driver, { maxWidth: width, showPanel: false });
    await capture.start();
    for (const stepOps of plan.steps) {
      const { step } = stepOps;
      input.onStep?.(`Step ${step.index}: ${step.title}`);
      const outcome = await replay.runStep(stepOps);
      if (!outcome.ok) return await failure(`${step.index} "${step.title}"`, outcome.message);
      await sleep(pace.holdMs);
    }
    await capture.stop();

    // A replay has no wait time to cut. All of it plays at normal speed.
    const events = [
      ...capture.events,
      { type: 'activity' as const, start: capture.startedAt, end: capture.stoppedAt ?? Date.now() },
    ];
    const lines: string[] = [];
    const videoDir = join(store.dir, 'video');
    mkdirSync(videoDir, { recursive: true });
    const stamp = fileStamp('replay');
    let preview: string | undefined;
    for (const format of formats) {
      const samples = buildSamples(capture.frames, events, {
        start: capture.startedAt,
        end: capture.stoppedAt ?? Date.now(),
        fps: format === 'gif' ? config.video.gifFps : VIDEO_FPS,
        idleSeconds: config.video.idleSeconds,
        pointer: input.pointer ?? config.video.pointer,
        captions: input.captions ?? config.video.captions,
        glideMs: pace.glideMs,
      });
      const seconds = samples.reduce((sum, s) => sum + s.duration, 0);
      if (format === 'gif' && seconds > config.video.maxGifSeconds) {
        lines.push(
          `Walkthrough made no GIF, because the replay is ${Math.round(seconds)} seconds long. GIF files can be up to ${config.video.maxGifSeconds} seconds (maxGifSeconds).`,
        );
        continue;
      }
      const middle = samples[Math.floor(samples.length / 2)];
      if (!preview && middle)
        preview = readFileSync(join(capture.dir, middle.file)).toString('base64');
      const out = await encodeVideo({
        config,
        framesDir: capture.dir,
        samples,
        format,
        outFile: join(videoDir, `${stamp}.${format}`),
        title: (input.titleCard ?? true) ? run.name : undefined,
        width: format === 'gif' ? config.video.gifWidth : width,
      });
      lines.push(
        `Saved the replay (${out.format.toUpperCase()}, ${out.seconds.toFixed(1)} seconds, ${size(out.bytes)}, ${out.width}x${out.height}): ${relative(config.projectDir, out.file)}`,
      );
      if (out.note) lines.push(out.note);
      const copies: string[] = [];
      for (const target of targets.filter((t) => t.format === out.format)) {
        mkdirSync(dirname(target.path), { recursive: true });
        copyFileSync(out.file, target.path);
        copies.push(target.display);
        lines.push(`Also saved it to ${target.display}. It replaced any file that was there.`);
      }
      run.videos ??= [];
      run.videos.push({
        file: relative(store.dir, out.file),
        format: out.format,
        seconds: Math.round(out.seconds * 10) / 10,
        bytes: out.bytes,
        name: 'replay',
        ...(copies[0] ? { path: copies[0] } : {}),
      });
    }
    store.save();
    lines.push(
      `The replay used a new login and a new {{unique}} value (${replay.unique}), at the ${input.pace} pace.`,
    );
    return { ok: true, lines, preview, previewType: preview ? 'image/jpeg' : undefined, store };
  } catch (error) {
    if (error instanceof StepError) return failure('(setup)', error.message);
    throw error;
  } finally {
    await capture?.stop().catch(() => undefined);
    capture?.discard();
    await replay.dispose();
  }
}
