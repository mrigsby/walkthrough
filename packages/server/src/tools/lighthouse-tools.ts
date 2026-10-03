import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { pageKey } from '../audit/findings.js';
import { captureSession, loadSession } from '../browser/sessions.js';
import type { Context } from '../context.js';
import { findLighthouse, LIGHTHOUSE_MISSING } from '../downloads/lighthouse.js';
import { ToolError } from '../errors.js';
import { scrubText } from '../evidence/scrub.js';
import { redactDeep } from '../guards/secrets.js';
import { untrusted } from '../guards/untrusted.js';
import {
  LH_CATEGORIES,
  LH_DEVICES,
  type LhCategory,
  type LhDevice,
} from '../lighthouse/categories.js';
import {
  buildLhFindings,
  compareLh,
  findPreviousLh,
  type LhFinding,
  type LhFindings,
} from '../lighthouse/findings.js';
import { LhFlow } from '../lighthouse/flow.js';
import { auditPage } from '../lighthouse/run.js';
import { tokenizeUnique, withUnique } from '../page/unique.js';
import { runEnvironment } from '../report/common.js';
import {
  buildLhReportData,
  CATEGORY_LABELS,
  type LhItem,
  lhHtml,
  lhJson,
  lhMarkdown,
} from '../report/lh-report.js';
import { type Run, RunStore } from '../run/run-store.js';
import { slug } from '../text.js';
import { fullUrl, pageSummary } from './browser-tools.js';
import { writeReports } from './run-tools.js';
import { runTool, withEnvironment } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// How long one lighthouse call may run. Many clients stop waiting after 60 seconds.
const TIME_LIMIT_MS = Number(process.env.UIWALK_SCAN_LIMIT_MS) || 45_000;

// Scores in one line, like "Performance 98, SEO 82".
function scoresLine(scores: Record<string, number | null>): string {
  return Object.entries(scores)
    .map(([c, s]) => `${CATEGORY_LABELS[c] ?? c} ${s ?? 'n/a'}`)
    .join(', ');
}

// The newest run folder with Lighthouse results, or undefined.
function latestLhRunId(projectDir: string): string | undefined {
  const dir = join(projectDir, '.walkthrough', 'runs');
  if (!existsSync(dir)) return undefined;
  for (const id of readdirSync(dir).sort().reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')) as Run;
      if (run.lighthouse?.length) return id;
    } catch {}
  }
  return undefined;
}

// True for a file inside the project. Links cannot point outside it.
function projectFile(projectDir: string, file: string): boolean {
  try {
    const root = realpathSync(projectDir);
    const real = realpathSync(resolve(projectDir, file));
    return real.startsWith(root + sep) && statSync(real).isFile();
  } catch {
    return false;
  }
}

// One finding, for the agent. The page text in it must go inside untrusted().
function findingText(f: LhFinding, detail: boolean): string {
  const head = `${f.id} [${f.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}] ${f.audit}: ${f.title}. Lowest score ${Math.round(f.worst * 100)} on ${f.pages.length} page(s).`;
  if (!detail) return head;
  const lines = [head];
  if (f.description) lines.push(`  About it: ${f.description}`);
  for (const p of f.pages.slice(0, 3)) {
    lines.push(`  - ${p.page}${p.display ? `: ${p.display}` : ''}`);
    for (const item of p.items.slice(0, 4)) lines.push(`    ${item}`);
  }
  if (f.pages.length > 3) lines.push(`  - and ${f.pages.length - 3} more page(s)`);
  return lines.join('\n');
}

function findingsText(findings: LhFindings, detailed = 30): string {
  if (findings.findings.length === 0) return 'Lighthouse found no problems in these categories.';
  return findings.findings.map((f, i) => findingText(f, i < detailed)).join('\n');
}

const WRITING_GUIDE = [
  'Next, write the report text. Follow references/lighthouse-report.md. For each issue ID, write:',
  '- explain: 1 to 2 short sentences. What is wrong, and what it costs the user (speed, trust, search).',
  '- fix: 1 to 2 short sentences. What to change.',
  '- code (optional): a short example of the fix, up to 12 lines.',
  '- where (optional): the source files and lines, if you find them in the project. Never guess.',
  'Use plain words, short sentences, and no em dashes. Also write a summary of 2 to 4 sentences.',
  'Then call lighthouse_report again with runId, digest, summary, and items.',
].join('\n');

// Findings and the comparison with the last report. Both calls use this.
function prepare(projectDir: string, store: RunStore, compareTo?: string) {
  const checks = store.run.lighthouse ?? [];
  const first = buildLhFindings(checks);
  // A flow compares only with earlier runs of the same plan.
  const plan = checks.some((c) => c.flow) ? store.run.planFile : undefined;
  const previous = findPreviousLh(
    projectDir,
    store.run.id,
    first.pages.map((p) => p.page),
    compareTo,
    plan,
    runEnvironment(store.run).name,
  );
  const comparison = previous ? compareLh(first, previous) : undefined;
  const findings = comparison
    ? buildLhFindings(checks, { keepIds: comparison.keepIds, startAfter: comparison.startAfter })
    : first;
  return { findings, comparison };
}

// One line about a check: scores for a page load, passed audits for the other modes.
function checkLine(check: {
  scores: Record<string, number | null>;
  fractions?: Record<string, { passed: number; total: number }>;
}): string {
  if (!check.fractions) return scoresLine(check.scores);
  return Object.entries(check.fractions)
    .map(([c, f]) => `${CATEGORY_LABELS[c] ?? c} ${f.passed} of ${f.total} audits passed`)
    .join(', ');
}

type FlowAction = 'navigate' | 'start' | 'end' | 'snapshot';

// One step of the run's Lighthouse user flow.
async function flowStep(
  ctx: Context,
  input: {
    action: FlowAction;
    stepId?: string;
    urls?: string[];
    device?: LhDevice;
    categories?: LhCategory[];
  },
): Promise<string> {
  const store = ctx.run?.run.status === 'running' ? ctx.run : undefined;
  if (!store) {
    throw new ToolError(
      'Lighthouse flow steps work only during a run. Call run_start first, or use action audit for single pages.',
      'no_run',
    );
  }
  const config = await ctx.config();
  const secrets = await ctx.secrets();
  const driver = ctx.requireDriver();
  if (ctx.lhFlow?.runId !== store.run.id) {
    const settings = store.run.lhPlan;
    const env = runEnvironment(store.run).name;
    ctx.lhFlow = new LhFlow(
      store.run.id,
      env === 'development' ? store.run.name : `${store.run.name} (${env})`,
      (settings?.device as LhDevice | undefined) ?? input.device ?? config.lighthouse.device,
      (settings?.categories as LhCategory[] | undefined) ??
        input.categories ??
        config.lighthouse.categories,
    );
  }
  const flow = ctx.lhFlow;
  const step = input.stepId ? store.run.steps.find((s) => s.id === input.stepId) : undefined;
  if (input.stepId && !step) {
    throw new ToolError(`There is no step "${input.stepId}" in this run.`, 'bad_input');
  }
  const clean = (text: string) => scrubText(secrets.redact(text));
  const setup = `Lighthouse flow: ${flow.device}, ${flow.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}.`;

  if (input.action === 'start') {
    const tab = driver.activeTab();
    const name = step?.title ?? 'Timespan';
    await flow.start(driver, tab, name, input.stepId);
    return [
      `Lighthouse measures the tab "${tab.name}" now. Walkthrough hides the panel until the end call.`,
      setup,
      `Do the step, then call lighthouse with action end${input.stepId ? ` and stepId "${input.stepId}"` : ''}.`,
    ].join('\n');
  }

  let lhr: Parameters<LhFlow['check']>[0];
  let name: string;
  let stepId = input.stepId;
  let loaded = '';
  if (input.action === 'end') {
    const ended = await flow.end(driver);
    lhr = ended.lhr;
    name = ended.name;
    stepId ??= ended.stepId;
  } else if (input.action === 'navigate') {
    const tab = driver.activeTab();
    const raw = step?.lighthouse?.url ?? input.urls?.[0];
    if (!raw) {
      throw new ToolError(
        'Give the page to load in urls, or the stepId of a step with a navigate action.',
        'bad_input',
      );
    }
    const from = tab.page.url();
    const url = fullUrl(withUnique(raw, ctx.unique), from, config.baseUrl);
    (await ctx.guard()).check(url);
    name = step?.title ?? `Load ${pageKey(url)}`;
    lhr = await flow.navigate(driver, tab, url, name);
    // Keep it with the actions, so reports and exports load the page too.
    ctx.actionLog.push({
      at: new Date().toISOString(),
      tabId: tab.id,
      tab: tab.name,
      action: 'navigate',
      label: url,
      value: tokenizeUnique(url, ctx.unique),
      url: tokenizeUnique(from, ctx.unique),
    });
    loaded = await pageSummary(tab);
  } else {
    const tab = driver.activeTab();
    name = step?.title ?? `Snapshot of ${pageKey(tab.page.url())}`;
    lhr = await flow.snapshot(driver, tab, name);
  }
  const check = flow.check(lhr, { stepId, name }, clean);
  await flow.write(store.dir, secrets);
  store.run.lighthouse ??= [];
  store.run.lighthouse.push(check);
  store.save();
  return [
    `Lighthouse measured ${stepId ? `the step ${stepId}` : `"${name}"`} (${check.mode}) on ${pageKey(check.url)}.`,
    untrusted(checkLine(check)),
    check.audits.length ? `${check.audits.length} audit(s) did not pass.` : '',
    setup,
    `Flow report: ${store.relativeDir}/lighthouse/flow.report.html`,
    loaded,
    stepId ? 'Now check the step as usual, and record its result.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerLighthouseTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'lighthouse',
    {
      title: 'Lighthouse',
      description: [
        'Check pages with Lighthouse, like the Lighthouse panel in DevTools: performance, best practices, SEO, and more.',
        'action "audit" checks each page in its own hidden Chrome with a copy of the active tab\'s login, so each check starts from the same state. Without a run, it makes a run with one step per page.',
        'During a run, the actions navigate, start, end, and snapshot measure the steps of a user flow in the active tab.',
        'Then call lighthouse_report. action "status" shows whether Lighthouse is installed.',
      ].join(' '),
      inputSchema: {
        action: z
          .enum(['audit', 'navigate', 'start', 'end', 'snapshot', 'status'])
          .default('audit')
          .describe(
            'audit: check pages. navigate: Lighthouse loads a page in the active tab. start and end: measure what happens between them. snapshot: check the page as it is.',
          ),
        stepId: z
          .string()
          .optional()
          .describe('For flow actions: the plan step that Lighthouse measures.'),
        urls: z
          .array(z.string().min(1))
          .max(30)
          .optional()
          .describe(
            'Pages like "/" or full URLs. The default is the current page. For navigate: the page to load, when the step has no navigate action.',
          ),
        runId: z.string().optional().describe('Continue a check that stopped at its time limit.'),
        name: z.string().optional().describe('A name for the new run.'),
        session: z
          .string()
          .optional()
          .describe("A saved login for the checks, instead of a copy of the active tab's login."),
        device: z
          .enum(LH_DEVICES)
          .optional()
          .describe('desktop or mobile. The default comes from config.yaml.'),
        categories: z
          .array(z.enum(LH_CATEGORIES))
          .min(1)
          .optional()
          .describe('The categories to check. The default comes from config.yaml.'),
        environment: z
          .string()
          .optional()
          .describe(
            'Switch the session to this environment first, like "staging". Only when the developer asks for it.',
          ),
      },
    },
    (input, extra: Extra) =>
      runTool(ctx, 'lighthouse', () =>
        withEnvironment(ctx, input.environment, extra, async () => {
          const config = await ctx.config();
          if (input.action === 'status') {
            const found = findLighthouse();
            return found
              ? `Lighthouse ${found.version} is installed: ${found.dir}`
              : LIGHTHOUSE_MISSING;
          }
          if (!findLighthouse()) throw new ToolError(LIGHTHOUSE_MISSING, 'lighthouse_missing');
          if (input.action !== 'audit') return flowStep(ctx, { ...input, action: input.action });
          const guard = await ctx.guard();
          const secrets = await ctx.secrets();
          const live = ctx.run?.run.status === 'running' ? ctx.run : undefined;
          if (live && ctx.lhFlow?.runId === live.run.id && ctx.lhFlow.timespan) {
            throw new ToolError(
              'A Lighthouse timespan is going. Call lighthouse with action end first.',
              'timespan_active',
            );
          }
          let store: RunStore | undefined = live;
          let owned: boolean;
          let pending: string[];
          let device: LhDevice;
          let categories: LhCategory[];
          if (input.runId) {
            store =
              live?.run.id === input.runId ? live : RunStore.open(config.projectDir, input.runId);
            const saved = store.run.lhScan;
            if (!saved?.pending.length)
              throw new ToolError('That check has no pages left.', 'nothing_to_do');
            owned = store !== live;
            pending = saved.pending;
            device = saved.device as LhDevice;
            categories = saved.categories as LhCategory[];
          } else {
            device = input.device ?? config.lighthouse.device;
            categories = input.categories ?? config.lighthouse.categories;
            owned = !live;
            pending = [];
          }

          // The checks run in their own Chrome, so the test browser does not have to be open.
          const driver = ctx.driver?.alive && ctx.driver.hasActiveTab ? ctx.driver : undefined;
          const tabUrl = driver?.activeTab().page.url() ?? '';
          const current = /^https?:/.test(tabUrl) ? tabUrl : '';

          if (!input.runId) {
            pending = (input.urls?.length ? input.urls : [current]).map((u) => {
              if (!u) throw new ToolError('Give the pages to check in urls.', 'bad_input');
              return fullUrl(u, current, config.baseUrl);
            });
            for (const url of pending) guard.check(url);
            store ??= RunStore.create(config.projectDir, {
              name: input.name ?? 'Lighthouse check',
              mode: 'autonomous',
              baseUrl: config.baseUrl,
              chrome: driver?.chromeVersion,
            });
          }
          if (!store) throw new ToolError('Walkthrough could not start the check.', 'error');
          const scan = store;
          scan.run.lhScan = { pending: [...pending], device, categories };
          if (owned) scan.run.status = 'running';
          scan.save();

          // A saved login, or a copy of the active tab's login. It stays in memory.
          const login = input.session
            ? loadSession(config.projectDir, input.session, config.environment.name)
            : driver
              ? await captureSession(
                  driver,
                  guard,
                  'lighthouse',
                  pending.map((u) => new URL(u).hostname),
                )
              : undefined;
          // Rules for one tab stay with that tab.
          const rules = driver?.mocks.filter((r) => !r.tab) ?? [];
          const clean = (text: string) => scrubText(secrets.redact(text));
          const started = Date.now();
          const total = pending.length;
          const lines: string[] = [];
          let done = 0;
          let stopped: string | undefined;
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
                      message: `Lighthouse on ${url}`,
                    },
                  })
                  .catch(() => undefined);
              }
              const path = pageKey(url);
              let stepId = `lh-${slug(path, 40, 'page')}`;
              for (let n = 2; scan.run.steps.some((s) => s.id === stepId); n++) {
                stepId = `lh-${slug(path, 40, 'page')}-${n}`;
              }
              const step = scan.step({ id: stepId, title: `Check ${path} with Lighthouse` });
              step.checkedBy = 'agent';
              step.at = new Date().toISOString();
              try {
                const check = await auditPage(url, {
                  config,
                  login,
                  isAllowed: (u) => guard.isAllowed(u),
                  rules,
                  device,
                  categories,
                  runDir: scan.dir,
                  index: (scan.run.lighthouse?.length ?? 0) + 1,
                  secrets,
                  clean,
                  network: ctx.network,
                });
                check.stepId = stepId;
                if (pageKey(check.url) !== path) check.requestedUrl = url;
                scan.run.lighthouse ??= [];
                scan.run.lighthouse.push(check);
                step.status = 'pass';
                step.actual = `${scoresLine(check.scores)}. ${check.audits.length} audit(s) did not pass.`;
                lines.push(
                  `- ${path}: ${scoresLine(check.scores)}. ${check.audits.length} audit(s) did not pass.`,
                );
              } catch (error) {
                step.status = 'blocked';
                step.actual = (error as Error).message;
                lines.push(`- ${path}: could not check it. ${(error as Error).message}`);
                const code = (error as ToolError).code;
                if (['lighthouse_missing', 'chrome_missing', 'launch_failed'].includes(code))
                  throw error;
              } finally {
                pending.shift();
                done += 1;
                scan.run.lhScan = { pending: [...pending], device, categories };
                scan.save();
              }
            }
          } finally {
            if (!owned) {
              // These steps are not part of the plan's actions.
              ctx.actionCursor = ctx.actionLog.length;
              if (!pending.length) scan.run.lhScan = undefined;
              scan.save();
            } else if (pending.length) {
              scan.markIncomplete();
              writeReports(scan, secrets);
            } else {
              scan.run.lhScan = undefined;
              scan.finish();
              writeReports(scan, secrets);
            }
          }

          const out = [
            `Checked ${done} page(s) with Lighthouse (${device}, ${categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}).`,
            untrusted(lines.join('\n')),
            'Scores from a dev machine change from run to run. Compare changes between runs more than the numbers.',
            `Run folder: ${scan.relativeDir}`,
          ];
          if (pending.length) {
            out.push(
              `Checked ${total - pending.length} of ${total} pages${stopped === 'canceled' ? ' before the call was canceled' : ''}. Call lighthouse again with runId "${scan.run.id}" to continue.`,
            );
          } else {
            out.push(
              `Next, call lighthouse_report with runId "${scan.run.id}" to get the findings and write the report.`,
            );
          }
          return out.join('\n');
        }),
      ),
  );

  server.registerTool(
    'lighthouse_report',
    {
      title: 'Lighthouse report',
      description:
        'Write the Lighthouse report of a run: lighthouse.html, lighthouse.md, and lighthouse.json, next to report.html. Call it first without items: it returns the findings, the scores, a digest, and how to write the text. Then call it with digest, summary, and items.',
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe(
            'The run folder name. The default is the run that is going, or the newest run with Lighthouse results.',
          ),
        digest: z.string().optional().describe('The digest from the first call.'),
        summary: z
          .string()
          .max(1200)
          .optional()
          .describe('2 to 4 short sentences about the results.'),
        items: z
          .array(
            z.object({
              id: z.string().describe('The issue ID, like LH-001.'),
              explain: z.string().min(1).max(400).describe('1 to 2 sentences: what is wrong.'),
              fix: z.string().min(1).max(400).describe('1 to 2 sentences: how to fix it.'),
              code: z.string().max(1200).optional().describe('A short example of the fix.'),
              where: z
                .array(
                  z.object({
                    file: z
                      .string()
                      .min(1)
                      .describe('A file in the project, from the project folder.'),
                    line: z.number().int().min(1).optional(),
                  }),
                )
                .max(3)
                .optional()
                .describe('Where to fix it in the source, if you found it.'),
            }),
          )
          .optional(),
        compareTo: z
          .string()
          .optional()
          .describe(
            'Compare with the report of this run. The default is the last report of the same pages.',
          ),
      },
    },
    ({ runId, digest, summary, items, compareTo }) =>
      runTool(ctx, 'lighthouse_report', async () => {
        const { projectDir } = await ctx.config();
        const live = ctx.run?.run.status === 'running' ? ctx.run : undefined;
        const id = runId ?? (live ? undefined : latestLhRunId(projectDir));
        const store = runId || !live ? (id ? RunStore.open(projectDir, id) : undefined) : live;
        if (!store?.run.lighthouse?.length) {
          throw new ToolError(
            'There are no Lighthouse results yet. Call lighthouse first.',
            'no_results',
          );
        }
        const { findings, comparison } = prepare(projectDir, store, compareTo);
        const scoreLines = findings.pages.map((p) => `- ${p.page}: ${checkLine(p)}`).join('\n');
        const compareLine = comparison
          ? `Compared with the report of run ${comparison.previousRunId}: issues that are still there keep their IDs. Fixed since then: ${comparison.fixed.length}. Score changes: ${comparison.changes.map((c) => `${c.page} ${CATEGORY_LABELS[c.category] ?? c.category} ${c.before ?? 'n/a'} to ${c.after ?? 'n/a'}`).join('; ') || 'none'}.`
          : '';

        if (!items) {
          return [
            `Lighthouse findings for the run "${store.run.name}" (${store.run.id}): ${findings.findings.length} issue(s) on ${findings.pages.length} page(s).`,
            'Scores:',
            untrusted(scoreLines),
            compareLine,
            `Digest: ${findings.digest}`,
            'The findings have text from the web pages:',
            untrusted(findingsText(findings)),
            WRITING_GUIDE,
          ]
            .filter(Boolean)
            .join('\n');
        }

        if (digest !== findings.digest) {
          throw new ToolError(
            [
              digest
                ? 'The findings changed after the first call, so the IDs may point to other issues now. Write the text again for these findings.'
                : 'Give the digest from the first call.',
              `Digest: ${findings.digest}`,
              untrusted(findingsText(findings)),
            ].join('\n'),
            'digest_changed',
          );
        }
        const known = new Set(findings.findings.map((f) => f.id));
        const unknown = items.filter((i) => !known.has(i.id)).map((i) => i.id);
        if (unknown.length) {
          throw new ToolError(
            `There is no issue ${unknown.join(', ')} in this run. The IDs are: ${[...known].join(', ') || 'none'}.`,
            'bad_id',
          );
        }
        const warnings: string[] = [];
        const texts: Record<string, LhItem> = {};
        for (const item of items) {
          const where = (item.where ?? []).filter((w) => {
            const ok = projectFile(projectDir, w.file);
            if (!ok)
              warnings.push(`${item.id}: left out "${w.file}". It is not a file in the project.`);
            return ok;
          });
          texts[item.id] = {
            explain: item.explain,
            fix: item.fix,
            code: item.code,
            where: where.length ? where : undefined,
          };
        }
        const missing = findings.findings.filter((f) => !texts[f.id]);
        for (const f of missing) {
          texts[f.id] = {
            explain: f.title,
            fix: 'See the Lighthouse report of the page.',
            fallback: true,
          };
        }
        if (missing.length)
          warnings.push(
            `No text for ${missing.map((f) => f.id).join(', ')}. The report uses the Lighthouse title for them.`,
          );

        const secrets = await ctx.secrets();
        const data = redactDeep(
          buildLhReportData({
            run: store.run,
            relativeDir: store.relativeDir,
            findings,
            comparison,
            items: texts,
            summary: summary ?? '',
          }),
          secrets,
        );
        const files = {
          html: join(store.dir, 'lighthouse.html'),
          md: join(store.dir, 'lighthouse.md'),
          json: join(store.dir, 'lighthouse.json'),
        };
        writeFileSync(files.html, secrets.redact(lhHtml(data)));
        writeFileSync(files.md, secrets.redact(lhMarkdown(data)));
        writeFileSync(files.json, `${secrets.redact(JSON.stringify(lhJson(data), null, 2))}\n`);
        writeReports(store, secrets);
        return [
          `Wrote the Lighthouse report for the run "${store.run.name}":`,
          ...Object.values(files).map((f) => `- ${relative(projectDir, f)}`),
          compareLine,
          ...(warnings.length ? ['Warnings:', ...warnings.map((w) => `- ${w}`)] : []),
          'Show this prompt to the developer in a code block. They can paste it into a new session to plan the fixes:',
          data.prompt,
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );
}
