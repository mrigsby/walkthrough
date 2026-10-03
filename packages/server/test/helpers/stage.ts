import type { CDPSession, Page, Protocol } from 'puppeteer-core';

type Node = Protocol.DOM.Node;

export interface StagePart {
  shown: boolean;
  text: string;
  // The src of an image inside, if any.
  src?: string;
}

async function findStageParts(cdp: CDPSession): Promise<Map<string, Node>> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const parts = new Map<string, Node>();
  const walk = (node: Node, inStage: boolean) => {
    const here = inStage || node.nodeName === 'UIWALK-STAGE';
    if (inStage && node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        if (node.attributes[i] === 'class')
          parts.set((node.attributes[i + 1] ?? '').split(' ')[0] ?? '', node);
      }
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, here);
  };
  walk(root, false);
  return parts;
}

// What a part of the presentation stage shows: slide, spot, zoom, caption, cover, or pointer.
export async function stagePart(page: Page, name: string): Promise<StagePart> {
  const cdp = await page.createCDPSession();
  try {
    const node = (await findStageParts(cdp)).get(name);
    if (!node) return { shown: false, text: '' };
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId as string,
      functionDeclaration:
        'function () { const img = this.querySelector && this.querySelector("img"); return { shown: !this.hidden && getComputedStyle(this).display !== "none", text: this.textContent || "", src: img ? img.getAttribute("src") : undefined }; }',
      returnByValue: true,
    });
    return result.value as StagePart;
  } finally {
    await cdp.detach();
  }
}

// Waits until a part of the stage matches.
export async function waitForStage(
  page: Page,
  name: string,
  check: (part: StagePart) => boolean,
  ms = 10_000,
): Promise<StagePart> {
  const end = Date.now() + ms;
  let last: StagePart = { shown: false, text: '' };
  while (Date.now() < end) {
    last = await stagePart(page, name).catch(() => last);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `The stage part "${name}" did not match. Last: ${JSON.stringify(last).slice(0, 300)}`,
  );
}
