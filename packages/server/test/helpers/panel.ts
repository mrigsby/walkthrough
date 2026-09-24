import type { CDPSession, Page, Protocol } from 'puppeteer-core';

type Node = Protocol.DOM.Node;

// Finds nodes in the page, including inside the panel's closed shadow root.
async function findNodes(cdp: CDPSession, match: (node: Node) => boolean): Promise<Node[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const found: Node[] = [];
  const walk = (node: Node) => {
    if (match(node)) found.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return found;
}

function hasClass(node: Node, name: string): boolean {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'class' && (attrs[i + 1] ?? '').split(/\s+/).includes(name)) return true;
  }
  return false;
}

// The text shown in the panel card.
export async function panelText(page: Page): Promise<string> {
  const cdp = await page.createCDPSession();
  try {
    const cards = await findNodes(cdp, (n) => n.nodeName === 'SECTION' && hasClass(n, 'card'));
    if (!cards[0]) return '';
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: cards[0].backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId as string,
      functionDeclaration:
        'function () { return this.classList.contains("asking") ? "ASKING " + this.innerText : this.innerText; }',
      returnByValue: true,
    });
    return String(result.value ?? '');
  } finally {
    await cdp.detach();
  }
}

// Waits until the panel shows some text.
export async function waitForPanel(page: Page, text: string, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    last = await panelText(page).catch(() => '');
    if (last.includes(text)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Panel did not show "${text}". It showed: ${last}`);
}

// A real mouse click on a panel element, like the developer would do.
export async function clickPanel(page: Page, className: string): Promise<void> {
  const cdp = await page.createCDPSession();
  try {
    const [node] = await findNodes(cdp, (n) => hasClass(n, className));
    if (!node) throw new Error(`No panel element with class ${className}`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const [x1, y1, , , x3, y3] = model.content;
    await page.mouse.click(((x1 ?? 0) + (x3 ?? 0)) / 2, ((y1 ?? 0) + (y3 ?? 0)) / 2);
  } finally {
    await cdp.detach();
  }
}

// A fake click from a page script. The panel must ignore it.
export async function fakeClickPanel(page: Page, className: string): Promise<void> {
  const cdp = await page.createCDPSession();
  try {
    const [node] = await findNodes(cdp, (n) => hasClass(n, className));
    if (!node) throw new Error(`No panel element with class ${className}`);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId as string,
      functionDeclaration: 'function () { this.click(); }',
    });
  } finally {
    await cdp.detach();
  }
}

export async function typeNotes(page: Page, text: string): Promise<void> {
  await clickPanel(page, 'notes');
  await page.keyboard.type(text);
}
