import { randomBytes } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { ToolError } from '../errors.js';
import { axeSource } from './axe-source.js';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yViolation {
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: string; html: string }>;
}

export const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

// Runs axe-core in an isolated world, so the page cannot see or change it.
// It checks the top page only. It does not check frames inside the page.
// A target inside a shadow root looks like "host >>> inner". Puppeteer can find it.
export async function runAxe(
  page: Page,
  options: { selector?: string; tags?: string[] },
): Promise<A11yViolation[]> {
  const cdp = await page.createCDPSession();
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: `uiwalk-axe-${randomBytes(4).toString('hex')}`,
    });
    const load = await cdp.send('Runtime.evaluate', {
      expression: axeSource(),
      contextId: executionContextId,
    });
    if (load.exceptionDetails)
      throw new ToolError('The accessibility checker could not start on this page.', 'axe_failed');

    // Skip the Walkthrough panel. It is not part of the app.
    const context = {
      ...(options.selector ? { include: [[options.selector]] } : {}),
      exclude: [['uiwalk-panel']],
    };
    const runOptions = {
      resultTypes: ['violations'],
      iframes: false,
      ...(options.tags?.length ? { runOnly: { type: 'tag', values: options.tags } } : {}),
    };
    const expression = `axe.run(${JSON.stringify(context)}, ${JSON.stringify(runOptions)}).then((r) => JSON.stringify(r.violations.map((v) => ({
      id: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)).join(' '),
        html: n.html.slice(0, 300),
      })),
    }))))`;
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new ToolError(`The accessibility check failed: ${text.split('\n')[0]}`, 'axe_failed');
    }
    const violations = JSON.parse(String(result.result.value)) as A11yViolation[];
    return violations.sort(
      (a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact),
    );
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export function formatViolations(violations: A11yViolation[]): string {
  if (violations.length === 0) return 'No accessibility problems found.';
  const lines: string[] = [];
  for (const impact of IMPACT_ORDER) {
    const group = violations.filter((v) => v.impact === impact);
    if (group.length === 0) continue;
    lines.push(`${impact.toUpperCase()} (${group.length}):`);
    for (const v of group) {
      lines.push(
        `- ${v.id}: ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'}) ${v.helpUrl}`,
      );
      for (const node of v.nodes.slice(0, 3)) lines.push(`  - ${node.target}: ${node.html}`);
      if (v.nodes.length > 3) lines.push(`  - and ${v.nodes.length - 3} more`);
    }
  }
  return lines.join('\n');
}
