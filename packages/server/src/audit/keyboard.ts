import { PNG } from 'pngjs';
import type { CDPSession, Page } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { FREEZE_CSS } from '../visual/capture.js';
import { type A11yNode, axeWorld, evalIn, WITH_SELECTOR_DATA } from './axe.js';

export interface FocusStop {
  target: string;
  role: string;
  name: string;
  frame?: { url: string; selector: string };
}

export interface KeyboardResult {
  // The focus order, one stop per Tab press.
  stops: FocusStop[];
  endedBy: 'wrapped' | 'left-page' | 'trap' | 'limit';
  trap?: A11yNode[];
  noVisibleFocus: A11yNode[];
  unreachable: A11yNode[];
}

interface Current {
  body?: boolean;
  panel?: boolean;
  id?: number;
  crossFrame?: boolean;
  target?: string;
  role?: string;
  name?: string;
  html?: string;
  frame?: { url: string; selector: string };
  // Page coordinates, for a screenshot clip. Missing for elements in frames.
  rect?: { x: number; y: number; width: number; height: number };
}

type Stop = Required<Pick<Current, 'id' | 'target' | 'role' | 'name' | 'html'>> & Current;

// The code below runs in an isolated world with axe loaded.
// It keeps its notes in window.__uiwalkKb, which the page cannot see.

const SETUP = `(() => {
  const state = { ids: new WeakMap(), els: [], next: 0 };
  window.__uiwalkKb = state;
  try { axe.setup(document); state.own = true; } catch {}
  // Start at the top: focus a new first element, press Tab, then remove it.
  const start = document.createElement('span');
  start.tabIndex = -1;
  document.body.prepend(start);
  start.focus();
  state.start = start;
})()`;

const TEARDOWN = `(() => {
  const state = window.__uiwalkKb;
  if (!state) return;
  if (state.start) state.start.remove();
  if (state.own) try { axe.teardown(); } catch {}
  const active = document.activeElement;
  if (active && active.blur) active.blur();
  delete window.__uiwalkKb;
})()`;

const HELPERS = `
  const simple = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + CSS.escape(el.id);
    if (el.getAttribute('name')) return s + '[name="' + el.getAttribute('name') + '"]';
    if (el.classList.length) s += '.' + [...el.classList].map((c) => CSS.escape(c)).join('.');
    return s;
  };
  const selector = (el) => {
    const root = el.getRootNode();
    if (root !== document && root.host) return selector(root.host) + ' >>> ' + simple(el);
    try { return axe.utils.getSelector(el); } catch { return simple(el); }
  };
  const pageRect = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
  };
`;

// The element that has focus now, even inside a shadow root or a frame on this site.
const CURRENT = `(() => {
  const state = window.__uiwalkKb;
  ${HELPERS}
  if (state.start) { state.start.remove(); state.start = null; }
  let el = document.activeElement;
  let frame = null;
  let crossFrame = false;
  while (el) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (!doc) { crossFrame = true; break; }
      const inner = doc.activeElement;
      if (!inner || inner === doc.body) break;
      frame = frame || { selector: selector(el), url: doc.location.href };
      el = inner;
      continue;
    }
    break;
  }
  if (!el || el === document.body || el === document.documentElement) return { body: true };
  if (el.tagName === 'UIWALK-PANEL') return { panel: true };
  let id = state.ids.get(el);
  if (!id) { id = ++state.next; state.ids.set(el, id); state.els[id] = el; }
  const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('alt') ||
    el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return {
    id, crossFrame, frame,
    target: frame ? simple(el) : selector(el),
    role: el.getAttribute('role') || el.tagName.toLowerCase(),
    name,
    html: el.outerHTML.slice(0, 2000),
    rect: frame ? undefined : pageRect(el),
  };
})()`;

const RECT_OF = (id: number) => `(() => {
  ${HELPERS}
  const el = window.__uiwalkKb.els[${id}];
  return el && el.isConnected ? pageRect(el) : null;
})()`;

// Elements with a pointer cursor that cannot get focus, and have no focusable
// parent or child. Labels for a form field are fine. Keeps the outer one of a group.
const POINTER_ONLY = `(() => {
  ${HELPERS}
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  const canFocus = (el) => el.matches(FOCUSABLE) && !el.disabled && el.tabIndex >= 0;
  const hasFocusableParent = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (canFocus(p)) return true;
    return false;
  };
  const found = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('uiwalk-panel')) continue;
    const style = getComputedStyle(el);
    if (style.cursor !== 'pointer' || style.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (canFocus(el) || hasFocusableParent(el)) continue;
    if ([...el.querySelectorAll(FOCUSABLE)].some(canFocus)) continue;
    if (el.tagName === 'LABEL' && el.control) continue;
    // A child only has the pointer because its parent has it.
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
    found.push(el);
  }
  window.__uiwalkPointer = found.slice(0, 20);
  return window.__uiwalkPointer.map((el) => ({ target: selector(el), html: el.outerHTML.slice(0, 2000) }));
})()`;

// Counts the pixels that differ between two PNG crops.
function changedPixels(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return Number.POSITIVE_INFINITY;
  let changed = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const diff =
      Math.abs((x.data[i] ?? 0) - (y.data[i] ?? 0)) +
      Math.abs((x.data[i + 1] ?? 0) - (y.data[i + 1] ?? 0)) +
      Math.abs((x.data[i + 2] ?? 0) - (y.data[i + 2] ?? 0));
    if (diff > 24) changed += 1;
  }
  return changed;
}

async function crop(page: Page, rect: Current['rect']): Promise<Buffer | undefined> {
  if (!rect || rect.width < 1 || rect.height < 1) return undefined;
  // A few pixels around the element, where a focus ring usually is.
  const pad = 6;
  return (await page
    .screenshot({
      type: 'png',
      clip: {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      },
      captureBeyondViewport: false,
    })
    .catch(() => undefined)) as Buffer | undefined;
}

function node(stop: Stop, why: string, clean: (t: string) => string): A11yNode {
  return {
    target: stop.target,
    html: clean(stop.html).slice(0, 300),
    failureSummary: why,
    ...(stop.frame ? { frame: stop.frame } : {}),
  };
}

// Finds elements you can click but cannot reach with Tab. Confirms each one has a
// click handler on it or on a close parent, so a plain pointer cursor is not enough.
async function pointerOnly(
  cdp: CDPSession,
  world: number,
  clean: (t: string) => string,
): Promise<A11yNode[]> {
  const found = await evalIn<Array<{ target: string; html: string }>>(
    cdp,
    world,
    `(${WITH_SELECTOR_DATA})(() => ${POINTER_ONLY})`,
  );
  const confirmed: A11yNode[] = [];
  for (const [i, item] of found.entries()) {
    let clicks = false;
    for (let up = 0; up < 4 && !clicks; up++) {
      const path = `window.__uiwalkPointer[${i}]${'.parentElement'.repeat(up)}`;
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const el = ${path}; return el && el !== document.body ? el : null; })()`,
        contextId: world,
      });
      if (!result.objectId) break;
      // Listeners belong to the page's own world, so look at the element there.
      const { node: described } = await cdp.send('DOM.describeNode', {
        objectId: result.objectId,
      });
      const { object } = await cdp.send('DOM.resolveNode', {
        backendNodeId: described.backendNodeId,
      });
      if (!object.objectId) break;
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
        objectId: object.objectId,
      });
      clicks = listeners.some((l) =>
        ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].includes(l.type),
      );
    }
    if (clicks) {
      confirmed.push({
        target: item.target,
        html: clean(item.html).slice(0, 300),
        failureSummary: 'You can click this element, but you cannot reach it with the Tab key.',
      });
    }
  }
  await cdp
    .send('Runtime.evaluate', { expression: 'delete window.__uiwalkPointer', contextId: world })
    .catch(() => undefined);
  return confirmed;
}

// Presses Tab through the page, like a keyboard user, and records what happens.
// It finds keyboard traps, elements with no visible focus, and elements Tab cannot reach.
export async function checkKeyboard(
  driver: Driver,
  tab: Tab,
  options: { clean?: (text: string) => string; maxStops?: number } = {},
): Promise<KeyboardResult> {
  const page = tab.page;
  const clean = options.clean ?? ((t: string) => t);
  const maxStops = options.maxStops ?? 80;
  const cdp = await page.createCDPSession();
  const scroll = await page
    .evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    .catch(() => ({ x: 0, y: 0 }));
  await driver.panel?.hide(tab.id, true);
  // A browser window without focus draws no focus rings. This makes it act focused.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  const style = await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
  await page.mouse.move(0, 0).catch(() => undefined);

  const stops: Stop[] = [];
  const noVisibleFocus: A11yNode[] = [];
  let trap: A11yNode[] | undefined;
  let endedBy: KeyboardResult['endedBy'] = 'limit';
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const world = await axeWorld(cdp, frameTree.frame.id);
    await evalIn(cdp, world, SETUP);
    const unreachable = await pointerOnly(cdp, world, clean);

    const seen = new Map<number, number>();
    let previous: { stop: Stop; shot?: Buffer } | undefined;
    let sameFrame = 0;
    for (let press = 0; press < maxStops * 2 && stops.length < maxStops; press++) {
      await page.keyboard.press('Tab');
      const now = await evalIn<Current>(cdp, world, CURRENT);

      // The element before this one lost focus. Did the screen change?
      if (previous?.shot && now.id !== previous.stop.id) {
        const rect = await evalIn<Current['rect'] | null>(cdp, world, RECT_OF(previous.stop.id));
        const after = rect ? await crop(page, rect) : undefined;
        if (after && changedPixels(previous.shot, after) < 4) {
          noVisibleFocus.push(
            node(
              previous.stop,
              'Nothing on the screen changes when this element gets keyboard focus.',
              clean,
            ),
          );
        }
      }
      if (now.body) {
        endedBy = 'left-page';
        break;
      }
      if (now.panel || now.id === undefined) continue;
      const stop = now as Stop;
      // A frame from another site keeps focus inside it for several presses.
      if (now.crossFrame && previous?.stop.id === stop.id) {
        if (++sameFrame > 40) break;
        continue;
      }
      sameFrame = 0;

      const seenAt = seen.get(stop.id);
      if (seenAt !== undefined) {
        if (seenAt === 0) {
          endedBy = 'wrapped';
          break;
        }
        // Focus came back to an earlier element. Can Shift+Tab get out?
        const loop = stops.slice(seenAt);
        const loopIds = new Set(loop.map((s) => s.id));
        let escaped = false;
        for (let back = 0; back < 3 && !escaped; back++) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Tab');
          await page.keyboard.up('Shift');
          const after = await evalIn<Current>(cdp, world, CURRENT);
          escaped = Boolean(after.body || (after.id !== undefined && !loopIds.has(after.id)));
        }
        if (!escaped) {
          endedBy = 'trap';
          trap = loop.map((s) =>
            node(s, 'Tab and Shift+Tab cannot move keyboard focus away from here.', clean),
          );
        } else endedBy = 'wrapped';
        break;
      }
      seen.set(stop.id, stops.length);
      stops.push(stop);
      previous = { stop, shot: await crop(page, stop.rect) };
    }
    await evalIn(cdp, world, TEARDOWN).catch(() => undefined);
    return {
      stops: stops.map((s) => ({
        target: s.target,
        role: s.role,
        name: clean(s.name),
        ...(s.frame ? { frame: s.frame } : {}),
      })),
      endedBy,
      trap,
      noVisibleFocus,
      unreachable,
    };
  } finally {
    await style?.evaluate((el) => el.remove()).catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await page.evaluate((s) => window.scrollTo(s.x, s.y), scroll).catch(() => undefined);
    await driver.panel?.hide(tab.id, false);
  }
}
