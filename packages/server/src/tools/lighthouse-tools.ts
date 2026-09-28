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
import { auditPage } from '../lighthouse/run.js';
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
import { fullUrl, openBrowser } from './browser-tools.js';
import { writeReports } from './run-tools.js';
import { runTool } from './util.js';

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
  const previous = findPreviousLh(
    projectDir,
    store.run.id,
    first.pages.map((p) => p.page),
    compareTo,
  );
  const comparison = previous ? compareLh(first, previous) : undefined;
  const findings = comparison
    ? buildLhFindings(checks, { keepIds: comparison.keepIds, startAfter: comparison.startAfter })
    : first;
  return { findings, comparison };
}

export function registerLighthouseTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'lighthouse',
    {
      title: 'Lighthouse',
      description: [
        'Check pages with Lighthouse, like the Lighthouse panel in DevTools: performance, best practices, SEO, and more.',
        'Each page runs in a new tab of the same login, so it stays logged in. Without a run, it makes a run with one step per page.',
        'Then call lighthouse_report. action "status" shows whether Lighthouse is installed.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['audit', 'status']).default('audit'),
        urls: z
          .array(z.string().min(1))
          .max(30)
          .optional()
          .describe('Pages like "/" or full URLs. The default is the current page.'),
        runId: z.string().optional().describe('Continue a check that stopped at its time limit.'),
        name: z.string().optional().describe('A name for the new run.'),
        session: z
          .string()
          .optional()
          .describe('A saved login to load first. Only when no run is going.'),
        device: z
          .enum(LH_DEVICES)
          .optional()
          .describe('desktop or mobile. The default comes from config.yaml.'),
        categories: z
          .array(z.enum(LH_CATEGORIES))
          .min(1)
          .optional()
          .describe('The categories to check. The default comes from config.yaml.'),
      },
    },
    (input, extra: Extra) =>
      runTool(ctx, 'lighthouse', async () => {
        const config = await ctx.config();
        if (input.action === 'status') {
          const found = findLighthouse();
          return found
            ? `Lighthouse ${found.version} is installed: ${found.dir}`
            : LIGHTHOUSE_MISSING;
        }
        if (!findLighthouse()) throw new ToolError(LIGHTHOUSE_MISSING, 'lighthouse_missing');
        const guard = await ctx.guard();
        const secrets = await ctx.secrets();
        const live = ctx.run?.run.status === 'running' ? ctx.run : undefined;
        if (input.session && live) {
          throw new ToolError(
            'A run is going. A saved login would change it. Call run_finish first, or leave out session.',
            'run_active',
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

        if (!ctx.driver?.alive || input.session) await openBrowser(ctx, { session: input.session });
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();

        if (!input.runId) {
          const current = /^https?:/.test(tab.page.url()) ? tab.page.url() : '';
          pending = (input.urls?.length ? input.urls : [current]).map((u) => {
            if (!u) throw new ToolError('Give the pages to check in urls.', 'bad_input');
            return fullUrl(u, current, config.baseUrl);
          });
          for (const url of pending) guard.check(url);
          store ??= RunStore.create(config.projectDir, {
            name: input.name ?? 'Lighthouse check',
            mode: 'autonomous',
            baseUrl: config.baseUrl,
            chrome: driver.chromeVersion,
          });
        }
        if (!store) throw new ToolError('Walkthrough could not start the check.', 'error');
        const scan = store;
        scan.run.lhScan = { pending: [...pending], device, categories };
        if (owned) scan.run.status = 'running';
        scan.save();

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
              const check = await auditPage(driver, tab, url, {
                device,
                categories,
                runDir: scan.dir,
                index: (scan.run.lighthouse?.length ?? 0) + 1,
                secrets,
                clean,
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
              if (code === 'lighthouse_missing' || code === 'connection_refused') throw error;
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
        const scoreLines = findings.pages
          .map((p) => `- ${p.page}: ${scoresLine(p.scores)}`)
          .join('\n');
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
