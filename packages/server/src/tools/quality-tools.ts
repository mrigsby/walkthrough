import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElementHandle } from 'puppeteer-core';
import { z } from 'zod';
import { auditPage, formatAudit, type PageAudit, standardLabel } from '../audit/audit-page.js';
import { customViolations } from '../audit/custom-rules.js';
import { CHECKS, STANDARDS, type Standard, standardTags } from '../audit/standards.js';
import { describeEmulation, NETWORKS } from '../browser/devices.js';
import { deleteSession, listSessions, saveSession } from '../browser/sessions.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { resolveTarget } from '../page/actions.js';
import { stableSelector } from '../page/selectors.js';
import { fileStamp } from '../project-files.js';
import { slug } from '../text.js';
import { steadyCapture } from '../visual/capture.js';
import { comparePng } from '../visual/compare.js';
import { type Content, runTool, textResult } from './util.js';

// True for plain CSS. axe cannot read Puppeteer-only selectors.
function isPlainCss(selector: string): boolean {
  return !/::-p-|>>>/.test(selector);
}

export function registerQualityTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'session',
    {
      title: 'Saved logins',
      description:
        'Save the login state (cookies and storage) of the allowed sites that are open, so later runs start logged in. Or list or delete saved logins. To use one, call browser_open with session, or set "session" in a plan.',
      inputSchema: {
        action: z.enum(['save', 'list', 'delete']),
        name: z.string().optional().describe('A name like "admin" or "demo-user".'),
      },
    },
    ({ action, name }) =>
      runTool(ctx, 'session', async () => {
        const { projectDir } = await ctx.config();
        if (action === 'list') {
          const sessions = listSessions(projectDir);
          if (sessions.length === 0) return 'There are no saved logins.';
          return sessions
            .map(
              (s) =>
                `- ${s.name}: saved ${s.savedAt}, sites ${s.origins.join(', ')}, ${s.cookies.length} cookie(s)`,
            )
            .join('\n');
        }
        if (!name) throw new ToolError('Give a name for the saved login.', 'bad_input');
        if (action === 'delete') {
          deleteSession(projectDir, name);
          return `Deleted the saved login "${name}".`;
        }
        const session = await saveSession(ctx.requireDriver(), await ctx.guard(), projectDir, name);
        const keys = Object.values(session.storage).reduce(
          (n, s) => n + Object.keys(s.local).length + Object.keys(s.session).length,
          0,
        );
        return [
          `Saved the login "${name}" for ${session.origins.join(', ')}: ${session.cookies.length} cookie(s) and ${keys} storage value(s).`,
          `File: .walkthrough/sessions/${name}.json. Git does not track it, and only your user account can read it.`,
          'This file can log anyone in as this user. Do not share it.',
          'Walkthrough does not save logins that the app keeps in IndexedDB.',
        ].join('\n');
      }),
  );

  server.registerTool(
    'emulate',
    {
      title: 'Screen, color, and network',
      description:
        'Test like a phone, tablet, or other screen, in light or dark mode, or on a slow network. Settings apply to all tabs, also new ones.',
      inputSchema: {
        device: z
          .string()
          .optional()
          .describe(
            'desktop, laptop, tablet, mobile, default, or a Puppeteer device name like "Pixel 5".',
          ),
        colorScheme: z.enum(['light', 'dark', 'system']).optional(),
        network: z.enum(NETWORKS).optional(),
      },
    },
    ({ device, colorScheme, network }) =>
      runTool(ctx, 'emulate', async () => {
        const driver = ctx.requireDriver();
        driver.activeTab();
        if (device === undefined && colorScheme === undefined && network === undefined) {
          return `Now: ${describeEmulation(driver.emulation)}.`;
        }
        const reloaded = await driver.setEmulation(
          { device, colorScheme, network },
          { reload: true },
        );
        return [
          `Now: ${describeEmulation(driver.emulation)}.`,
          reloaded.length
            ? `Reloaded ${reloaded.join(', ')}, because the page switched between desktop and phone mode.`
            : '',
          'Take a new snapshot. The page layout can be different now.',
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );

  server.registerTool(
    'visual_check',
    {
      title: 'Visual check',
      description: [
        'Compare the page, or one element, with a saved baseline screenshot.',
        'The first check saves the baseline. Later checks show the changed pixels in a diff image.',
        'Only use updateBaseline after the developer says the change is expected.',
      ].join(' '),
      inputSchema: {
        name: z.string().describe('A name for this check, like the step id "cart-total".'),
        ref: z.string().optional().describe('Check one element, from the last snapshot.'),
        selector: z.string().optional(),
        fullPage: z.boolean().optional(),
        mask: z
          .array(z.string())
          .optional()
          .describe(
            'Selectors for parts that change on every load, like dates. Walkthrough ignores them.',
          ),
        maxDiffPercent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe(
            'How much can change, in percent of pixels. The default is 0, so the check finds any real change. It always ignores small edge noise.',
          ),
        updateBaseline: z
          .boolean()
          .optional()
          .describe('Save this screenshot as the new baseline.'),
        stepId: z.string().optional().describe('During a run: add the images to this step.'),
      },
    },
    (input) =>
      runTool(ctx, 'visual_check', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const config = await ctx.config();
        const target = await resolveTarget(driver, tab, {
          ref: input.ref,
          selector: input.selector,
        });

        // One baseline per check, screen preset, and operating system, because fonts differ.
        const group = ctx.run?.run.planFile
          ? basename(ctx.run.run.planFile, extname(ctx.run.run.planFile))
          : 'adhoc';
        const device = slug(driver.emulation.device ?? 'default', 60, 'check');
        const file = `${slug(input.name, 60, 'check')}@${device}-${process.platform}.png`;
        const baselinePath = join(config.projectDir, '.walkthrough', 'baselines', group, file);
        const baselineRel = relative(config.projectDir, baselinePath);

        const capture = await steadyCapture(driver, tab, {
          handle: target?.handle,
          fullPage: input.fullPage,
          mask: input.mask,
        });

        if (!existsSync(baselinePath) || input.updateBaseline) {
          const existed = existsSync(baselinePath);
          mkdirSync(dirname(baselinePath), { recursive: true });
          writeFileSync(baselinePath, capture.png);
          return textResult(
            existed
              ? `result: updated\nSaved a new baseline: ${baselineRel}`
              : `result: created\nThere was no baseline, so this screenshot is now the baseline: ${baselineRel}. The next check compares with it.`,
            [{ type: 'image', data: capture.png.toString('base64'), mimeType: 'image/png' }],
          );
        }

        const comparison = comparePng(readFileSync(baselinePath), capture.png, capture.masks);
        const limit = input.maxDiffPercent ?? 0;
        const matches = comparison.sameSize && comparison.diffPercent <= limit;
        const dir = ctx.evidenceDir(config.projectDir);
        const stamp = fileStamp(`visual-${input.name}`);
        const actualPath = join(dir, `${stamp}-actual.png`);
        const lines: string[] = [];
        const images: Content[] = [];
        const saved: string[] = [];

        if (matches) {
          lines.push(
            'result: match',
            `The page matches the baseline ${baselineRel} (${comparison.diffPercent.toFixed(3)}% of pixels changed, limit ${limit}%).`,
          );
        } else {
          writeFileSync(actualPath, capture.png);
          saved.push(actualPath);
          lines.push('result: mismatch');
          if (!comparison.sameSize) {
            lines.push(
              `The size changed: the baseline is ${comparison.baselineSize.width}x${comparison.baselineSize.height}, and now it is ${comparison.width}x${comparison.height}.`,
            );
          } else {
            lines.push(
              `${comparison.diffPercent.toFixed(3)}% of pixels changed (${comparison.diffPixels} pixels). The limit is ${limit}%.`,
            );
          }
          if (comparison.diffPng) {
            const diffPath = join(dir, `${stamp}-diff.png`);
            writeFileSync(diffPath, comparison.diffPng);
            saved.push(diffPath);
            lines.push(
              `Diff image (changed pixels in red): ${relative(config.projectDir, diffPath)}`,
            );
            images.push({
              type: 'image',
              data: comparison.diffPng.toString('base64'),
              mimeType: 'image/png',
            });
          }
          lines.push(
            `Screenshot now: ${relative(config.projectDir, actualPath)}`,
            `Baseline: ${baselineRel}`,
          );
          lines.push(
            'Ask the developer whether this change is expected. If yes, call visual_check again with updateBaseline: true. If not, record the step as failed.',
          );
        }

        // Keep the images with the run step.
        if (input.stepId && ctx.run?.run.status === 'running' && saved.length) {
          const step = ctx.run.step({ id: input.stepId });
          step.screenshots.push(...saved.map((p) => relative(ctx.run?.dir ?? '', p)));
          ctx.run.save();
        }
        return textResult(lines.join('\n'), images);
      }),
  );

  server.registerTool(
    'a11y_audit',
    {
      title: 'Accessibility audit',
      description:
        'Check the page, or one element, for accessibility problems with axe-core. It groups the results by impact: critical, serious, moderate, minor, and names the WCAG criteria. Extra checks run only when you ask for them.',
      inputSchema: {
        ref: z.string().optional().describe('Check one part of the page, from the last snapshot.'),
        selector: z.string().optional(),
        standard: z
          .enum(STANDARDS)
          .optional()
          .describe('The standard to check. The default comes from config.yaml (wcag22aa).'),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Only these axe-core rule groups, like ["wcag2a", "wcag2aa"]. Wins over standard.',
          ),
        checks: z
          .array(z.enum(CHECKS))
          .optional()
          .describe(
            'Extra checks: keyboard (press Tab through the page), darkMode (contrast in light and dark mode), reflow (sideways scrolling at 320px), frames (frames on allowed sites), screenshots (a picture of each problem).',
          ),
        stepId: z
          .string()
          .optional()
          .describe('During a run: add the results to this step and the report.'),
      },
    },
    ({ ref, selector, standard, tags, checks, stepId }) =>
      runTool(ctx, 'a11y_audit', async () => {
        const config = await ctx.config();
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const store = ctx.run?.run.status === 'running' ? ctx.run : undefined;
        if (stepId && !store)
          throw new ToolError('No run is going, so there is no step to add it to.', 'no_run');
        if (stepId && store?.run.planFile && !store.run.steps.some((s) => s.id === stepId)) {
          throw new ToolError(
            `The plan has no step "${stepId}". Use a step id from run_start.`,
            'bad_step',
          );
        }

        // The selector the report shows, and the one axe gets.
        // A plan step with "a11y" gives the checks and the selector, unless the call does.
        const planned = stepId ? store?.run.steps.find((s) => s.id === stepId)?.a11y : undefined;
        if (!ref && !selector && planned?.selector) selector = planned.selector;
        let label = selector;
        let scope = selector;
        let marked: ElementHandle<Element> | undefined;
        if (ref || (selector && !isPlainCss(selector))) {
          const target = await resolveTarget(driver, tab, { ref, selector });
          if (!target) throw new ToolError('Give a ref or a selector.', 'bad_target');
          if (target.handle.frame !== tab.page.mainFrame()) {
            throw new ToolError(
              'That element is inside a frame. Walkthrough checks the top page only.',
              'bad_target',
            );
          }
          label = ref ? ((await stableSelector(target.handle, target)) ?? target.label) : selector;
          if (label && isPlainCss(label)) scope = label;
          else {
            // axe reads plain CSS only. Mark the element for a moment instead.
            const mark = randomBytes(4).toString('hex');
            await target.handle.evaluate((el, m) => el.setAttribute('data-uiwalk-a11y', m), mark);
            marked = target.handle;
            scope = `[data-uiwalk-a11y="${mark}"]`;
          }
        }
        const std =
          standard ??
          (store?.run.a11yPlan?.standard as Standard | undefined) ??
          config.accessibility.standard;
        let audit: PageAudit;
        try {
          audit = await auditPage(ctx, driver, tab, {
            selector: scope,
            label,
            standard: std,
            tags: tags ?? standardTags(std, config.accessibility.bestPractices),
            checks: checks ?? planned?.checks ?? [],
            stepId,
            shots: {
              // In a run, next to the run's screenshots. Otherwise in today's folder.
              root: dirname(ctx.evidenceDir(config.projectDir)),
              sub: 'a11y',
              max: config.accessibility.maxScreenshots,
            },
          });
        } finally {
          await marked
            ?.evaluate((el) => el.removeAttribute('data-uiwalk-a11y'))
            .catch(() => undefined);
        }
        if (store) {
          if (stepId && !store.run.planFile) store.step({ id: stepId });
          store.run.accessibility ??= [];
          store.run.accessibility.push(audit.check);
          store.save();
        }
        const violations = [...audit.check.violations, ...customViolations(audit.check)];
        const count = violations.reduce((n, v) => n + (v.nodeCount ?? v.nodes.length), 0);
        return [
          `Accessibility check (${standardLabel(std)}, ${audit.result.engine}): ${violations.length} problem type(s), ${count} element(s).`,
          ...audit.notes,
          untrusted(formatAudit(audit)),
          audit.check.shots?.length
            ? `Screenshots of the problems (${audit.check.shots.length}) are in ${relative(config.projectDir, join(dirname(ctx.evidenceDir(config.projectDir)), 'a11y'))}.`
            : '',
          store ? 'Walkthrough added these results to the run report.' : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );
}
