import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { auditPage, standardLabel } from '../audit/audit-page.js';
import { IMPACT_ORDER } from '../audit/axe.js';
import { customViolations } from '../audit/custom-rules.js';
import { buildFindings, type Finding, type Findings, pageKey } from '../audit/findings.js';
import { computeScores, type Scores } from '../audit/score.js';
import {
  CHECKS,
  type CheckName,
  STANDARDS,
  type Standard,
  standardTags,
} from '../audit/standards.js';
import { criteriaLabel } from '../audit/wcag.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { type A11yCheck, type Run, RunStore } from '../run/run-store.js';
import { slug } from '../text.js';
import { fullUrl, goTo, openBrowser } from './browser-tools.js';
import { writeReports } from './run-tools.js';
import { runTool } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// How long one a11y_scan call may run. Many clients stop waiting after 60 seconds.
// Tests can make it shorter.
const TIME_LIMIT_MS = Number(process.env.UIWALK_SCAN_LIMIT_MS) || 45_000;

// The newest run folder with accessibility results, or undefined.
function latestA11yRunId(projectDir: string): string | undefined {
  const dir = join(projectDir, '.walkthrough', 'runs');
  if (!existsSync(dir)) return undefined;
  for (const id of readdirSync(dir).sort().reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')) as Run;
      if (run.accessibility?.length) return id;
    } catch {}
  }
  return undefined;
}

// One short line of counts, like "2 critical, 1 serious".
function impactLine(violations: Array<{ impact: string }>): string {
  const parts = IMPACT_ORDER.map(
    (i) => [i, violations.filter((v) => v.impact === i).length] as const,
  )
    .filter(([, n]) => n > 0)
    .map(([i, n]) => `${n} ${i}`);
  return parts.join(', ');
}

// The problems on a page that break WCAG (not only best practices).
function wcagProblems(check: A11yCheck) {
  return [...check.violations, ...customViolations(check)].filter((v) =>
    (v.tags ?? []).some((t) => /^wcag\d/.test(t)),
  );
}

export function scoreLine(scores: Scores): string {
  if (!scores.available)
    return 'Score not available: Walkthrough checked this run before it saved the rules that passed.';
  return `Score: ${scores.overall} of 100 (${scores.band}). Best practices: ${scores.bestPractices ?? 'n/a'}. ${scores.areas
    .filter((a) => a.score !== null)
    .map((a) => `${a.area} ${a.score}`)
    .join(', ')}.`;
}

// One finding, for the agent. The page text in it must go inside untrusted().
function findingText(f: Finding, detail: boolean): string {
  const where = `${f.elementCount} element(s) on ${f.pages.length} page(s)`;
  const wcag = criteriaLabel(f.tags) || 'best practice';
  const head = `${f.id} [${f.impact}] ${f.rule}: ${f.help}. ${wcag}. Area: ${f.area}. ${where}.`;
  if (!detail) return head;
  const lines = [head];
  if (f.description) lines.push(`  About the rule: ${f.description}`);
  for (const el of f.elements.slice(0, 3)) {
    const frame = el.frame ? ` (in frame ${el.frame.selector})` : '';
    lines.push(`  - ${el.page}${frame} ${el.target}: ${el.html}`);
    const summary = el.failureSummary?.split('\n').slice(0, 3).join(' ');
    if (summary) lines.push(`    ${summary}`);
  }
  if (f.elementCount > 3) lines.push(`  - and ${f.elementCount - 3} more`);
  return lines.join('\n');
}

export function findingsText(findings: Findings, detailed = 30): string {
  if (findings.findings.length === 0) return 'No accessibility problems found.';
  return findings.findings.map((f, i) => findingText(f, i < detailed)).join('\n');
}

const WRITING_GUIDE = [
  'Next, write the report text. For each issue ID, write:',
  '- explain: 1 to 2 short sentences. What is wrong, and who it affects.',
  '- fix: 1 to 2 short sentences. What to change.',
  '- code (optional): a short example of the fix, up to 12 lines.',
  '- where (optional): the source files and lines, if you find them in the project. Never guess.',
  'Use plain words, short sentences, and no em dashes. Also write a summary of 2 to 4 sentences.',
  'Then call a11y_report again with runId, digest, summary, and items.',
].join('\n');

export function registerA11yTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'a11y_scan',
    {
      title: 'Accessibility scan',
      description:
        'Check one page or a list of pages for accessibility problems: axe-core plus the extra checks in config.yaml (keyboard, dark mode, reflow, frames, screenshots). Without a run, it makes a run with one step per page and writes report.html. Then call a11y_report.',
      inputSchema: {
        urls: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe('Pages like "/", "/login", or full URLs. The default is the current page.'),
        runId: z.string().optional().describe('Go on with a scan that stopped at its time limit.'),
        name: z.string().optional().describe('A name for the new run.'),
        session: z
          .string()
          .optional()
          .describe('A saved login to load first. Only when no run is going.'),
        standard: z.enum(STANDARDS).optional(),
        checks: z
          .array(z.enum(CHECKS))
          .optional()
          .describe('The extra checks to run. The default comes from config.yaml.'),
      },
    },
    (input, extra: Extra) =>
      runTool(ctx, 'a11y_scan', async () => {
        const config = await ctx.config();
        const guard = await ctx.guard();
        const live = ctx.run?.run.status === 'running' ? ctx.run : undefined;
        if (input.session && live) {
          throw new ToolError(
            'A run is going. A saved login would change it. Call run_finish first, or leave out session.',
            'run_active',
          );
        }

        // Which run, and which pages.
        let store: RunStore | undefined = live;
        let owned: boolean;
        let pending: string[];
        let standard: Standard;
        let checks: CheckName[];
        if (input.runId) {
          // Use the same object for the run that is going, so Walkthrough keeps its changes.
          store =
            live?.run.id === input.runId ? live : RunStore.open(config.projectDir, input.runId);
          const saved = store.run.a11yScan;
          if (!saved?.pending.length)
            throw new ToolError('That scan has no pages left to check.', 'nothing_to_do');
          owned = store !== live;
          pending = saved.pending;
          standard = saved.standard as Standard;
          checks = saved.checks as CheckName[];
        } else {
          standard = input.standard ?? config.accessibility.standard;
          checks = input.checks ?? CHECKS.filter((c) => config.accessibility.checks[c]);
          owned = !live;
          pending = [];
        }
        const tags = standardTags(standard, config.accessibility.bestPractices);

        // Open the browser, and load a saved login if asked.
        if (!ctx.driver?.alive || input.session) {
          await openBrowser(ctx, { session: input.session });
        }
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const startUrl = tab.page.url();

        if (!input.runId) {
          const current = /^https?:/.test(startUrl) ? startUrl : '';
          pending = (input.urls?.length ? input.urls : [current]).map((u) => {
            if (!u) throw new ToolError('Give the pages to check in urls.', 'bad_input');
            return fullUrl(u, current, config.baseUrl);
          });
          // Check every page against the allowed sites before opening any.
          for (const url of pending) guard.check(url);
          if (!store) {
            store = RunStore.create(config.projectDir, {
              name: input.name ?? 'Accessibility check',
              mode: 'autonomous',
              baseUrl: config.baseUrl,
              chrome: driver.chromeVersion,
            });
          }
        }
        if (!store) throw new ToolError('Walkthrough could not start the scan.', 'error');
        const scan = store;
        scan.run.a11yScan = { pending: [...pending], standard, tags, checks };
        if (owned) scan.run.status = 'running';
        scan.save();

        const started = Date.now();
        const total = pending.length;
        const lines: string[] = [];
        let done = 0;
        let stopped: string | undefined;
        const secrets = await ctx.secrets();
        try {
          while (pending.length) {
            if (done > 0 && Date.now() - started > TIME_LIMIT_MS) {
              stopped = 'time';
              break;
            }
            if (extra.signal.aborted) {
              stopped = 'canceled';
              break;
            }
            const url = pending[0] as string;
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
              await extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: token,
                    progress: done,
                    total,
                    message: `Checking ${url}`,
                  },
                })
                .catch(() => undefined);
            }

            const path = pageKey(url);
            let stepId = `a11y-${slug(path, 40, 'page')}`;
            for (let n = 2; scan.run.steps.some((s) => s.id === stepId); n++) {
              stepId = `a11y-${slug(path, 40, 'page')}-${n}`;
            }
            const step = scan.step({ id: stepId, title: `Check accessibility of ${path}` });
            step.checkedBy = 'agent';
            step.at = new Date().toISOString();
            try {
              const problem = await goTo(tab, url);
              if (problem) throw new ToolError(problem, 'navigation_failed');
              const audit = await auditPage(ctx, driver, tab, {
                standard,
                tags,
                checks,
                stepId,
                requestedUrl: pageKey(tab.page.url()) !== path ? url : undefined,
                shots: { root: scan.dir, sub: 'a11y', max: config.accessibility.maxScreenshots },
              });
              scan.run.accessibility ??= [];
              scan.run.accessibility.push(audit.check);
              const wcag = wcagProblems(audit.check);
              const all = [...audit.check.violations, ...customViolations(audit.check)];
              step.status = wcag.length ? 'fail' : 'pass';
              step.actual = all.length
                ? `${all.length} accessibility problem type(s): ${impactLine(all)}.`
                : undefined;
              if (audit.check.requestedUrl) step.notes = `The page went to ${audit.check.url}.`;
              const one = computeScores([audit.check], buildFindings([audit.check]));
              lines.push(
                `- ${path}: ${all.length ? impactLine(all) : 'no problems'}${one.overall !== null ? `, score ${one.overall}` : ''}`,
              );
            } catch (error) {
              step.status = 'blocked';
              step.actual = (error as Error).message;
              lines.push(`- ${path}: could not check it. ${(error as Error).message}`);
              // Nothing else will load either.
              if ((error as ToolError).code === 'connection_refused') throw error;
            } finally {
              pending.shift();
              done += 1;
              scan.run.a11yScan = { pending: [...pending], standard, tags, checks };
              scan.save();
            }
          }
        } finally {
          if (!owned) {
            // Scan steps are not part of the plan's actions. Go back where the plan was.
            ctx.actionCursor = ctx.actionLog.length;
            if (!pending.length) scan.run.a11yScan = undefined;
            scan.save();
            if (/^https?:/.test(startUrl)) await goTo(tab, startUrl).catch(() => undefined);
          } else if (pending.length) {
            // Stopped early: the run is incomplete until the scan goes on.
            scan.markIncomplete();
            writeReports(scan, secrets);
          } else {
            scan.run.a11yScan = undefined;
            scan.finish();
            writeReports(scan, secrets);
          }
        }

        const results = scan.run.accessibility ?? [];
        const findings = buildFindings(results);
        const scores = computeScores(results, findings);
        const out = [
          `Checked ${done} page(s) (${standardLabel(standard)}, extra checks: ${checks.join(', ') || 'none'}).`,
          untrusted(lines.join('\n')),
          scoreLine(scores),
          `Run folder: ${scan.relativeDir}`,
        ];
        if (pending.length) {
          out.push(
            `Checked ${total - pending.length} of ${total} pages${stopped === 'canceled' ? ' before the call was canceled' : ''}. Call a11y_scan again with runId "${scan.run.id}" to go on.`,
          );
        } else {
          if (owned)
            out.push(`Reports: ${scan.relativeDir}/report.md and ${scan.relativeDir}/report.html`);
          out.push(
            `Next, call a11y_report with runId "${scan.run.id}" to get the findings and write the accessibility report.`,
          );
        }
        return out.join('\n');
      }),
  );

  server.registerTool(
    'a11y_report',
    {
      title: 'Accessibility report',
      description:
        'Get the accessibility findings of a run, with IDs and scores, to write the accessibility report. Call it first without items. It returns the findings, a digest, and how to write the text.',
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe(
            'The run folder name. The default is the run that is going, or the newest run with accessibility results.',
          ),
      },
    },
    ({ runId }) =>
      runTool(ctx, 'a11y_report', async () => {
        const { projectDir } = await ctx.config();
        const live = ctx.run?.run.status === 'running' ? ctx.run : undefined;
        const id = runId ?? (live ? undefined : latestA11yRunId(projectDir));
        const store = runId || !live ? (id ? RunStore.open(projectDir, id) : undefined) : live;
        if (!store?.run.accessibility?.length) {
          throw new ToolError(
            'There are no accessibility results yet. Call a11y_scan first.',
            'no_results',
          );
        }
        const checks = store.run.accessibility;
        const findings = buildFindings(checks);
        const scores = computeScores(checks, findings);
        return [
          `Accessibility findings for the run "${store.run.name}" (${store.run.id}): ${findings.findings.length} issue(s) on ${findings.pages.length} page(s). ${findings.review.length} item(s) need review by a person.`,
          scoreLine(scores),
          `Digest: ${findings.digest}`,
          'The findings have text from the web pages:',
          untrusted(findingsText(findings)),
          WRITING_GUIDE,
        ].join('\n');
      }),
  );
}
