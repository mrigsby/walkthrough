// Finds the parts of a page that a video must blur: text and field values with a secret in
// them, and elements that match the mask selectors. It only measures. It changes nothing on
// the page, so the developer still sees everything. The server turns this function into
// text, and it runs in an isolated world, so it must not use anything from outside itself.
// Page scripts cannot see the secrets it holds.

export interface MaskScriptOptions {
  binding: string;
}

export function maskMain(opts: MaskScriptOptions): void {
  if (window !== window.top) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__uiwalkMask) return;

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  let secrets: string[] = [];
  let selectors: string[] = [];
  let last = '';
  let queued = false;
  // A little extra on each side, so the edges of the text are covered too.
  const PAD = 4;
  const MAX_BOXES = 200;

  const send = (msg: Record<string, unknown>): void => {
    const fn = w[opts.binding] as ((payload: string) => void) | undefined;
    if (typeof fn === 'function') fn(JSON.stringify(msg));
  };

  const boxes = (): Box[] => {
    const out: Box[] = [];
    const add = (r: DOMRect) => {
      if (r.width <= 0 || r.height <= 0) return;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
      out.push({
        x: Math.round(r.left - PAD),
        y: Math.round(r.top - PAD),
        width: Math.round(r.width + PAD * 2),
        height: Math.round(r.height + PAD * 2),
      });
    };
    for (const selector of selectors) {
      let found: NodeListOf<Element>;
      try {
        found = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of found) add(node.getBoundingClientRect());
    }
    if (secrets.length && document.body) {
      // The box of the text itself, not of a big element around it.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue ?? '';
        if (!secrets.some((s) => text.includes(s))) continue;
        range.selectNodeContents(node);
        add(range.getBoundingClientRect());
      }
      // Field values are not in the page text.
      for (const field of document.querySelectorAll('input, textarea')) {
        const value = (field as HTMLInputElement).value;
        if (value && secrets.some((s) => value.includes(s))) add(field.getBoundingClientRect());
      }
    }
    return out.slice(0, MAX_BOXES);
  };

  const report = (): void => {
    queued = false;
    if (!secrets.length && !selectors.length) return;
    const now = boxes();
    const key = JSON.stringify(now);
    if (key === last) return;
    last = key;
    send({ type: 'boxes', boxes: now });
  };
  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  };

  w.__uiwalkMask = {
    receive(msg: Record<string, unknown>) {
      if (msg.type !== 'config') return;
      secrets = Array.isArray(msg.secrets) ? (msg.secrets as string[]) : [];
      selectors = Array.isArray(msg.selectors) ? (msg.selectors as string[]) : [];
      // Send the boxes again, also when they did not change.
      last = '';
      if (!secrets.length && !selectors.length) send({ type: 'boxes', boxes: [] });
      else queue();
    },
  };

  const start = (): void => {
    new MutationObserver(queue).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    addEventListener('scroll', queue, { capture: true, passive: true });
    addEventListener('resize', queue);
    addEventListener('input', queue, true);
    // Animations move things without a change the observer sees.
    setInterval(queue, 500);
    send({ type: 'hello' });
    queue();
  };
  if (document.documentElement) start();
  else {
    const wait = new MutationObserver(() => {
      if (document.documentElement) {
        wait.disconnect();
        start();
      }
    });
    wait.observe(document, { childList: true });
  }
}
