import { randomBytes } from 'node:crypto';
import type { CDPSession, ElementHandle, Protocol } from 'puppeteer-core';
import type { Tab } from '../browser/driver.js';
import { ToolError } from '../errors.js';

// Properties that explain most layout and look problems.
export const DEFAULT_PROPERTIES = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'box-sizing',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'opacity',
  'visibility',
  'overflow-x',
  'overflow-y',
  'z-index',
  'cursor',
  'pointer-events',
  'flex-direction',
  'justify-content',
  'align-items',
  'transform',
];

export interface InspectOptions {
  properties?: string[];
  rules: boolean;
  listeners: boolean;
  ancestors: boolean;
}

type Quad = number[];

// Four edge sizes between two boxes, as "top right bottom left".
function edges(outer: Quad, inner: Quad): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  const [ox1 = 0, oy1 = 0, ox2 = 0, , , oy3 = 0] = outer;
  const [ix1 = 0, iy1 = 0, ix2 = 0, , , iy3 = 0] = inner;
  return `${n(iy1 - oy1)} ${n(ox2 - ix2)} ${n(oy3 - iy3)} ${n(ix1 - ox1)}`;
}

// A short name for a node, like button#save.primary.
function nodeLabel(node: Protocol.DOM.Node): string {
  const attrs = node.attributes ?? [];
  const get = (name: string) => {
    const i = attrs.indexOf(name);
    return i >= 0 && i % 2 === 0 ? attrs[i + 1] : undefined;
  };
  const id = get('id');
  const classes = (get('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  return `${node.nodeName.toLowerCase()}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

// Finds the element in our own session. A handle from Puppeteer only works in its session.
async function findNode(cdp: CDPSession, handle: ElementHandle<Element>): Promise<number> {
  const token = randomBytes(6).toString('hex');
  await handle.evaluate((el, t) => el.setAttribute('data-uiwalk-inspect', t), token);
  try {
    await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { searchId, resultCount } = await cdp.send('DOM.performSearch', {
      query: `[data-uiwalk-inspect="${token}"]`,
      includeUserAgentShadowDOM: false,
    });
    const { nodeIds } = resultCount
      ? await cdp.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount })
      : { nodeIds: [] };
    await cdp.send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
    const nodeId = nodeIds[0];
    if (!nodeId) {
      throw new ToolError(
        'inspect works on elements of the page and of frames from the same site. Walkthrough could not reach this element.',
        'not_found',
      );
    }
    return nodeId;
  } finally {
    await handle.evaluate((el) => el.removeAttribute('data-uiwalk-inspect')).catch(() => undefined);
  }
}

// Styles, box, CSS rules with file and line, and event listeners with file and line.
export async function inspectElement(
  tab: Tab,
  handle: ElementHandle<Element>,
  options: InspectOptions,
): Promise<string> {
  const cdp = await tab.page.createCDPSession();
  const sheets = new Map<string, Protocol.CSS.CSSStyleSheetHeader>();
  const scripts = new Map<string, string>();
  cdp.on('CSS.styleSheetAdded', ({ header }: Protocol.CSS.StyleSheetAddedEvent) =>
    sheets.set(header.styleSheetId, header),
  );
  cdp.on('Debugger.scriptParsed', (event: Protocol.Debugger.ScriptParsedEvent) =>
    scripts.set(event.scriptId, event.url),
  );
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    if (options.listeners) await cdp.send('Debugger.enable');
    const nodeId = await findNode(cdp, handle);
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    const lines = [`Element: ${nodeLabel(node)} (tab ${tab.id})`];

    const box = await cdp.send('DOM.getBoxModel', { nodeId }).catch(() => undefined);
    if (box) {
      const m = box.model;
      lines.push(
        `Box: ${m.width} x ${m.height} px, at x ${Math.round(m.border[0] ?? 0)}, y ${Math.round(m.border[1] ?? 0)}.`,
        `  Padding ${edges(m.padding, m.content)}. Border ${edges(m.border, m.padding)}. Margin ${edges(m.margin, m.border)} (top right bottom left).`,
      );
    } else {
      lines.push(
        'Box: none. The page does not show the element, for example because of display: none.',
      );
    }

    const wanted = options.properties?.length ? options.properties : DEFAULT_PROPERTIES;
    const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    const computed = computedStyle.filter((p) =>
      wanted.some((w) => p.name === w || p.name.startsWith(`${w}-`)),
    );
    lines.push('', 'Computed styles:', ...computed.map((p) => `  ${p.name}: ${p.value}`));

    if (options.rules) {
      const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
      const where = (rule: Protocol.CSS.CSSRule) => {
        const header = rule.styleSheetId ? sheets.get(rule.styleSheetId) : undefined;
        if (!header) return 'no file';
        const line = (header.startLine ?? 0) + (rule.style.range?.startLine ?? 0) + 1;
        return `${header.sourceURL || '(style tag)'}:${line}`;
      };
      const declarations = (style: Protocol.CSS.CSSStyle) =>
        style.cssProperties
          .filter((p) => !p.disabled && !p.implicit && p.parsedOk !== false && p.text)
          .slice(0, 20)
          .map((p) => `      ${p.name}: ${p.value}${p.important ? ' !important' : ''};`);
      const rules = (matched.matchedCSSRules ?? []).filter((m) => m.rule.origin === 'regular');
      lines.push('', 'CSS rules, in cascade order (later rules win):');
      if (rules.length === 0) lines.push('  No rules from the site style sheets.');
      rules.forEach((m, i) => {
        lines.push(
          `  ${i + 1}. ${m.rule.selectorList.text} (${where(m.rule)})`,
          ...declarations(m.rule.style),
        );
      });
      if (matched.inlineStyle?.cssProperties.length) {
        lines.push('  Inline style attribute:', ...declarations(matched.inlineStyle));
      }
    }

    if (options.listeners) {
      lines.push('', 'Event listeners:');
      const found = await listenerLines(cdp, nodeId, scripts, options.ancestors);
      lines.push(...(found.length ? found : ['  None found.']));
      await cdp.send('Debugger.disable').catch(() => undefined);
    }
    return lines.join('\n');
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// Listeners on the element, and on its parents, the document, and the window.
// Frameworks often put one handler on the root, so the parents matter.
async function listenerLines(
  cdp: CDPSession,
  nodeId: number,
  scripts: Map<string, string>,
  ancestors: boolean,
): Promise<string[]> {
  const lines: string[] = [];
  const describe = (l: Protocol.DOMDebugger.EventListener, owner: string) => {
    const file = scripts.get(l.scriptId) || 'an inline script';
    const flags = [l.useCapture ? 'capture' : '', l.passive ? 'passive' : '', l.once ? 'once' : '']
      .filter(Boolean)
      .join(', ');
    return `  ${l.type} on ${owner}: ${file}:${l.lineNumber + 1}:${l.columnNumber + 1}${flags ? ` (${flags})` : ''}`;
  };
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  let objectId = object.objectId;
  let owner = 'this element';
  for (let depth = 0; objectId && depth < 20 && lines.length < 40; depth++) {
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId });
    for (const l of listeners) lines.push(describe(l, owner));
    if (!ancestors) break;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { return this.parentNode; }',
    });
    objectId = result.objectId;
    if (objectId) {
      const { node } = await cdp.send('DOM.describeNode', { objectId });
      owner = node.nodeName === '#document' ? 'the document' : `the parent ${nodeLabel(node)}`;
    }
  }
  if (ancestors) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
    if (result.objectId) {
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId,
      });
      for (const l of listeners) lines.push(describe(l, 'the window'));
    }
  }
  return lines;
}
