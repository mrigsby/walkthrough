import type { Driver, Tab } from '../browser/driver.js';
import type { Context } from '../context.js';
import { scrubText, scrubUrl } from '../evidence/scrub.js';
import type { A11yCheck } from '../run/run-store.js';
import { type AxeResult, formatViolations, runAxe } from './axe.js';
import { type CheckName, STANDARD_LABELS, type Standard } from './standards.js';
import { checkDarkMode, checkReflow } from './visual-checks.js';

export interface AuditRequest {
  // The selector axe gets, and the one the report shows.
  selector?: string;
  label?: string;
  standard: Standard;
  tags: string[];
  checks: CheckName[];
  stepId?: string;
  requestedUrl?: string;
}

export interface PageAudit {
  check: A11yCheck;
  result: AxeResult;
  notes: string[];
}

// Checks one page with axe and the extra checks that were asked for.
export async function auditPage(
  ctx: Context,
  driver: Driver,
  tab: Tab,
  request: AuditRequest,
): Promise<PageAudit> {
  const secrets = await ctx.secrets();
  const guard = await ctx.guard();
  // Snippets can hold secrets and links with tokens.
  const clean = (text: string) => scrubText(secrets.redact(text));
  const wants = (name: CheckName) => request.checks.includes(name);
  const notes: string[] = [];
  // Page-wide checks ignore a selector.
  if (request.selector && request.checks.some((c) => c !== 'frames' && c !== 'screenshots')) {
    notes.push('The extra checks look at the whole page, not only the selected part.');
  }

  const result = await runAxe(tab.page, {
    selector: request.selector,
    tags: request.tags,
    frameAllowed: wants('frames') ? (url) => guard.isAllowed(url) : undefined,
    clean,
  });
  const viewport = tab.page.viewport();
  const check: A11yCheck = {
    at: new Date().toISOString(),
    stepId: request.stepId,
    url: scrubUrl(tab.page.url()),
    requestedUrl: request.requestedUrl ? scrubUrl(request.requestedUrl) : undefined,
    scope: request.label,
    violations: result.violations,
    incomplete: result.incomplete,
    passes: result.passes,
    inapplicable: result.inapplicable,
    engine: result.engine,
    standard: request.standard,
    tags: request.tags,
    colorScheme: driver.emulation.colorScheme ?? 'system',
    viewport: viewport ? `${viewport.width}x${viewport.height}` : 'window size',
    checks: {},
  };
  if (wants('frames') && check.checks) {
    check.checks.framesChecked = result.framesChecked;
    check.checks.framesNotChecked = result.framesNotChecked;
  }
  if (wants('darkMode') && check.checks) {
    const dark = await checkDarkMode(driver, tab, {
      frameAllowed: wants('frames') ? (url) => guard.isAllowed(url) : undefined,
      clean,
    });
    check.checks.darkMode = { darkOnly: dark.darkOnly, lightOnly: dark.lightOnly, dark: dark.dark };
  }
  if (wants('reflow') && check.checks) {
    check.checks.reflow = await checkReflow(driver, tab, { clean });
  }
  return { check, result, notes };
}

// The part of the reply that has page text. Wrap it with untrusted().
export function formatAudit(audit: PageAudit): string {
  const { check } = audit;
  const lines = [
    `Checked: ${check.scope ? `"${check.scope}" at ` : ''}${check.url}`,
    formatViolations(check.violations),
  ];
  const review = check.incomplete?.length ?? 0;
  if (review) {
    lines.push(
      `Needs review (${review}): ${check.incomplete?.map((r) => r.id).join(', ')}. axe could not decide these. A person should check them.`,
    );
  }
  const extra = check.checks ?? {};
  if (extra.framesChecked?.length) lines.push(`Frames checked: ${extra.framesChecked.join(', ')}`);
  for (const frame of extra.framesNotChecked ?? []) {
    lines.push(`Frame not checked: ${frame.url}. ${frame.reason}`);
  }
  if (extra.darkMode) {
    const { darkOnly, lightOnly } = extra.darkMode;
    lines.push(
      darkOnly.length
        ? `Dark mode: ${darkOnly.length} element(s) have low contrast in dark mode only (WCAG 1.4.3 (AA)):`
        : 'Dark mode: no contrast problems that show in dark mode only.',
    );
    for (const node of darkOnly.slice(0, 5)) {
      const ratio = node.contrast
        ? ` (${node.contrast.ratio}:1, needs ${node.contrast.expected}:1)`
        : '';
      lines.push(`  - ${node.target}${ratio}: ${node.html}`);
    }
    if (lightOnly.length)
      lines.push(`  ${lightOnly.length} element(s) have low contrast in light mode only.`);
  }
  if (extra.reflow) {
    const r = extra.reflow;
    lines.push(
      r.overflow
        ? `Reflow: at ${r.width}px wide, the page is ${r.pageWidth}px wide, so it scrolls sideways (WCAG 1.4.10 (AA)). Too wide:`
        : `Reflow: at ${r.width}px wide, the page does not scroll sideways.`,
    );
    for (const node of r.elements) {
      lines.push(`  - ${node.target}: ${node.failureSummary}`, `    ${node.html}`);
    }
  }
  return lines.join('\n');
}

export function standardLabel(standard: string | undefined): string {
  return STANDARD_LABELS[standard as Standard] ?? standard ?? '';
}
