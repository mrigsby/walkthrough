import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeEmulation, type Emulation } from '../browser/devices.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { checkScreenshotPath } from '../guards/paths.js';
import { untrusted } from '../guards/untrusted.js';
import { isProblem, resultLine } from '../report/common.js';
import { htmlReport } from '../report/html.js';
import { markdownReport } from '../report/markdown.js';
import { MODES, type Mode, type Plan, type PlanStep, stepCapture } from '../run/plan-schema.js';
import {
  formatProblems,
  laterFeatures,
  listPlans,
  loadPlan,
  savePlan,
  validatePlanText,
} from '../run/plans.js';
import { nextStepHint, recordResult } from '../run/record.js';
import { needsConfirm, RunStore } from '../run/run-store.js';
import { openBrowser } from './browser-tools.js';
import { bugScreenshot } from './developer-tools.js';
import { type Content, runTool, textResult } from './util.js';

// Writes report.md and report.html in the run folder.
export function writeReports(store: RunStore): { markdown: string; html: string } {
  const markdown = join(store.dir, 'report.md');
  const html = join(store.dir, 'report.html');
  writeFileSync(markdown, markdownReport(store.run));
  writeFileSync(html, htmlReport(store.run, store.dir));
  return { markdown: relative(store.projectDir, markdown), html: relative(store.projectDir, html) };
}

function describeAction(step: PlanStep): string | undefined {
  if (!step.action) return undefined;
  const [kind, value] = Object.entries(step.action)[0] ?? [];
  if (!kind) return undefined;
  if (typeof value === 'string') return `${kind} "${value}"`;
  const t = value as {
    role?: string;
    name?: string;
    selector?: string;
    value?: string;
    files?: string[];
  };
  const where = t.selector
    ? `selector ${t.selector}`
    : `${t.role ?? 'element'}${t.name ? ` "${t.name}"` : ''}`;
  const extra =
    t.value !== undefined ? ` with "${t.value}"` : t.files ? ` with ${t.files.join(', ')}` : '';
  return `${kind} ${where}${extra}`;
}

// Checks every exact screenshot path in a plan. Returns the problems.
function screenshotProblems(plan: Plan, projectDir: string, extraRoots: string[]): string[] {
  const problems: string[] = [];
  plan.steps.forEach((step, i) => {
    const capture = stepCapture(plan, step);
    if (!capture) return;
    try {
      checkScreenshotPath(capture.path, projectDir, extraRoots);
    } catch (error) {
      problems.push(`Step ${i + 1} [${step.id ?? `step-${i + 1}`}]: ${(error as Error).message}`);
    }
  });
  return problems;
}

function describeCapture(plan: Plan, step: PlanStep): string {
  const capture = stepCapture(plan, step);
  if (!capture) return step.screenshot ? 'screenshot' : '';
  const extra = [
    capture.selector ? `selector ${capture.selector}` : '',
    capture.fullPage ? 'full page' : '',
  ].filter(Boolean);
  return `screenshot to ${capture.path}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

function stepList(plan: Plan, mode: Mode): string {
  return plan.steps
    .map((step, i) => {
      const id = step.id ?? `step-${i + 1}`;
      const flags = [
        needsConfirm(mode, step.checkpoint) ? 'confirm' : 'agent checks',
        describeCapture(plan, step),
        step.visual ? 'visual check' : '',
      ]
        .filter(Boolean)
        .join(', ');
      const lines = [`${i + 1}. [${id}] (${flags}) ${step.do}`];
      if (step.expect) lines.push(`   Expect: ${step.expect}`);
      const hint = describeAction(step);
      if (hint) lines.push(`   Action: ${hint}`);
      return lines.join('\n');
    })
    .join('\n');
}

const HOW_TO: Record<Mode, string> = {
  interactive: 'Interactive mode: the developer confirms every step in the panel.',
  checkpoints:
    'Checkpoints mode: the developer confirms the steps marked "confirm". You check the other steps.',
  autonomous:
    'Autonomous mode: you check every step yourself. Do not ask the developer, unless something blocks you.',
};

export function registerRunTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'plan',
    {
      title: 'Test plans',
      description:
        'Work with the YAML test plans in .walkthrough/plans: list them, show one, validate one, or save a new one. Validation gives line numbers.',
      inputSchema: {
        action: z.enum(['list', 'show', 'validate', 'save']),
        name: z
          .string()
          .optional()
          .describe('Plan name, like "checkout", or a path in the project.'),
        content: z.string().optional().describe('Plan YAML, for validate or save.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('For save: replace a plan that exists. Ask the developer first.'),
      },
    },
    ({ action, name, content, overwrite }) =>
      runTool(ctx, 'plan', async () => {
        const { projectDir, screenshotRoots } = await ctx.config();
        if (action === 'list') {
          const plans = listPlans(projectDir);
          if (plans.length === 0) return 'There are no plans in .walkthrough/plans yet.';
          return plans
            .map((p) =>
              p.problems
                ? `- ${p.name} (${p.file}): ${p.problems} problem(s). Validate it to see them.`
                : `- ${p.name} (${p.file}): "${p.title}", ${p.steps} step(s)`,
            )
            .join('\n');
        }
        if (action === 'save') {
          if (!name || !content)
            throw new ToolError('Give a name and the plan content to save.', 'bad_input');
          const file = savePlan(projectDir, name, content, overwrite);
          return `Saved the plan: ${relative(projectDir, file)}`;
        }
        if (action === 'validate' && content) {
          const result = validatePlanText(content);
          return result.ok
            ? `The plan is valid. It has ${result.plan.steps.length} step(s).`
            : formatProblems('(content)', result.problems);
        }
        if (!name) throw new ToolError('Give the name of a plan.', 'bad_input');
        const { file, plan } = loadPlan(projectDir, name);
        const later = laterFeatures(plan);
        if (action === 'validate') {
          const shots = screenshotProblems(plan, projectDir, screenshotRoots);
          if (shots.length) {
            return [
              `The plan ${relative(projectDir, file)} has screenshot paths that Walkthrough cannot use:`,
              ...shots.map((p) => `- ${p}`),
            ].join('\n');
          }
          return `The plan ${relative(projectDir, file)} is valid. It has ${plan.steps.length} step(s).${later.length ? ` Note: these keys do not work yet: ${later.join(', ')}.` : ''}`;
        }
        const mode = plan.mode ?? 'checkpoints';
        return [
          `Plan: ${plan.name} (${relative(projectDir, file)})`,
          plan.description ? `About: ${plan.description}` : '',
          `Mode: ${mode}`,
          plan.baseUrl ? `Start page: ${plan.baseUrl}` : '',
          'Steps:',
          stepList(plan, mode),
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );

  server.registerTool(
    'run_start',
    {
      title: 'Start a test run',
      description:
        'Start a test run from a saved plan, or an ad hoc run with a name. It opens the browser at the start page and returns the steps and how to check each one. Walkthrough saves the results after each step.',
      inputSchema: {
        plan: z.string().optional().describe('Plan name, like "checkout".'),
        name: z.string().optional().describe('Name for an ad hoc run without a plan.'),
        mode: z
          .enum(MODES)
          .optional()
          .describe('Overrides the mode in the plan. The default is checkpoints.'),
      },
    },
    ({ plan: planName, name, mode: modeArg }) =>
      runTool(ctx, 'run_start', async () => {
        const config = await ctx.refresh();
        if (ctx.run?.run.status === 'running') {
          throw new ToolError(
            `The run "${ctx.run.run.name}" is still going. Call run_finish first.`,
            'run_active',
          );
        }
        if (!planName && !name)
          throw new ToolError('Give a plan name, or a name for an ad hoc run.', 'bad_input');
        const loaded = planName ? loadPlan(config.projectDir, planName) : undefined;
        const plan = loaded?.plan;
        if (plan) {
          const later = laterFeatures(plan);
          if (later.length) {
            throw new ToolError(
              `This plan uses settings that do not work yet: ${later.join(', ')}. Remove them to run the plan now.`,
              'not_supported_yet',
            );
          }
          const shots = screenshotProblems(plan, config.projectDir, config.screenshotRoots);
          if (shots.length) {
            throw new ToolError(
              `This plan has screenshot paths that Walkthrough cannot use:\n${shots.map((p) => `- ${p}`).join('\n')}`,
              'screenshot_blocked',
            );
          }
        }
        const mode = modeArg ?? plan?.mode ?? 'checkpoints';
        const baseUrl = plan?.baseUrl ?? config.baseUrl;

        const emulation: Emulation = {};
        if (plan?.device) emulation.device = plan.device;
        if (plan?.colorScheme) emulation.colorScheme = plan.colorScheme;
        if (plan?.network) emulation.network = plan.network;
        const opened = await openBrowser(ctx, {
          url: baseUrl,
          alwaysGo: true,
          session: plan?.session,
          emulation,
        });
        const driver = ctx.requireDriver();
        // Start clean: earlier actions and page errors are not part of this run.
        ctx.actionCursor = ctx.actionLog.length;
        driver.logs.endStep('(before the run)');

        ctx.run = RunStore.create(config.projectDir, {
          name: plan?.name ?? name ?? 'Ad hoc run',
          mode,
          plan,
          planFile: loaded?.file,
          baseUrl,
          chrome: driver.chromeVersion,
          setup: `${describeEmulation(driver.emulation)}${plan?.session ? `, saved login: ${plan.session}` : ''}`,
          emulation: {
            device: driver.emulation.device,
            colorScheme: driver.emulation.colorScheme,
          },
        });

        const lines = [
          `Started the run "${ctx.run.run.name}" in ${mode} mode.`,
          `Run folder: ${ctx.run.relativeDir}`,
          HOW_TO[mode],
          '',
          'For each step:',
          '1. Do what the step says. If it has an Action, use it.',
          '2. For a "confirm" step, call ask_developer with stepId, step, total, title, didWhat, and expected.',
          '3. For an "agent checks" step, check Expect yourself with snapshot, read, or wait_for. Then call run_step with stepId and the result. On fail, give "actual".',
          '4. For a "screenshot" step, call screenshot after the step. For a "screenshot to <path>" step, call screenshot with path, stepId, and the selector or fullPage from the step. For a "visual check" step, call visual_check with name and stepId set to the step id.',
          '5. When every step has a result, or the developer says stop, call run_finish.',
          '',
        ];
        if (plan) lines.push(`Steps (${plan.steps.length}):`, stepList(plan, mode));
        else
          lines.push(
            'This run has no plan. Use run_step or ask_developer with a title for each step you do.',
          );
        lines.push('', opened.text);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'run_step',
    {
      title: 'Record a step result',
      description:
        'Record the result of a step that you checked yourself. Use it for steps the developer does not confirm. On fail or blocked, it saves a screenshot and the errors from the step.',
      inputSchema: {
        stepId: z.string().optional().describe('The step id from the plan.'),
        step: z.number().int().min(1).optional().describe('The step number.'),
        title: z.string().optional().describe('For ad hoc runs: what the step did.'),
        status: z.enum(['pass', 'fail', 'skip', 'blocked']),
        actual: z
          .string()
          .optional()
          .describe('What you saw, if it was not what the step expected.'),
        notes: z.string().optional(),
        screenshot: z
          .boolean()
          .optional()
          .describe('Save a screenshot. The default is yes on fail or blocked.'),
      },
    },
    ({ stepId, step, title, status, actual, notes, screenshot }) =>
      runTool(ctx, 'run_step', async () => {
        const store = ctx.run;
        if (store?.run.status !== 'running') {
          throw new ToolError('No run is going. Call run_start first.', 'no_run');
        }
        if (!stepId && !step && !title)
          throw new ToolError('Give the stepId, the step number, or a title.', 'bad_input');
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const stepLogs = driver.logs.currentStep();
        driver.logs.endStep(stepId ?? title ?? `step-${step}`);

        const lines: string[] = [];
        const extra: Content[] = [];
        let shotPath: string | undefined;
        if (screenshot ?? (status === 'fail' || status === 'blocked')) {
          const shot = await bugScreenshot(ctx, driver, tab, stepId ?? String(step ?? 'step'));
          shotPath = shot.relativePath;
          lines.push(`Screenshot: ${shot.relativePath}`);
          extra.push({ type: 'image', data: shot.preview, mimeType: 'image/jpeg' });
        }
        const recorded = recordResult(
          ctx,
          { id: stepId, index: step, title },
          {
            status,
            checkedBy: 'agent',
            actual,
            notes,
            screenshot: shotPath,
            logs: stepLogs,
          },
        );
        lines.unshift(`Saved step ${recorded?.index} [${recorded?.id}] as ${status}.`);
        if (stepLogs.some((e) => e.level === 'error')) {
          lines.push('The page logged errors during this step:', untrusted(recorded?.logs ?? ''));
        }
        lines.push(nextStepHint(ctx));
        return textResult(lines.join('\n'), extra);
      }),
  );

  server.registerTool(
    'run_finish',
    {
      title: 'Finish the run',
      description:
        'Finish the test run and write report.md and report.html in the run folder. Steps without a result show as "not run". With runId, it writes the reports again for an older run.',
      inputSchema: {
        summary: z.string().optional().describe('A short summary for the report, in plain words.'),
        runId: z
          .string()
          .optional()
          .describe('An older run folder name, to write its reports again.'),
      },
    },
    ({ summary, runId }) =>
      runTool(ctx, 'run_finish', async () => {
        const { projectDir } = await ctx.config();
        const store = runId ? RunStore.open(projectDir, runId) : ctx.run;
        if (!store)
          throw new ToolError(
            'No run is going. Give a runId to write the reports for an older run.',
            'no_run',
          );
        if (store === ctx.run) {
          store.finish(summary);
          ctx.run = undefined;
        } else if (summary) {
          store.run.summary = summary;
          store.save();
        }
        const paths = writeReports(store);
        const problems = store.run.steps.filter(isProblem);
        return [
          `The run "${store.run.name}" is ${store.run.status}. Result: ${resultLine(store.run) || 'no steps'}.`,
          `Reports: ${paths.markdown} and ${paths.html}`,
          ...(problems.length
            ? [
                'Bugs and failures:',
                ...problems.map(
                  (s) => `- Step ${s.index}: ${s.title}${s.notes ? `. Notes: ${s.notes}` : ''}`,
                ),
              ]
            : []),
          'Tell the developer the result and where the HTML report is.',
        ].join('\n');
      }),
  );
}
