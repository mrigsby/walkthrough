import { basename, join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Context } from '../context.js';
import { describeEnvironment } from '../environments.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { log } from '../log.js';
import { TokenResolver } from '../page/tokens.js';
import { handoutData, handoutFolder, writeHandout } from '../presentation/handout.js';
import { LiveStage } from '../presentation/live-stage.js';
import { type PresenterControls, PresenterWindow } from '../presentation/presenter-window.js';
import { PresentationRecorder, type RecordOptions } from '../presentation/recorder.js';
import {
  executionHash,
  findRehearsal,
  rehearsalProblems,
  slideProblems,
} from '../presentation/rehearsal.js';
import { type AudienceScreen, PresentationRunner } from '../presentation/runner.js';
import {
  type Command,
  PresentationSession,
  type PresentEvent,
  type PresentStep,
} from '../presentation/session.js';
import { ReplayEngine } from '../replay/engine.js';
import { buildOps, opsByStep } from '../replay/ops.js';
import { Rebaser } from '../replay/rebase.js';
import { PACES, replayVars } from '../replay/replayer.js';
import { NullStage } from '../replay/stage.js';
import { durationSeconds } from '../run/plan-schema.js';
import { loadPlan } from '../run/plans.js';
import { type Run, RunStore } from '../run/run-store.js';
import { liveCaptures, size } from '../video/recording.js';
import { startProgress } from './developer-tools.js';
import { runTool } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// The hosts of the app, for Chrome's zoom. A wildcard origin cannot have a zoom.
function appHosts(config: Config): string[] {
  const hosts = new Set<string>();
  for (const origin of [config.baseUrl, ...config.allowedOrigins]) {
    if (!origin || origin.includes('*')) continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {}
  }
  return [...hosts];
}

// The presentation of this server, and the work that ends it.
let current:
  | {
      session: PresentationSession;
      done: Promise<void>;
      kiosk: boolean;
      presenterOpen: () => boolean;
      openPresenter: () => Promise<void>;
      endedAt: () => number | undefined;
      // What the end wrote: the handout and the recording.
      after: () => string[];
    }
  | undefined;

const COMMANDS = [
  'start',
  'continue',
  'skip',
  'retry',
  'manual',
  'back',
  'jump',
  'blank',
  'title',
  'presenter',
  'end',
] as const;

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stepLine(session: PresentationSession, i: number): string {
  const step = session.steps[i];
  return step ? `step ${step.index} of ${session.steps.length}: "${step.title}"` : 'the end screen';
}

// Where the presentation is, in plain words.
function statusText(session: PresentationSession): string {
  const step = session.steps[session.current];
  const next = session.steps[session.current + 1];
  const env = session.info.environment;
  const elapsed = session.startedAt ? Date.now() - session.startedAt : 0;
  const budget = session.info.timeBudgetSec;
  return [
    `Presentation: ${session.info.name}. Environment: ${env.name}${env.baseUrl ? ` (${env.baseUrl})` : ''}. Rehearsal: ${session.info.runId}.`,
    `State: ${session.state}, at ${session.state === 'title' ? 'the title slide' : stepLine(session, session.current)}.${session.blank ? ' The audience screen is blank.' : ''}${session.titleShown ? ' The title slide shows.' : ''}`,
    ...(session.confirmNeeded
      ? [
          `Waiting: the presenter must confirm the protected environment "${session.confirmNeeded.name}" in the presenter window.`,
        ]
      : []),
    ...(session.info.kiosk
      ? []
      : [
          session.presenterOpen
            ? 'The presenter window is open.'
            : 'The presenter window is closed. Use control "presenter" to open it again.',
        ]),
    ...(step?.notes && session.state !== 'title' ? [`Notes: ${step.notes}`] : []),
    ...(next && session.state !== 'end' ? [`Next: step ${next.index} "${next.title}".`] : []),
    ...(session.failure
      ? [`Failed: step ${session.failure.step}: ${session.failure.message}`]
      : []),
    `Time: ${session.startedAt ? clock(elapsed) : 'not started'}${budget ? ` of ${clock(budget * 1000)}` : ''}.`,
    `Chat: ${session.chat.filter((c) => c.question).length} question(s). ${session.listening ? 'You are listening.' : 'Nobody is listening now.'}`,
  ].join('\n');
}

function eventText(session: PresentationSession, event: PresentEvent): string {
  if (event.type === 'ended') {
    return 'status: ended\nThe presentation ended. Stop listening. Call present with action "stop" to get the summary and the handout.';
  }
  const step = session.steps[session.current];
  const context = [
    `Now: ${session.state === 'title' ? 'the title slide' : stepLine(session, session.current)}.`,
    ...(step?.notes ? [`Notes of this step: ${step.notes}`] : []),
    `Environment: ${describeEnvironment(session.info.environment)}.`,
  ];
  if (event.type === 'step_failed') {
    return [
      'status: step_failed',
      `Step ${event.step} did not work: ${event.message}`,
      ...context,
      'The presenter can retry, skip, or do the step by hand. To help, look at the page with snapshot or read. Then send a short note with present action "answer" and no id. Then call present with action "listen" again.',
    ].join('\n');
  }
  return [
    'status: question',
    `Question ${event.id} from the presenter:`,
    untrusted(event.text),
    ...context,
    `Answer with present action "answer", id "${event.id}", and 1 to 3 short sentences in plain text. You can use snapshot, read, and the project code first. Then call present with action "listen" again.`,
  ].join('\n');
}

// Waits a moment for the runner to take a command, so the reply shows the new state.
function changeSoon(session: PresentationSession, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = session.watch(() => {
      clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

async function startPresentation(
  ctx: Context,
  input: { plan?: string; runId?: string; environment?: string; kiosk?: boolean },
  extra: Extra,
): Promise<string> {
  if (current?.session.active) {
    throw new ToolError(
      'A presentation is going already. Call present with action "stop" first.',
      'presentation_active',
    );
  }
  if (ctx.run?.run.status === 'running') {
    throw new ToolError(
      `The run "${ctx.run.run.name}" is still going. Call run_finish first.`,
      'run_active',
    );
  }
  if (liveCaptures(ctx).length > 0) {
    throw new ToolError('A video is recording. Call video with action stop first.', 'video_active');
  }
  if (ctx.driver?.alive && ctx.driver.mode === 'attached') {
    throw new ToolError(
      'Walkthrough uses your own Chrome now. A presentation needs a Chrome of its own. Call browser_close first.',
      'attached',
    );
  }
  if (!input.plan) throw new ToolError('Give the name of the plan to present.', 'bad_input');
  const lines = input.environment
    ? await ctx.useEnvironment(input.environment, { source: 'tool' })
    : [];
  const config = await ctx.config();
  const { file, plan } = loadPlan(config.projectDir, input.plan);
  const env = config.environment;
  if (plan.environments && !plan.environments.includes(env.name)) {
    throw new ToolError(
      `The plan "${plan.name}" may run only in these environments: ${plan.environments.join(', ')}. The session uses "${env.name}".`,
      'environment_not_allowed',
    );
  }
  const slides = slideProblems(plan, config.projectDir);
  if (slides.length) {
    throw new ToolError(
      `The presentation cannot show these slides:\n${slides.map((s) => `- ${s}`).join('\n')}`,
      'slide_blocked',
    );
  }

  // The rehearsal: a run of this plan that can be presented.
  let run: Run | undefined;
  if (input.runId) {
    run = RunStore.open(config.projectDir, input.runId).run;
    const problems = rehearsalProblems(run, plan);
    if (run.planHash && run.planHash !== executionHash(plan))
      problems.push('The steps of the plan changed after this run.');
    if (problems.length) {
      throw new ToolError(
        `The run ${run.id} cannot be presented:\n${problems.map((p) => `- ${p}`).join('\n')}`,
        'not_presentable',
      );
    }
  } else {
    run = findRehearsal(config.projectDir, file, plan, env.name);
    if (!run) {
      throw new ToolError(
        `There is no good rehearsal of "${plan.name}" on ${env.name} from the last 12 hours. Rehearse first: call run_start with plan "${input.plan}" and mode "autonomous", do and check every step, and call run_finish. Then call present again.`,
        'no_rehearsal',
      );
    }
  }

  const settings = plan.presentation ?? {};
  const kiosk = Boolean(input.kiosk ?? settings.kiosk);

  // A protected environment needs a person's OK first. In a talk, the presenter gives it in
  // the presenter window, before the app opens. A kiosk has nobody there, so it asks now.
  let confirmed = !env.protected;
  const allowed = (process.env.UIWALK_ALLOW_PROTECTED ?? '').split(',').map((s) => s.trim());
  if (!confirmed && allowed.includes(env.name)) confirmed = true;
  const presenterConfirms = !confirmed && !kiosk;
  const ask = ctx.elicit?.();
  if (!confirmed && !presenterConfirms && ask) {
    const answer = await ask(
      `Present on the "${env.name}" environment (${env.baseUrl})? The presentation can create real data there.`,
      { timeoutMs: 300_000, signal: extra.signal, relatedRequestId: extra.requestId },
    );
    if (answer !== 'yes') {
      await ctx.finishSwitch(false);
      throw new ToolError(
        `The developer did not confirm the "${env.name}" environment.`,
        'protected_unconfirmed',
      );
    }
    confirmed = true;
  }
  if (!confirmed && !presenterConfirms) {
    await ctx.finishSwitch(false);
    throw new ToolError(
      `"${env.name}" is a protected environment. A kiosk presentation there needs the developer's OK: through the MCP client, or with UIWALK_ALLOW_PROTECTED=${env.name}.`,
      'protected_unconfirmed',
    );
  }

  // A new Chrome, with the audience window first.
  if (ctx.driver?.alive) await ctx.driver.close();
  const zoom =
    settings.pageZoom && settings.pageZoom !== 1 && !settings.device
      ? { factor: settings.pageZoom, hosts: appHosts(config) }
      : undefined;
  const driver = await ctx.startDriver(undefined, {
    launch: {
      presentation: {
        ...(settings.window ?? { width: 1280, height: 800 }),
        ...(zoom ? { zoom } : {}),
      },
    },
    panel: false,
  });
  if (confirmed) ctx.confirmFor(env.name);
  await ctx.finishSwitch(true);
  const audience = driver.activeTab();

  const ops = opsByStep(buildOps(run));
  const secrets = await ctx.secrets();
  const vars = replayVars(run, config);
  const pace = PACES[settings.pace ?? 'normal'];
  const abort = new AbortController();
  const engine = new ReplayEngine({
    driver,
    config,
    secrets,
    vars,
    pace,
    stage: new NullStage(),
    rebase: Rebaser.forRun(run, config),
    signal: abort.signal,
  });
  const show = (text: string) => new TokenResolver(engine.unique, vars).display(text);
  const steps: PresentStep[] = plan.steps.map((step, i) => {
    const id = step.id ?? `step-${i + 1}`;
    return {
      index: i + 1,
      id,
      title: show(step.do),
      ...(step.caption ? { caption: show(step.caption) } : {}),
      ...(step.notes ? { notes: show(step.notes) } : {}),
      ...(step.slide ? { slide: step.slide } : {}),
      hasAction: Boolean(ops.get(id)?.ops.some((o) => o.type === 'action')),
      pause: step.pause ?? settings.pause !== 'none',
      spotlight: step.spotlight ?? settings.spotlight ?? true,
      ...(step.zoom ? { zoom: step.zoom } : {}),
      ...(step.timeBudget ? { timeBudgetSec: durationSeconds(step.timeBudget) } : {}),
    };
  });
  const session = new PresentationSession(
    steps,
    {
      name: plan.name,
      runId: run.id,
      environment: { name: env.name, label: env.label, color: env.color, baseUrl: env.baseUrl },
      kiosk,
      ...(settings.timeBudget ? { timeBudgetSec: durationSeconds(settings.timeBudget) } : {}),
    },
    abort,
  );
  if (presenterConfirms) session.confirmNeeded = { name: env.name, label: env.label };
  // The audience screen draws slides, the pointer, and the spotlight.
  const stage = new LiveStage(audience, session, {
    projectDir: config.projectDir,
    planName: plan.name,
    captions: settings.captions ?? true,
    pointer: settings.pointer ?? true,
    mask: settings.mask ?? [],
    title: settings.title,
    end: settings.end,
    fullscreen: settings.fullscreen,
  });
  stage.useEngine(engine);
  engine.stage = stage;
  await stage.install();
  const openApp = () =>
    engine.open({
      mainTab: audience,
      emulation: settings.device ? run.emulation : undefined,
      session: run.session,
      startUrl: run.baseUrl ?? config.baseUrl,
    });
  if (!presenterConfirms) await openApp();

  // The presenter window: controls, notes, the time, a mirror, and the chat.
  let presenter: PresenterWindow | undefined;
  let confirming = false;
  const controls: PresenterControls = {
    confirm: async () => {
      if (!session.confirmNeeded || confirming) return;
      confirming = true;
      try {
        ctx.confirmFor(env.name);
        await openApp();
        session.confirmed();
      } catch (error) {
        presenter?.notice(`The app did not open: ${(error as Error).message}`);
        session.stop();
      } finally {
        confirming = false;
      }
    },
    cancel: () => session.stop(),
    toggleFullscreen: () => stage.toggleFullscreen(),
    moveToScreen: (screen) => stage.moveToScreen(screen),
  };
  const openPresenter = async () => {
    presenter = await PresenterWindow.open(driver, session, {
      audience: audience.page,
      mirror: settings.mirror ?? true,
      protectedEnv: env.protected,
      controls,
    });
  };
  if (!kiosk) await openPresenter();
  // Closing the audience window, or Chrome, ends the presentation.
  audience.page.once('close', () => session.stop());
  driver.emitter.once('closed', () => session.stop());

  ctx.presentation = session;
  // The recording, and a picture of each step for the handout. A kiosk has neither.
  const record = kiosk ? undefined : settings.record;
  const recorder = record ? new PresentationRecorder(driver, session, config) : undefined;
  await recorder?.start();
  const frames = new Map<number, Buffer>();
  const snapshot = async (i: number) => {
    const cdp = audience.cdp;
    if (!cdp) return;
    // A plain screenshot of the window. It does not change the page, so nothing flickers.
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
      captureBeyondViewport: false,
    });
    frames.set(i, Buffer.from(data, 'base64'));
  };
  // The curtain of a jump is cut from the recording.
  const screen: AudienceScreen = {
    title: () => stage.title(),
    slide: (step) => stage.slide(step),
    end: () => stage.end(),
    clear: () => stage.clear(),
    gate: (step, stepOps) => stage.gate(step, stepOps),
    curtain: async (on) => {
      if (on) recorder?.curtain(true);
      await stage.curtain(on);
      if (!on) recorder?.curtain(false);
    },
  };

  const runner = new PresentationRunner(session, engine, ops, {
    pace,
    screen,
    ...(kiosk ? {} : { snapshot }),
    ...(kiosk
      ? {
          kiosk: {
            holdMs: (settings.kiosk?.holdSeconds ?? 6) * 1000,
            loop: settings.kiosk?.loop ?? false,
            loops: settings.kiosk?.loops ?? 100,
          },
        }
      : {}),
  });
  // The presentation goes on in the background. The tools stay free for the chat.
  let endedAt: number | undefined;
  let after: string[] = [];
  const done = runner
    .run()
    .catch((error) => log.error('the presentation stopped', error))
    .finally(async () => {
      endedAt = Date.now();
      await recorder?.stop().catch(() => undefined);
      await presenter?.close();
      stage.dispose();
      await engine.dispose().catch(() => undefined);
      await driver.close().catch(() => undefined);
      if (ctx.presentation === session) ctx.presentation = undefined;
      if (kiosk) return;
      after = await saveHandout({
        projectDir: config.projectDir,
        runId: run.id,
        session,
        frames,
        endedAt,
        redact: (text) => secrets.redact(text),
        recorder,
        record: typeof record === 'object' ? record : {},
      }).catch((error) => {
        recorder?.discard();
        return [`Walkthrough did not write the handout: ${(error as Error).message}`];
      });
    });
  current = {
    session,
    done,
    kiosk,
    presenterOpen: () => Boolean(presenter?.isOpen),
    openPresenter,
    endedAt: () => endedAt,
    after: () => after,
  };

  return [
    ...lines,
    `The presentation "${plan.name}" is ready on ${describeEnvironment(env)}. It plays the rehearsal ${run.id}.`,
    `It has ${steps.length} step(s).${kiosk ? ' It runs by itself (kiosk).' : ' It waits for the presenter before each step.'}`,
    ...(presenterConfirms
      ? [
          `"${env.name}" is a protected environment. The presenter must confirm it in the presenter window before the app opens.`,
        ]
      : []),
    kiosk
      ? 'Call present with action "stop" to end it.'
      : 'The audience window shows the title. The presenter window has the controls, the notes, and the chat. When the presenter asks you, use present with action "control".',
    'Now call present with action "listen", and answer each question with action "answer". Keep listening until listen says "ended".',
  ].join('\n');
}

// Writes the handout, after the recording, so the handout can show the video.
async function saveHandout(o: {
  projectDir: string;
  runId: string;
  session: PresentationSession;
  frames: Map<number, Buffer>;
  endedAt: number;
  redact: (text: string) => string;
  recorder?: PresentationRecorder;
  record: RecordOptions;
}): Promise<string[]> {
  const { session } = o;
  if (!session.startedAt) {
    o.recorder?.discard();
    return ['The presentation did not start, so Walkthrough wrote no handout.'];
  }
  const store = RunStore.open(o.projectDir, o.runId);
  const dir = join(
    store.dir,
    'presentations',
    handoutFolder(session.startedAt, session.info.environment.name),
  );
  const data = handoutData(session, o.frames, o.redact, o.endedAt);
  const lines: string[] = [];
  if (o.recorder) {
    const saved = await o.recorder.save(dir, o.record);
    if (saved.out) {
      data.video = { file: basename(saved.out.file), seconds: saved.out.seconds };
      lines.push(
        `Recording: ${relative(o.projectDir, saved.out.file)} (${saved.out.format.toUpperCase()}, ${clock(saved.out.seconds * 1000)}, ${size(saved.out.bytes)}).`,
      );
    }
    if (saved.copied) lines.push(`Also saved the recording to ${saved.copied}.`);
    if (saved.note) {
      data.videoNote = saved.note;
      lines.push(saved.note);
    }
  }
  const files = writeHandout(dir, data);
  lines.unshift(
    `Handout: ${relative(o.projectDir, files.html)} and ${relative(o.projectDir, files.md)}.`,
  );
  return lines;
}

async function stopPresentation(extra: Extra): Promise<string> {
  const live = current;
  if (!live) return 'No presentation is going.';
  const { session } = live;
  session.stop();
  // The handout and the recording can take a while to save.
  const stopProgress = startProgress(extra, 'Walkthrough saves the handout of the presentation.');
  try {
    await Promise.race([live.done, new Promise((resolve) => setTimeout(resolve, 600_000))]);
  } finally {
    stopProgress();
  }
  const shown = new Set([...session.stepTimes.keys()].filter((i) => i < session.steps.length));
  const minutes = session.startedAt
    ? clock((live.endedAt() ?? Date.now()) - session.startedAt)
    : '0:00';
  return [
    `The presentation "${session.info.name}" ended. It showed ${shown.size} of ${session.steps.length} step(s) in ${minutes}.`,
    `Chat: ${session.chat.filter((c) => c.question).length} question(s), ${session.chat.filter((c) => c.answer).length} answer(s).`,
    ...live.after(),
  ].join('\n');
}

export function registerPresentTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'present',
    {
      title: 'Present',
      description: [
        'Play a plan as a live presentation for an audience, with /walkthrough:present.',
        'start opens a new Chrome with the audience window, and plays a rehearsal run of the plan. The presentation runs in the background. It waits before each step until the presenter goes on.',
        'listen waits for a question from the presenter, a failed step, or the end. Answer a question with answer, in 1 to 3 short sentences. Then listen again.',
        'status shows where the presentation is. control moves it, only when the presenter asks you: continue, skip, retry, manual, back, jump, blank, or end. stop ends it.',
        'While a presentation is going, only tools that read the page work.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['start', 'status', 'control', 'listen', 'answer', 'stop']),
        plan: z
          .string()
          .optional()
          .describe('For start: the plan to present, like "checkout-tour".'),
        runId: z
          .string()
          .optional()
          .describe(
            'For start: the rehearsal run to play. The default is a good rehearsal of the plan from the last 12 hours.',
          ),
        environment: z
          .string()
          .optional()
          .describe(
            'For start: present on this environment, like "staging". It switches the session.',
          ),
        kiosk: z
          .boolean()
          .optional()
          .describe('For start: run without a presenter. Each step holds for a few seconds.'),
        command: z
          .enum(COMMANDS)
          .optional()
          .describe(
            'For control: start, continue, skip (the step), retry (a failed step), manual (the presenter does it by hand), back, jump (with step), blank (the audience screen, on or off), title (the title slide, on or off), presenter (open the presenter window again), or end.',
          ),
        step: z.number().int().min(1).optional().describe('For control jump: the step number.'),
        id: z
          .string()
          .optional()
          .describe('For answer: the question id, like "q2". Leave it out for a note.'),
        text: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('For answer: 1 to 3 short sentences in plain text.'),
        onScreen: z
          .boolean()
          .optional()
          .describe('For answer: also show the answer on the audience screen.'),
      },
    },
    (input, extra) =>
      runTool(
        ctx,
        'present',
        async () => {
          if (input.action === 'start') return startPresentation(ctx, input, extra);
          if (input.action === 'stop') return stopPresentation(extra);
          const session = current?.session;
          if (!session?.active) {
            if (input.action === 'listen') return 'status: ended\nNo presentation is going.';
            return 'No presentation is going. Call present with action "start".';
          }
          if (input.action === 'status') return statusText(session);

          if (input.action === 'answer') {
            if (!input.text) throw new ToolError('Give the text of the answer.', 'bad_input');
            try {
              const entry = session.answer(input.id, input.text, input.onScreen);
              return `The presenter sees the ${entry.question ? 'answer' : 'note'} in the chat${input.onScreen ? ', and the audience sees it on the screen' : ''}. Call present with action "listen" again.`;
            } catch (error) {
              throw new ToolError((error as Error).message, 'bad_input');
            }
          }

          if (input.action === 'listen') {
            const config = await ctx.config();
            const timeoutSec =
              config.askTimeoutSec ?? (ctx.clientName() === 'claude-code' ? 300 : 50);
            const stopProgress = startProgress(extra, 'Walkthrough waits for the presenter.');
            try {
              const outcome = await session.listen(timeoutSec * 1000, extra.signal);
              if (outcome.kind === 'event') return eventText(session, outcome.event);
              if (outcome.kind === 'timeout')
                return `status: waiting\nNo question after ${timeoutSec} seconds. Call present with action "listen" again.`;
              if (outcome.kind === 'superseded')
                return 'status: superseded\nA newer listen call took over. Do not call listen again from this one.';
              return 'status: canceled\nWalkthrough stopped listening. The presentation goes on.';
            } finally {
              stopProgress();
            }
          }

          // control
          if (!input.command) throw new ToolError('Give a command for control.', 'bad_input');
          if (input.command === 'blank') {
            session.setBlank(!session.blank);
            return `The audience screen is ${session.blank ? 'blank' : 'back'}.\n${statusText(session)}`;
          }
          if (input.command === 'title') {
            session.setTitleShown(!session.titleShown);
            return `The title slide ${session.titleShown ? 'shows' : 'is gone'}.\n${statusText(session)}`;
          }
          if (input.command === 'presenter') {
            const live = current;
            if (!live || live.kiosk)
              throw new ToolError('A kiosk presentation has no presenter window.', 'bad_command');
            if (live.presenterOpen()) return 'The presenter window is open already.';
            await live.openPresenter();
            return 'The presenter window is open again.';
          }
          const command = (
            input.command === 'jump'
              ? { type: 'jump', step: input.step ?? 0 }
              : { type: input.command }
          ) as Command;
          if (command.type === 'jump' && !input.step)
            throw new ToolError('Give the step number for jump.', 'bad_input');
          const problem = session.check(command);
          if (problem) throw new ToolError(problem, 'bad_command');
          session.command(command);
          await changeSoon(session, 2000);
          return statusText(session);
        },
        {
          // These wait for a person or only read, so they run next to the other tools.
          exclusive: !['status', 'control', 'listen', 'answer'].includes(input.action),
          action: input.action,
        },
      ),
  );
}
