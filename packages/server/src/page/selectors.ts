import type { ElementHandle } from 'puppeteer-core';

export interface SelectorHint {
  role?: string;
  name?: string;
}

// Candidate selectors, found inside the page. Best first.
function pageCandidates(el: Element): string[] {
  const out: string[] = [];
  const q = (value: string) => JSON.stringify(value);

  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
    const value = el.getAttribute(attr);
    if (value) out.push(`[${attr}=${q(value)}]`);
  }

  // Skip ids that look made by a tool, like ":r3:" or "ember1234".
  const id = el.id;
  if (id && !/\d{3,}|^:|:$/.test(id)) out.push(`#${CSS.escape(id)}`);

  const tag = el.tagName.toLowerCase();
  const nameAttr = el.getAttribute('name');
  if (nameAttr && ['input', 'select', 'textarea', 'button'].includes(tag)) {
    out.push(`${tag}[name=${q(nameAttr)}]`);
  }

  const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
  if (text && text.length <= 40 && ['a', 'button', 'label', 'summary', 'option'].includes(tag)) {
    out.push(`${tag}::-p-text(${text.replace(/[()]/g, '')})`);
  }

  // A short CSS path, up to an element with an id.
  const segments: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 5; depth++) {
    const nodeTag = node.tagName.toLowerCase();
    if (node.id && !/\d{3,}|^:|:$/.test(node.id) && node !== el) {
      segments.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent || nodeTag === 'body') {
      segments.unshift(nodeTag);
      break;
    }
    const same = [...parent.children].filter((c) => c.tagName === node?.tagName);
    segments.unshift(
      same.length > 1 ? `${nodeTag}:nth-of-type(${same.indexOf(node) + 1})` : nodeTag,
    );
    node = parent;
  }
  out.push(segments.join(' > '));
  return out;
}

function ariaCandidate(hint?: SelectorHint): string | undefined {
  if (!hint?.role || !hint.name) return undefined;
  if (/[()[\]"]/.test(hint.name) || hint.name.length > 60) return undefined;
  if (['RootWebArea', 'StaticText', 'generic', 'none'].includes(hint.role)) return undefined;
  return `::-p-aria(${hint.name}[role="${hint.role}"])`;
}

// Finds a selector that matches only this element, so a plan or script can find it again.
export async function stableSelector(
  handle: ElementHandle<Element>,
  hint?: SelectorHint,
): Promise<string | undefined> {
  const frame = handle.frame;
  let candidates: string[];
  try {
    candidates = await handle.evaluate(pageCandidates);
  } catch {
    return undefined;
  }
  const aria = ariaCandidate(hint);
  // Order: test ids, then the ARIA role and name, then the rest.
  const testIds = candidates.filter((c) => c.startsWith('[data-'));
  const rest = candidates.filter((c) => !c.startsWith('[data-'));
  const ordered = [...testIds, ...(aria ? [aria] : []), ...rest];

  for (const selector of ordered) {
    try {
      const matches = await frame.$$(selector);
      const unique =
        matches.length === 1 &&
        matches[0] !== undefined &&
        (await frame.evaluate((a, b) => a === b, matches[0], handle));
      await Promise.all(matches.map((m) => m.dispose()));
      if (unique) return selector;
    } catch {
      // Not a valid selector in this page. Try the next one.
    }
  }
  return undefined;
}
