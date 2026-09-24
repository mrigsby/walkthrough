import type { ElementHandle, SerializedAXNode } from 'puppeteer-core';
import type { Tab } from '../browser/driver.js';
import type { RefTable } from './refs.js';

const MAX_LINES = 1200;
const MAX_TEXT = 200;

// Roles that only group other items. We show their children, not them.
const SKIP_ROLES = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak']);

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}...` : flat;
}

function details(node: SerializedAXNode): string {
  const parts: string[] = [];
  if (node.value !== undefined && node.value !== '')
    parts.push(`value: "${clip(String(node.value))}"`);
  if (node.checked !== undefined)
    parts.push(node.checked === 'mixed' ? 'mixed' : node.checked ? 'checked' : 'not checked');
  if (node.pressed !== undefined) parts.push(node.pressed ? 'pressed' : 'not pressed');
  if (node.selected) parts.push('selected');
  if (node.expanded !== undefined) parts.push(node.expanded ? 'expanded' : 'collapsed');
  if (node.disabled) parts.push('disabled');
  if (node.required) parts.push('required');
  if (node.invalid && node.invalid !== 'false') parts.push('invalid');
  if (node.focused) parts.push('focused');
  if (node.level) parts.push(`level ${node.level}`);
  if (node.url) parts.push(`url: ${node.url}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// Builds a short text outline of the page, with a ref for each element.
export async function buildSnapshot(
  tab: Tab,
  refs: RefTable,
  root?: ElementHandle,
): Promise<string> {
  await refs.reset();
  const tree = await tab.page.accessibility.snapshot({
    interestingOnly: true,
    includeIframes: true,
    root: root ?? undefined,
  });

  const lines: string[] = [];
  let truncated = false;

  const walk = (node: SerializedAXNode, depth: number, parentName = ''): void => {
    if (lines.length >= MAX_LINES) {
      truncated = true;
      return;
    }
    const indent = '  '.repeat(depth);
    const name = node.name ? clip(node.name) : '';
    let childDepth = depth + 1;

    if (node.role === 'StaticText') {
      // Skip text that only repeats the name of the item above it.
      if (name && !parentName.includes(name)) lines.push(`${indent}- text "${name}"`);
    } else if (node.role === 'RootWebArea') {
      // The top page, or the page inside an iframe.
      if (depth > 0) lines.push(`${indent}- document "${name}"${details(node)}`);
      else childDepth = depth;
    } else if (SKIP_ROLES.has(node.role) && !name) {
      childDepth = depth;
    } else {
      const ref = refs.add(node, tab.id, tab.nav);
      lines.push(`${indent}- [${ref}] ${node.role}${name ? ` "${name}"` : ''}${details(node)}`);
    }
    for (const child of node.children ?? []) walk(child, childDepth, name || parentName);
  };

  if (tree) walk(tree, 0);
  if (truncated)
    lines.push(
      `(The outline stopped at ${MAX_LINES} lines. Use the "ref" option to look at one part of the page.)`,
    );
  if (lines.length === 0) lines.push('(The page has no visible content.)');
  return lines.join('\n');
}
