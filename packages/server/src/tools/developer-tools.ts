import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Driver, Tab } from '../browser/driver.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { elementRect, withCleanPage } from '../evidence/annotate.js';
import { formatLogs, type LogLevel } from '../evidence/logs.js';
import { takeScreenshot } from '../evidence/screenshot.js';
import { untrusted } from '../guards/untrusted.js';
import type { Answer, Question } from '../panel/controller.js';
import { nextStepHint, recordResult } from '../run/record.js';
import { type Content, runTool, textResult } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// What the developer said about one step. Test runs use these later.
export interface StepAnswer {
  at: string;
  question: Question;
  answer: Answer;
  screenshot?: string;
  logs: string;
}

// Claude Code waits a long time for a tool. Other clients often stop after 60 seconds.
function defaultAskTimeoutSec(clientName?: string): number {
  return clientName === 'claude-code' ? 300 : 50;
}

// Saves a screenshot with a red box around the element of the last action.
export async function bugScreenshot(ctx: Context, driver: Driver, tab: Tab, stepLabel: string) {
  const config = await ctx.config();
  const last = driver.lastTarget?.tabId === tab.id ? driver.lastTarget : undefined;
  const rect = last ? await elementRect(last.handle) : undefined;
  return withCleanPage(driver, tab, { annotate: rect }, () =>
    takeScreenshot(tab, ctx.evidenceDir(config.projectDir), config.projectDir, {
      label: `bug-${stepLabel}`,
    }),
  );
}

// Sends "still waiting" progress, if the client asked for progress.
function startProgress(extra: Extra): () => void {
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
          message: 'Walkthrough waits for the developer to answer in the browser.',
        },
      })
      .catch(() => undefined);
  }, 10_000);
  return () => clearInterval(timer);
}

function questionText(q: { title: string; didWhat: string; expected: string }): string {
  return `Step: ${q.title}\nWhat I did: ${q.didWhat}\nWhat you should see: ${q.expected}`;
}

export function registerDeveloperTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'ask_developer',
    {
      title: 'Ask the developer',
      description: [
        'Show a step in the Walkthrough panel in the browser. Then wait for the developer to answer Pass, Bug, Skip, or Stop, with notes.',
        'Call it after you do a step. Say what you did and what the developer should see.',
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
        expected: z.string().max(2000).optional().describe('What the developer should see now.'),
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

        if (!input.resume && (!input.title || !input.didWhat || !input.expected)) {
          throw new ToolError('Give a title, didWhat, and expected for the step.', 'bad_input');
        }
        if (!panel || !(await panel.waitReady(tab.id))) {
          const why = config.browser.headless
            ? 'the browser is hidden (headless)'
            : 'the panel could not start on this page';
          return [
            'status: use_chat',
            `The developer panel is not available, because ${why}. Ask the developer in chat instead:`,
            questionText({
              title: input.title ?? '',
              didWhat: input.didWhat ?? '',
              expected: input.expected ?? '',
            }),
          ].join('\n');
        }

        if (input.resume) {
          if (!panel.pending)
            throw new ToolError(
              'No question is waiting in the panel. Ask a new question.',
              'bad_input',
            );
        } else {
          await panel.ask({
            tabId: tab.id,
            title: input.title as string,
            didWhat: input.didWhat as string,
            expected: input.expected as string,
            step: input.step,
            total: input.total,
            stepId: input.stepId,
          });
        }

        const timeoutSec = config.askTimeoutSec ?? defaultAskTimeoutSec(ctx.clientName());
        const stopProgress = startProgress(extra);
        let outcome: Awaited<ReturnType<typeof panel.waitForAnswer>>;
        try {
          outcome = await panel.waitForAnswer(timeoutSec * 1000, extra.signal);
        } finally {
          stopProgress();
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
        const stepLogs = driver.logs.currentStep();
        driver.logs.endStep(label);

        const lines = [`status: ${answer.result}`, `Developer notes: ${answer.note || '(none)'}`];
        const extraContent: Content[] = [];
        const record: StepAnswer = {
          at: new Date().toISOString(),
          question,
          answer,
          logs: formatLogs(stepLogs),
        };

        if (answer.result === 'bug') {
          try {
            const shot = await bugScreenshot(
              ctx,
              driver,
              tab,
              question.stepId ?? String(question.step ?? 'step'),
            );
            record.screenshot = shot.relativePath;
            lines.push(`Screenshot: ${shot.relativePath}`);
            extraContent.push({ type: 'image', data: shot.preview, mimeType: 'image/jpeg' });
          } catch (error) {
            lines.push(`Walkthrough could not save a screenshot: ${(error as Error).message}`);
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
            logs: stepLogs,
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
        'Show console messages, page errors, and failed requests from the browser. By default it shows errors and warnings since the current step started.',
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
      },
    },
    ({ since, levels }) =>
      runTool(ctx, 'logs', async () => {
        const driver = ctx.requireDriver();
        const wanted = (levels ?? ['error', 'warning']) as LogLevel[];
        const entries =
          since === undefined ? driver.logs.currentStep(wanted) : driver.logs.since(since, wanted);
        return [
          `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${since === undefined ? ' since the current step started' : ` after marker ${since}`}:`,
          untrusted(formatLogs(entries)),
          `Latest marker: ${driver.logs.marker}`,
        ].join('\n');
      }),
  );
}
