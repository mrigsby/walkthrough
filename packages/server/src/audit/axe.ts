import { randomBytes } from 'node:crypto';
import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import { ToolError } from '../errors.js';
import { axeSource } from './axe-source.js';
import { criteriaLabel } from './wcag.js';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yNode {
  // A CSS selector in its own frame. A shadow DOM path looks like "host >>> inner".
  target: string;
  html: string;
  failureSummary?: string;
  // Color contrast data from axe, when the rule is about contrast.
  contrast?: { fg: string; bg: string; ratio: number; expected: number };
  // Set when the element is inside a frame: the frame page and the iframe in its parent.
  frame?: { url: string; selector: string };
}

export interface A11yViolation {
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  nodes: A11yNode[];
  description?: string;
  tags?: string[];
  // The rule's own impact. It stays the same from run to run, so scores use it.
  ruleImpact?: Impact;
  // All the elements axe found. Only the first MAX_NODES are kept.
  nodeCount?: number;
}

export interface A11yPass {
  id: string;
  ruleImpact: Impact;
  tags: string[];
}

export interface AxeResult {
  engine: string;
  violations: A11yViolation[];
  // "Needs review": axe could not decide.
  incomplete: A11yViolation[];
  passes: A11yPass[];
  inapplicable: number;
  framesChecked: string[];
  framesNotChecked: Array<{ url: string; reason: string }>;
}

export const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];
const MAX_NODES = 50;
const MAX_HTML = 300;

export interface AxeOptions {
  selector?: string;
  tags?: string[];
  // Run only these rules, like ["color-contrast"].
  rules?: string[];
  // Check frames too. Only frames this function allows are checked.
  frameAllowed?: (url: string) => boolean;
  // Cleans each snippet (hides secrets and tokens) before it is cut short.
  clean?: (text: string) => string;
}

// Runs axe in the page and returns the results as JSON text.
// It runs in an isolated world, so the page cannot see or change it.
const RUN_IN_PAGE = `(async (context, options, maxNodes, inFrame) => {
  const rules = (axe._audit && axe._audit.rules) || [];
  const ruleImpact = (id) => (rules.find((r) => r.id === id) || {}).impact || null;
  // Walkthrough checks frames itself, so skip axe's "frame-tested" rule.
  // In a frame, also skip rules about the whole page, like "one main landmark".
  // axe marks them as page level, as top page only, or as rules that join frame results.
  const joins = (r) => [...r.any, ...r.all, ...r.none].some((c) => {
    const check = axe._audit.checks[typeof c === 'string' ? c : c.id];
    return Boolean(check && check.after);
  });
  const pageWide = (r) => r.pageLevel || /initiator/.test(String(r.matches)) || joins(r);
  const skip = (id) => {
    const r = rules.find((x) => x.id === id);
    return id === 'frame-tested' || Boolean(r && inFrame && pageWide(r));
  };
  const only = options.runOnly;
  const experimental = (r) => (r.tags || []).includes('experimental');
  const ids = only && only.type === 'rule'
    ? only.values
    : only && only.type === 'tag'
      ? axe.getRules(only.values).filter((r) => !experimental(r)).map((r) => r.ruleId)
      : rules.filter((r) => r.enabled !== false && !experimental(r)).map((r) => r.id);
  options.runOnly = { type: 'rule', values: ids.filter((id) => !skip(id)) };
  const r = await axe.run(context, options);
  const order = ['minor', 'moderate', 'serious', 'critical'];
  const highest = (nodes) => {
    let best = null;
    for (const n of nodes) for (const c of [...n.any, ...n.all, ...n.none]) {
      if (c.impact && order.indexOf(c.impact) > order.indexOf(best)) best = c.impact;
    }
    return best;
  };
  const node = (n) => {
    const out = {
      target: n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)).join(' '),
      html: n.html.slice(0, 2000),
      failureSummary: n.failureSummary || undefined,
    };
    const cc = [...n.any, ...n.all, ...n.none].find((c) => c.data && c.data.contrastRatio);
    if (cc) out.contrast = { fg: cc.data.fgColor, bg: cc.data.bgColor, ratio: cc.data.contrastRatio, expected: parseFloat(cc.data.expectedContrastRatio) };
    return out;
  };
  const rule = (v) => ({
    id: v.id, impact: v.impact || ruleImpact(v.id) || 'minor', ruleImpact: ruleImpact(v.id) || v.impact || undefined,
    help: v.help, helpUrl: v.helpUrl, description: v.description, tags: v.tags,
    nodeCount: v.nodes.length, nodes: v.nodes.slice(0, maxNodes).map(node),
  });
  return JSON.stringify({
    version: axe.version,
    violations: r.violations.map(rule),
    incomplete: r.incomplete.map(rule),
    passes: r.passes.map((p) => ({ id: p.id, ruleImpact: ruleImpact(p.id) || highest(p.nodes) || 'moderate', tags: p.tags })),
    inapplicable: r.inapplicable.length,
  });
})`;

interface FrameRun {
  version: string;
  violations: A11yViolation[];
  incomplete: A11yViolation[];
  passes: A11yPass[];
  inapplicable: number;
}

// Makes an isolated world in a frame and loads axe into it. Returns the world id.
export async function axeWorld(cdp: CDPSession, frameId: string): Promise<number> {
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: `uiwalk-axe-${randomBytes(4).toString('hex')}`,
  });
  const load = await cdp.send('Runtime.evaluate', {
    expression: axeSource(),
    contextId: executionContextId,
  });
  if (load.exceptionDetails)
    throw new ToolError('The accessibility checker could not start on this page.', 'axe_failed');
  return executionContextId;
}

// Runs code in a world and returns the value.
export async function evalIn<T>(
  cdp: CDPSession,
  contextId: number,
  expression: string,
): Promise<T> {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new ToolError(`The accessibility check failed: ${text.split('\n')[0]}`, 'axe_failed');
  }
  return result.result.value as T;
}

async function runInWorld(
  cdp: CDPSession,
  contextId: number,
  context: unknown,
  options: Record<string, unknown>,
  inFrame: boolean,
): Promise<FrameRun> {
  const text = await evalIn<string>(
    cdp,
    contextId,
    `${RUN_IN_PAGE}(${JSON.stringify(context)}, ${JSON.stringify(options)}, ${MAX_NODES}, ${inFrame})`,
  );
  return JSON.parse(text) as FrameRun;
}

// axe needs its selector data set up before getSelector works.
export const WITH_SELECTOR_DATA = `(fn) => {
  let own = false;
  try { axe.setup(document); own = true; } catch {}
  try { return fn(); } finally { if (own) axe.teardown(); }
}`;
const SELECTOR_OF_THIS = `function () { const el = this; return (${WITH_SELECTOR_DATA})(() => axe.utils.getSelector(el)); }`;

// A selector for the iframe element of a frame, found in the parent's world.
async function frameSelector(
  cdp: CDPSession,
  frameId: string,
  parentWorld: number,
): Promise<string> {
  try {
    const { backendNodeId } = await cdp.send('DOM.getFrameOwner', { frameId });
    const { object } = await cdp.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId: parentWorld,
    });
    if (!object.objectId) return 'iframe';
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: SELECTOR_OF_THIS,
      returnByValue: true,
    });
    return String(result.result.value ?? 'iframe');
  } catch {
    return 'iframe';
  }
}

function frameUrl(frame: Protocol.Page.Frame): string {
  return frame.url + (frame.urlFragment ?? '');
}

// Adds the results of a frame to the results so far.
function mergeRun(into: FrameRun, from: FrameRun, frame?: A11yNode['frame']): void {
  for (const key of ['violations', 'incomplete'] as const) {
    for (const rule of from[key]) {
      const nodes = frame ? rule.nodes.map((n) => ({ ...n, frame })) : rule.nodes;
      const found = into[key].find((r) => r.id === rule.id);
      if (!found) {
        into[key].push({ ...rule, nodes });
        continue;
      }
      found.nodes = [...found.nodes, ...nodes].slice(0, MAX_NODES);
      found.nodeCount = (found.nodeCount ?? found.nodes.length) + (rule.nodeCount ?? nodes.length);
      if (IMPACT_ORDER.indexOf(rule.impact) < IMPACT_ORDER.indexOf(found.impact))
        found.impact = rule.impact;
    }
  }
  for (const pass of from.passes) {
    if (!into.passes.some((p) => p.id === pass.id)) into.passes.push(pass);
  }
}

// Runs axe-core on the page. With frameAllowed, it checks allowed frames too.
export async function runAxe(page: Page, options: AxeOptions = {}): Promise<AxeResult> {
  const cdp = await page.createCDPSession();
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const topWorld = await axeWorld(cdp, frameTree.frame.id);

    // Skip the Walkthrough panel. It is not part of the app.
    const context = {
      ...(options.selector ? { include: [[options.selector]] } : {}),
      exclude: [['uiwalk-panel']],
    };
    const runOptions: Record<string, unknown> = {
      resultTypes: ['violations', 'incomplete'],
      iframes: false,
    };
    if (options.rules?.length) runOptions.runOnly = { type: 'rule', values: options.rules };
    else if (options.tags?.length) runOptions.runOnly = { type: 'tag', values: options.tags };

    const all = await runInWorld(cdp, topWorld, context, runOptions, false);
    const framesChecked: string[] = [];
    const framesNotChecked: AxeResult['framesNotChecked'] = [];

    // Frames: walk the whole tree. A scoped check stays in the top page.
    if (options.frameAllowed && !options.selector) {
      const topOrigin = frameTree.frame.securityOrigin;
      const walk = async (tree: Protocol.Page.FrameTree, parentWorld: number): Promise<void> => {
        for (const child of tree.childFrames ?? []) {
          const url = frameUrl(child.frame);
          const origin = child.frame.securityOrigin;
          if (origin !== topOrigin && !options.frameAllowed?.(url)) {
            framesNotChecked.push({ url, reason: 'The frame is on a site that is not allowed.' });
            continue;
          }
          try {
            const world = await axeWorld(cdp, child.frame.id);
            const selector = await frameSelector(cdp, child.frame.id, parentWorld);
            const run = await runInWorld(cdp, world, { exclude: [] }, runOptions, true);
            mergeRun(all, run, { url, selector });
            framesChecked.push(url);
            await walk(child, world);
          } catch {
            // Walkthrough cannot open a frame from another process, or one that did not load yet.
            framesNotChecked.push({ url, reason: 'Walkthrough could not open the frame.' });
          }
        }
      };
      await walk(frameTree, topWorld);
    }

    // Hide secrets and tokens first, then cut the snippet short.
    const clean = (rules: A11yViolation[]) => {
      for (const rule of rules) {
        for (const n of rule.nodes) {
          n.html = (options.clean ? options.clean(n.html) : n.html).slice(0, MAX_HTML);
          if (n.failureSummary && options.clean) n.failureSummary = options.clean(n.failureSummary);
        }
      }
      return rules.sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact));
    };
    return {
      engine: `axe-core ${all.version}`,
      violations: clean(all.violations),
      incomplete: clean(all.incomplete),
      passes: all.passes,
      inapplicable: all.inapplicable,
      framesChecked,
      framesNotChecked,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function where(node: A11yNode): string {
  return node.frame ? `in frame ${node.frame.selector}: ${node.target}` : node.target;
}

export function formatViolations(violations: A11yViolation[]): string {
  if (violations.length === 0) return 'No accessibility problems found.';
  const lines: string[] = [];
  for (const impact of IMPACT_ORDER) {
    const group = violations.filter((v) => v.impact === impact);
    if (group.length === 0) continue;
    lines.push(`${impact.toUpperCase()} (${group.length}):`);
    for (const v of group) {
      const count = v.nodeCount ?? v.nodes.length;
      const wcag = criteriaLabel(v.tags);
      lines.push(
        `- ${v.id}: ${v.help} (${count} element${count === 1 ? '' : 's'})${wcag ? ` ${wcag}` : ''} ${v.helpUrl}`,
      );
      for (const node of v.nodes.slice(0, 3)) lines.push(`  - ${where(node)}: ${node.html}`);
      if (count > 3) lines.push(`  - and ${count - 3} more`);
    }
  }
  return lines.join('\n');
}
