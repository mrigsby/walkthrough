import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { exportScript } from '../export/puppeteer-script.js';
import { redactDeep } from '../guards/secrets.js';
import { untrusted } from '../guards/untrusted.js';
import { draftIssue } from '../issue/draft.js';
import { Recorder } from '../record/recorder.js';
import { isProblem } from '../report/common.js';
import { latestRunId, RunStore } from '../run/run-store.js';
import { slug } from '../text.js';
import { writeReports } from './run-tools.js';
import { runTool } from './util.js';

// Opens a run by id, or the newest finished run.
function openRun(ctx: Context, projectDir: string, runId?: string): RunStore {
  if (!runId && ctx.run?.run.status === 'running') {
    throw new ToolError(
      'A run is still going. Call run_finish first, or give a runId.',
      'run_active',
    );
  }
  const id = runId ?? latestRunId(projectDir, { finishedOnly: true });
  if (!id) throw new ToolError('There are no finished runs yet. Run a plan first.', 'no_run');
  return RunStore.open(projectDir, id);
}

let stopNavigationWatch: (() => void) | undefined;

// The plan draft and the notes that go with it.
function draftReply(recorder: Recorder, how: string): string {
  const lines = [
    `status: stopped`,
    `${how} Walkthrough recorded ${recorder.steps.length} step(s).`,
  ];
  if (recorder.secrets.length) {
    lines.push(
      `Secrets in the draft: ${recorder.secrets.join(', ')}. The developer adds them to .walkthrough/.env. Walkthrough did not record their values.`,
    );
  }
  if (recorder.steps.some((s) => s.kind === 'upload')) {
    lines.push(
      'Upload steps point to fixtures/<file name>. Put the files there, or fix the paths.',
    );
  }
  lines.push(
    'Show the draft to the developer. Ask for a plan name and any changes, such as an "expect" for more steps. Then save it with the plan tool (action "save").',
    'The draft has text from the web page, such as button names:',
    untrusted(recorder.toYaml()),
  );
  return lines.join('\n');
}

export function registerShareTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'record',
    {
      title: 'Record a flow',
      description: [
        'Record the developer while they use the app, and turn it into a draft test plan.',
        'Call it with action "start", then "wait". "wait" returns when the developer clicks Stop recording in the panel.',
        'Password fields become {{secret:NAME}}. Walkthrough never records their values.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['start', 'wait', 'stop', 'status']),
        name: z
          .string()
          .optional()
          .describe('For start: a name for the plan, like "Log in and check out".'),
      },
    },
    ({ action, name }, extra) =>
      runTool(ctx, 'record', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const panel = driver.panel;
        const config = await ctx.config();
        if (!panel || !(await panel.waitReady(tab.id))) {
          throw new ToolError(
            'Recording needs the panel in a visible browser. Set headless: false and panel: true in .walkthrough/config.yaml.',
            'no_panel',
          );
        }

        if (action === 'start') {
          if (panel.recording)
            throw new ToolError(
              'Recording is already on. Call record with action "wait".',
              'recording',
            );
          if (panel.pending)
            throw new ToolError(
              'A question is waiting in the panel. Get the answer first.',
              'busy',
            );
          const recorder = new Recorder(name ?? 'Recorded flow', config.baseUrl);
          const onNavigated = ({ url }: { url: string }) => recorder.addNavigation(url);
          driver.emitter.on('navigated', onNavigated);
          stopNavigationWatch = () => driver.emitter.off('navigated', onNavigated);
          await panel.startRecording(recorder);
          return [
            'Recording is on. The panel in the browser shows "Recording".',
            'Tell the developer:',
            '- Use the app as usual. Walkthrough records each click and each field that you type in.',
            '- Click "Add expectation" to say what the page should show at that point.',
            '- Click "Mark last field as secret" after you type a private value that is not a password.',
            '- Click "Stop recording" when you are done.',
            'Then call record with action "wait". Do not use other browser tools while recording is on.',
          ].join('\n');
        }

        const recorder = panel.recording;
        if (!recorder)
          throw new ToolError(
            'Recording is off. Call record with action "start".',
            'not_recording',
          );

        if (action === 'status') {
          return `Recording is on. ${recorder.steps.length} step(s) so far.${recorder.lastLabel ? ` Last: ${recorder.lastLabel}` : ''}`;
        }

        if (action === 'wait') {
          const timeoutSec =
            config.askTimeoutSec ?? (ctx.clientName() === 'claude-code' ? 300 : 50);
          const outcome = await panel.waitForRecordStop(timeoutSec * 1000, extra.signal);
          if (outcome === 'timeout') {
            return `status: waiting\nRecording is still on, with ${recorder.steps.length} step(s) so far. Call record with action "wait" again.`;
          }
          if (outcome === 'canceled') {
            return 'status: canceled\nRecording is still on. Call record with action "wait" or "stop".';
          }
        }

        stopNavigationWatch?.();
        stopNavigationWatch = undefined;
        await panel.stopRecording();
        return draftReply(
          recorder,
          action === 'stop' ? 'You stopped the recording.' : 'The developer stopped the recording.',
        );
      }),
  );

  server.registerTool(
    'export_script',
    {
      title: 'Export a script',
      description:
        'Turn a finished run into a plain Puppeteer script in .walkthrough/exports. It repeats the actions, checks the quoted text in each "expect", and saves the screenshots that the run saved to exact files. It can run in CI without an agent.',
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe('The run folder name. The default is the newest finished run.'),
        installedChrome: z
          .boolean()
          .optional()
          .describe(
            'Use puppeteer-core and the installed Chrome, not the Chrome that puppeteer downloads.',
          ),
      },
    },
    ({ runId, installedChrome }) =>
      runTool(ctx, 'export_script', async () => {
        const { projectDir } = await ctx.config();
        const store = openRun(ctx, projectDir, runId);
        const name = slug(
          store.run.planFile
            ? (store.run.planFile.split('/').pop() ?? '').replace(/\.ya?ml$/, '')
            : store.run.name,
          50,
          'run',
        );
        const dir = join(projectDir, '.walkthrough', 'exports');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${name}.mjs`);
        const existed = existsSync(file);
        const result = exportScript(store.run, { installedChrome });
        const rel = relative(projectDir, file);
        writeFileSync(file, result.code.replace('<this file>', rel));
        const pkg = installedChrome ? 'puppeteer-core' : 'puppeteer';
        return [
          `${existed ? 'Replaced' : 'Wrote'} ${rel} from the run ${store.run.id}.`,
          `It has ${result.actions} action(s) and ${result.checks} text check(s).${result.handChecks ? ` ${result.handChecks} expectation(s) have no quoted text, so they are comments to check by hand.` : ''}`,
          ...(result.missingSelectors.length
            ? [
                `These actions need a fix by hand, because they have no stable selector: ${result.missingSelectors.join('; ')}.`,
              ]
            : []),
          ...(result.failedSteps.length
            ? [
                `These steps failed in the run, so the script fails there until the bug is fixed: ${result.failedSteps.join('; ')}.`,
              ]
            : []),
          ...(result.captures.length
            ? [
                `It saves ${result.captures.length} screenshot(s) and replaces the old files: ${result.captures.join(', ')}.`,
                'To save only some of them, set SHOT to their file names, like SHOT=cart,settings. The steps still all run.',
              ]
            : []),
          ...(result.secrets.length
            ? [`Set these environment variables before a run: ${result.secrets.join(', ')}.`]
            : []),
          `To run it: npm install --save-dev ${pkg}, then node ${rel}`,
        ].join('\n');
      }),
  );

  server.registerTool(
    'issue_draft',
    {
      title: 'Draft a GitHub issue',
      description:
        'Write a GitHub issue title and body from a bug or a failed step of a run. It saves the body to a file for gh issue create --web, and lists the screenshots to add by hand. It does not create the issue.',
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe('The run folder name. The default is the newest finished run.'),
        stepId: z
          .string()
          .optional()
          .describe('The step id. The default is the first bug or failed step.'),
      },
    },
    ({ runId, stepId }) =>
      runTool(ctx, 'issue_draft', async () => {
        const { projectDir } = await ctx.config();
        const store = openRun(ctx, projectDir, runId);
        const problems = store.run.steps.filter(isProblem);
        const step = stepId ? store.run.steps.find((s) => s.id === stepId) : problems[0];
        if (!step) {
          throw new ToolError(
            stepId ? `The run has no step "${stepId}".` : 'The run has no bug or failed step.',
            'no_step',
          );
        }
        const secrets = await ctx.secrets();
        const reports = existsSync(join(store.dir, 'report.md'))
          ? { markdown: relative(projectDir, join(store.dir, 'report.md')) }
          : writeReports(store, secrets);
        const screenshots = step.screenshots.map((s) => relative(projectDir, join(store.dir, s)));
        // Hide secrets before draftIssue runs, so its length limit still holds.
        const run = redactDeep(store.run, secrets);
        const safeStep = run.steps.find((s) => s.id === step.id) ?? step;
        const draft = draftIssue(run, safeStep, { reportPath: reports.markdown, screenshots });
        const bodyFile = join(store.dir, `issue-${slug(step.id, 50, 'step')}.md`);
        writeFileSync(bodyFile, draft.body);
        return [
          `Title: ${draft.title}`,
          `Body file: ${relative(projectDir, bodyFile)}${draft.shortened ? ' (shortened to fit in the browser address)' : ''}`,
          `Screenshots to drag into the issue:${screenshots.length ? `\n${screenshots.map((s) => `- ${join(projectDir, s)}`).join('\n')}` : ' none'}`,
          'Show the title and the body to the developer. Ask before you open the issue page.',
          'Body:',
          untrusted(draft.body),
        ].join('\n');
      }),
  );
}
