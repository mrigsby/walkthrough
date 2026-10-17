import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Driver, Tab } from '../browser/driver.js';
import type { Context } from '../context.js';
import { inspectElement } from '../devtools/inspect.js';
import { ToolError } from '../errors.js';
import { elementRect, withCleanPage } from '../evidence/annotate.js';
import { networkDir, writeHar } from '../evidence/har.js';
import { formatLogs, LOG_KINDS, type LogLevel } from '../evidence/logs.js';
import type { NetEntry } from '../evidence/network.js';
import { takeScreenshot } from '../evidence/screenshot.js';
import { checkPanelImage } from '../guards/paths.js';
import { untrusted } from '../guards/untrusted.js';
import type { Answer, PointedElement, Question, Rect } from '../panel/controller.js';
import { type Snippets, snippetsSchema, stepPanelSchema } from '../panel/panel-schema.js';
import { buildStepView, type PanelLayer, type SnippetText, viewText } from '../panel/view.js';
import { isProblem } from '../report/common.js';
import { stepTitle } from '../run/plan-schema.js';
import { nextStepHint, recordResult, recordTry } from '../run/record.js';
import { slug } from '../text.js';
import { bugClip, liveCaptures } from '../video/recording.js';
import { type Content, runTool, textResult } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// What the developer said about one step. Test runs use these later.
export interface StepAnswer {
  at: string;
  question: Question;
  answer: Answer;
  screenshot?: string;
  files?: string[];
  logs: string;
}

// Claude Code waits a long time for a tool. Other clients often stop after 60 seconds.
function defaultAskTimeoutSec(clientName?: string): number {
  return clientName === 'claude-code' ? 300 : 50;
}

// Saves a screenshot with a red box around the element of the last action,
// or around the element that the developer pointed at.
export async function bugScreenshot(
  ctx: Context,
  driver: Driver,
  tab: Tab,
  stepLabel: string,
  pointed?: Rect,
) {
  const config = await ctx.config();
  const last = driver.lastTarget?.tabId === tab.id ? driver.lastTarget : undefined;
  const rect = pointed ?? (last ? await elementRect(last.handle) : undefined);
  return withCleanPage(driver, tab, { annotate: rect }, () =>
    takeScreenshot(tab, ctx.evidenceDir(config.projectDir), config.projectDir, {
      label: `bug-${stepLabel}`,
    }),
  );
}

// Saves the requests of a step as a HAR file. Returns its path from the project folder.
export async function bugHar(
  ctx: Context,
  entries: NetEntry[],
  stepLabel: string,
): Promise<string | undefined> {
  if (entries.length === 0) return undefined;
  const config = await ctx.config();
  const file = writeHar(
    networkDir(ctx, config.projectDir),
    `step-${stepLabel}`,
    entries,
    await ctx.secrets(),
  );
  return relative(config.projectDir, file);
}

// Where the pointed element is now. The page may have moved it since the click.
async function pointedRect(tab: Tab, point: PointedElement): Promise<Rect | undefined> {
  if (point.backendNodeId) {
    const cdp = await tab.page.createCDPSession();
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: point.backendNodeId });
      const xs = [0, 2, 4, 6].map((i) => model.border[i] ?? 0);
      const ys = [1, 3, 5, 7].map((i) => model.border[i] ?? 0);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch {
      // The element is gone. Try the selector.
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
  if (point.selector) {
    const handle = await tab.page.$(point.selector).catch(() => null);
    if (handle) return elementRect(handle);
  }
  return undefined;
}

// Saves the styles and CSS rules of the pointed element. Returns the file from the project.
async function pointedDetails(
  ctx: Context,
  tab: Tab,
  point: PointedElement,
  stepLabel: string,
): Promise<string | undefined> {
  if (!point.backendNodeId) return undefined;
  try {
    const text = await inspectElement(
      tab,
      { backendNodeId: point.backendNodeId },
      { rules: true, listeners: false, ancestors: false },
    );
    const config = await ctx.config();
    const file = join(
      ctx.evidenceDir(config.projectDir),
      `pointed-${slug(stepLabel, 40, 'step')}.txt`,
    );
    writeFileSync(file, (await ctx.secrets()).redact(text));
    return relative(config.projectDir, file);
  } catch {
    return undefined;
  }
}

// Sends "still waiting" progress, if the client asked for progress.
// Sends a progress note every 10 seconds, so the client keeps waiting.
export function startProgress(
  extra: Extra,
  message = 'Walkthrough waits for the developer to answer in the browser.',
): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: count,
          message,
        },
      })
      .catch(() => undefined);
  }, 10_000);
  return () => clearInterval(timer);
}

// Text for the panel: {{var:NAME}} and {{unique}} filled in, and no secret values.
async function panelText(ctx: Context, text: string | undefined): Promise<string | undefined> {
  if (text === undefined) return undefined;
  let shown = text;
  try {
    shown = ctx.display(text);
  } catch {
    // A {{var:NAME}} without a value stays as it is.
  }
  return (await ctx.secrets()).redact(shown);
}

// The question for the panel, from the agent's input and the plan step with that id.
async function buildQuestion(
  ctx: Context,
  input: {
    title?: string;
    didWhat?: string;
    expected?: string;
    next?: string;
    step?: number;
    total?: number;
    stepId?: string;
    panel?: PanelLayer;
    snippets?: Snippets;
    image?: string;
  },
) {
  const store = ctx.run?.run.status === 'running' ? ctx.run : undefined;
  const found = input.stepId ? store?.planStep(input.stepId) : undefined;
  const plan = found?.plan;
  const step = found?.step;
  // A plan with "next: { auto: true }" shows the next step when a step has no "next".
  // A card with "when" may not show, so it is not "next".
  const following = found
    ? plan?.steps.slice(found.index + 1).find((s) => !s.card?.when || s.card.when === 'always')
    : undefined;
  const autoNext =
    plan?.panel?.next?.auto && step && !step.next
      ? following
        ? stepTitle(following)
        : 'This is the last step.'
      : undefined;
  const card = step?.card;
  // A card with "when" shows only after a run with or without problems.
  if (card?.when && card.when !== 'always' && found && store) {
    const problems = store.run.steps.some((s) => s.index <= found.index && isProblem(s));
    if ((card.when === 'passed') === problems) {
      return {
        notShown: problems
          ? 'Not shown: the run had problems.'
          : 'Not shown: the run had no problems.',
      } as const;
    }
  }
  const title = await panelText(
    ctx,
    card ? stepTitle(step) : (input.title ?? (step ? stepTitle(step) : undefined)),
  );
  const didWhat = card ? undefined : await panelText(ctx, input.didWhat);
  const expected = card ? undefined : await panelText(ctx, input.expected ?? step?.expect);
  const next = await panelText(ctx, input.next ?? step?.next ?? autoNext);
  if (!title || (!found && (!didWhat || !expected))) {
    throw new ToolError(
      found
        ? 'Give a title for the step.'
        : 'Give a title, didWhat, and expected for the step. During a run, give the stepId of a plan step. Walkthrough then takes the title and expected from the plan.',
      'bad_input',
    );
  }
  // Snippets of the plan, the step, and this call. Later ones win.
  const snippets: Record<string, SnippetText> = {};
  for (const [name, snippet] of Object.entries({
    ...plan?.snippets,
    ...step?.snippets,
    ...input.snippets,
  })) {
    const code = typeof snippet === 'string' ? snippet : snippet.code;
    const help = typeof snippet === 'string' ? undefined : snippet.help;
    snippets[name] = {
      code: (await panelText(ctx, code)) ?? '',
      ...(help ? { help: await panelText(ctx, help) } : {}),
    };
  }
  const imagePath = input.image ?? step?.expectImage;
  let image: { mime: string; data: string } | undefined;
  if (imagePath) {
    const { projectDir } = await ctx.config();
    const real = checkPanelImage(imagePath, projectDir);
    const ext = extname(real).toLowerCase();
    image = {
      mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
      data: readFileSync(real).toString('base64'),
    };
  }
  const view = buildStepView({
    title,
    didWhat,
    expected,
    next,
    layers: [plan?.panel, step?.panel, input.panel],
    snippets,
    image: Boolean(image),
    ...(card
      ? {
          card: {
            subheading: await panelText(ctx, card.subheading),
            content: await panelText(ctx, card.content),
            size: card.size,
          },
        }
      : {}),
  });
  return {
    image,
    title,
    didWhat: didWhat ?? '',
    expected: expected ?? '',
    step: input.step ?? (found ? found.index + 1 : undefined),
    total: input.total ?? plan?.steps.length,
    stepId: input.stepId,
    view,
  };
}

// Saves a video of the last seconds before a bug, when the run records them.
export async function clipLine(
  ctx: Context,
  stepId: string,
): Promise<{ file: string; line: string } | undefined> {
  const store = ctx.run?.run.status === 'running' ? ctx.run : undefined;
  if (!store) return undefined;
  try {
    const clip = await bugClip(ctx, store, stepId);
    return clip
      ? {
          file: clip.file,
          line: `Video of the last ${Math.round(clip.seconds)} seconds: ${clip.file}`,
        }
      : undefined;
  } catch (error) {
    return {
      file: '',
      line: `Walkthrough could not save a video of the bug: ${(error as Error).message}`,
    };
  }
}

export function registerDeveloperTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'ask_developer',
    {
      title: 'Ask the developer',
      description: [
        'Show a step in the Walkthrough panel in the browser. Then wait for the developer to answer Pass, Bug, Skip, or Stop, with notes.',
        'Call it after you do a step. Say what you did and what the developer should see.',
        'During a run, give the stepId. Walkthrough then takes the title, the expected text, the step number, and the panel settings from the plan.',
        'On Bug, Walkthrough saves a screenshot and the errors from this step.',
        'If the reply says "status: waiting", call it again with resume: true.',
        'If the reply says "status: use_chat", ask the developer in chat instead.',
      ].join(' '),
      inputSchema: {
        title: z
          .string()
          .max(200)
          .optional()
          .describe('Short name of the step, like "Add the mug to the cart".'),
        didWhat: z.string().max(2000).optional().describe('What you did, in plain words.'),
        expected: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'What the developer should see now. During a run, the plan step gives it if you do not.',
          ),
        next: z
          .string()
          .max(2000)
          .optional()
          .describe('What comes after this step. The panel shows it under "What\'s next".'),
        panel: stepPanelSchema
          .optional()
          .describe(
            'Change the panel for this question: labels, like { did: Setup }, and buttons, like { pass: { label: Done } }.',
          ),
        snippets: snippetsSchema
          .optional()
          .describe(
            'Text the developer can copy, like a terminal command. Put {{copy:name}} in didWhat, expected, or next to show it with a copy button.',
          ),
        image: z
          .string()
          .optional()
          .describe(
            'An image of what the page should look like: a .png, .jpg, or .webp file in the project folder.',
          ),
        step: z.number().int().min(1).optional().describe('Step number.'),
        total: z.number().int().min(1).optional().describe('Number of steps in the test.'),
        stepId: z.string().optional().describe('Step id from a test plan.'),
        resume: z
          .boolean()
          .optional()
          .describe('Keep waiting for the question that is already in the panel.'),
      },
    },
    (input, extra) =>
      runTool(ctx, 'ask_developer', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const config = await ctx.config();
        const panel = driver.panel;

        if (panel?.recording) {
          throw new ToolError(
            'Recording is on. Call record with action "wait" or "stop" first.',
            'recording',
          );
        }
        const built = input.resume ? undefined : await buildQuestion(ctx, input);
        if (built && 'notShown' in built) {
          // A card whose "when" does not match the run. Nothing shows.
          const skipped = recordResult(
            ctx,
            { id: input.stepId },
            { status: 'skip', checkedBy: 'agent', notes: built.notShown, noActions: true },
          );
          return [
            'status: skip',
            `${built.notShown} The card has "when" set, so Walkthrough did not show it.`,
            skipped ? `Saved as step ${skipped.index} in the run. ${nextStepHint(ctx)}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
        const asked = built;
        if (!panel || !(await panel.waitReady(tab.id))) {
          const why = config.browser.headless
            ? 'the browser is hidden (headless)'
            : 'the panel could not start on this page';
          const view = asked?.view ?? (panel?.pending?.view as NonNullable<Question['view']>);
          return [
            'status: use_chat',
            `The developer panel is not available, because ${why}. Ask the developer in chat instead:`,
            view ? viewText(view) : '(no question)',
          ].join('\n');
        }

        if (input.resume) {
          if (!panel.pending)
            throw new ToolError(
              'No question is waiting in the panel. Ask a new question.',
              'bad_input',
            );
        } else if (asked) {
          await panel.ask({ tabId: tab.id, ...asked });
        }

        const timeoutSec = config.askTimeoutSec ?? defaultAskTimeoutSec(ctx.clientName());
        const stopProgress = startProgress(extra);
        // A video leaves out the time that the question is open.
        // After a timeout the question stays in the panel, so it is still open.
        const captures = liveCaptures(ctx);
        for (const capture of captures) capture.question(true);
        let outcome: Awaited<ReturnType<typeof panel.waitForAnswer>> | undefined;
        try {
          outcome = await panel.waitForAnswer(timeoutSec * 1000, extra.signal);
        } finally {
          stopProgress();
          if (outcome?.kind !== 'timeout') for (const capture of captures) capture.question(false);
        }

        switch (outcome.kind) {
          case 'timeout':
            return [
              'status: waiting',
              `The developer has not answered after ${timeoutSec} seconds. The question is still in the panel.`,
              'Call ask_developer with resume: true to keep waiting. Do not start the next step yet.',
            ].join('\n');
          case 'canceled':
            await panel.clear('The agent stopped waiting.');
            return 'status: canceled\nWalkthrough removed the question from the panel.';
          case 'tab_closed':
            return 'status: canceled\nThe tab with the question was closed. Ask the developer in chat what to do next.';
          case 'browser_closed':
            throw new ToolError(
              'The browser was closed. Call browser_open to start a new one.',
              'browser_closed',
            );
        }

        const { answer, question } = outcome;
        const label = question.stepId ?? question.title;
        // A card does nothing in the browser. Its actions and errors stay with the real steps.
        const isCard = question.view?.kind === 'card';
        const stepLogs = isCard ? [] : driver.logs.currentStep();
        const stepRequests = isCard ? [] : driver.network.currentStep();
        const mocked = isCard ? [] : driver.stepMocks;
        if (!isCard) driver.endStep(label);

        const lines = [`status: ${answer.result}`, `Developer notes: ${answer.note || '(none)'}`];
        const point = question.point;
        if (point) {
          lines.push(
            `The developer pointed at: ${point.label}${point.selector ? ` (selector: ${point.selector})` : ''}.`,
          );
        }
        if (answer.checklist?.length) {
          const open = answer.checklist.filter((item) => !item.checked);
          lines.push(
            `Checklist: ${answer.checklist.length - open.length} of ${answer.checklist.length} ticked.${open.length ? ` Not ticked: ${open.map((item) => `"${item.text}"`).join(', ')}.` : ''}`,
          );
        }
        const extraContent: Content[] = [];
        const record: StepAnswer = {
          at: new Date().toISOString(),
          question,
          answer,
          logs: formatLogs(stepLogs),
        };

        if (answer.result === 'retry') {
          // The developer wants the step again. The step stays open.
          const tried = recordTry(
            ctx,
            { id: question.stepId, index: question.step, title: question.title },
            { notes: answer.note, logs: stepLogs },
          );
          ctx.stepAnswers.push(record);
          lines.push(
            'The developer asked you to do this step again. Do it again, then call ask_developer again with the same stepId.',
          );
          if (tried)
            lines.push(
              `Saved try ${tried.tries} of step ${tried.step.index}. The step is still open.`,
            );
          return textResult(lines.join('\n'), extraContent);
        }
        if (answer.result === 'bug' && isCard) {
          lines.push('The developer reported a bug on a card. Ask what is wrong.');
        } else if (answer.result === 'bug') {
          try {
            const shot = await bugScreenshot(
              ctx,
              driver,
              tab,
              question.stepId ?? String(question.step ?? 'step'),
              point ? await pointedRect(tab, point) : undefined,
            );
            record.screenshot = shot.relativePath;
            lines.push(`Screenshot: ${shot.relativePath}`);
            extraContent.push({ type: 'image', data: shot.preview, mimeType: 'image/jpeg' });
          } catch (error) {
            lines.push(`Walkthrough could not save a screenshot: ${(error as Error).message}`);
          }
          const har = await bugHar(ctx, stepRequests, question.stepId ?? question.title);
          if (har) {
            record.files = [har];
            lines.push(`Network requests (HAR): ${har}`);
          }
          const details = point
            ? await pointedDetails(ctx, tab, point, question.stepId ?? question.title)
            : undefined;
          if (details) {
            record.files = [...(record.files ?? []), details];
            lines.push(`Styles and CSS rules of the pointed element: ${details}`);
          }
          const clip = await clipLine(ctx, question.stepId ?? question.title);
          if (clip) {
            if (clip.file) record.files = [...(record.files ?? []), clip.file];
            lines.push(clip.line);
          }
          lines.push(
            'Errors and failed requests during this step:',
            untrusted(formatLogs(stepLogs)),
          );
          lines.push(
            'Tell the developer what you saved. Ask whether to continue with the next step.',
          );
        } else if (answer.result === 'stop') {
          lines.push('The developer asked to stop. Do not do more steps. Give a short summary.');
        } else if (answer.result === 'skip') {
          lines.push('The developer skipped this step. Continue with the next step.');
        } else if (stepLogs.some((e) => e.level === 'error')) {
          lines.push(
            'Note: the page logged errors during this step:',
            untrusted(formatLogs(stepLogs)),
          );
        }

        ctx.stepAnswers.push(record);
        const recorded = recordResult(
          ctx,
          {
            id: question.stepId,
            index: question.step,
            title: question.title,
            expect: question.expected,
          },
          {
            status: answer.result,
            checkedBy: 'developer',
            notes: answer.note,
            screenshot: record.screenshot,
            files: record.files,
            mocked,
            logs: isCard ? undefined : stepLogs,
            checklist: answer.checklist,
            noActions: isCard,
            ...(point ? { pointed: { label: point.label, selector: point.selector } } : {}),
          },
        );
        if (recorded)
          lines.push(`Saved as step ${recorded.index} in the run. ${nextStepHint(ctx)}`);
        return textResult(lines.join('\n'), extraContent);
      }),
  );

  server.registerTool(
    'logs',
    {
      title: 'Page logs',
      description:
        'Show console messages, page errors, failed requests, and Chrome issues (the DevTools Issues panel: blocked cookies, CSP, CORS, mixed content, deprecated features, form problems). By default it shows errors and warnings since the current step started.',
      inputSchema: {
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Show entries after this marker number. Use 0 for all.'),
        levels: z
          .array(z.enum(['error', 'warning', 'info']))
          .optional()
          .describe('Default: error and warning.'),
        kinds: z
          .array(z.enum(LOG_KINDS))
          .optional()
          .describe('Only these kinds: console, page-error, network, issue. Default: all.'),
      },
    },
    ({ since, levels, kinds }) =>
      runTool(ctx, 'logs', async () => {
        const driver = ctx.requireDriver();
        const wanted = (levels ?? ['error', 'warning']) as LogLevel[];
        const entries =
          since === undefined
            ? driver.logs.currentStep(wanted, kinds)
            : driver.logs.since(since, wanted, kinds);
        return [
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${since === undefined ? ' since the current step started' : ` after marker ${since}`}:`,
          untrusted(formatLogs(entries)),
          `Latest marker: ${driver.logs.marker}`,
        ].join('\n');
      }),
  );
}
