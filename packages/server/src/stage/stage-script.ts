// The audience screen of a presentation: slides, captions, the pointer, the spotlight,
// and covers. The server turns this function into text. It runs in an isolated world in
// the page, so it must not use anything from outside itself. Page scripts cannot see it.

export interface StageOptions {
  binding: string;
  css: string;
}

export function stageMain(opts: StageOptions): void {
  if (window !== window.top) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__uiwalkStage) return;

  type Slide =
    | { kind: 'image'; src: string; fit?: string; background?: string }
    | { kind: 'text'; title: string; text?: string; background?: string; color?: string };
  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  const send = (msg: Record<string, unknown>): void => {
    const fn = w[opts.binding] as ((payload: string) => void) | undefined;
    if (typeof fn === 'function') fn(JSON.stringify(msg));
  };

  // ---------- Build the stage ----------
  const host = document.createElement('uiwalk-stage');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('popover', 'manual');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(opts.css);
  root.adoptedStyleSheets = [sheet];

  const el = (tag: string, className: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    node.hidden = true;
    return node;
  };
  const slide = el('div', 'slide');
  const spot = el('div', 'spot');
  const zoom = el('div', 'zoom');
  const lens = document.createElement('div');
  lens.className = 'lens';
  const zoomImage = document.createElement('img');
  zoomImage.alt = '';
  lens.append(zoomImage);
  zoom.append(lens);
  const caption = el('div', 'caption');
  const ripple = el('div', 'ripple');
  // An arrow, built with DOM calls, so a strict page policy cannot block it.
  const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pointer.setAttribute('class', 'pointer');
  pointer.setAttribute('viewBox', '0 0 24 24');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M3 2l7 19 2.5-7.5L20 11z');
  arrow.setAttribute('fill', '#111827');
  arrow.setAttribute('stroke', '#ffffff');
  arrow.setAttribute('stroke-width', '1.5');
  pointer.append(arrow);
  pointer.style.display = 'none';
  const cover = el('div', 'cover');
  root.append(slide, spot, zoom, caption, pointer, ripple, cover);

  // ---------- State ----------
  let keys = false;
  let mask: string[] = [];
  let pointerOn = true;
  let at = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight * 0.8) };

  const showSlide = (s: Slide | null): void => {
    slide.replaceChildren();
    slide.hidden = !s;
    if (!s) return;
    slide.style.background = s.background ?? (s.kind === 'image' ? '#000000' : '#111827');
    if (s.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.src = s.src;
      img.style.objectFit = s.fit === 'cover' ? 'cover' : 'contain';
      slide.append(img);
      return;
    }
    slide.style.color = s.color ?? '#ffffff';
    const title = document.createElement('h1');
    title.textContent = s.title;
    slide.append(title);
    if (s.text) {
      const text = document.createElement('p');
      text.textContent = s.text;
      slide.append(text);
    }
  };

  const place = (node: HTMLElement, r: Rect, pad: number): void => {
    Object.assign(node.style, {
      left: `${r.x - pad}px`,
      top: `${r.y - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
  };

  const movePointer = (x: number, y: number, ms: number): void => {
    if (!pointerOn) return;
    pointer.style.display = '';
    pointer.style.transitionDuration = `${ms}ms`;
    pointer.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    at = { x, y };
  };

  // Blurs the parts of the page that the plan names, like customer names.
  const applyMask = (): void => {
    for (const selector of mask) {
      let found: NodeListOf<Element>;
      try {
        found = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of found) {
        (node as HTMLElement).style.setProperty('filter', 'blur(8px)', 'important');
      }
    }
  };
  let maskQueued = false;
  new MutationObserver(() => {
    if (!mask.length || maskQueued) return;
    maskQueued = true;
    requestAnimationFrame(() => {
      maskQueued = false;
      applyMask();
    });
  }).observe(document, { childList: true, subtree: true });

  // Messages from the server.
  const receive = (msg: Record<string, unknown>): void => {
    switch (msg.type) {
      case 'state': {
        keys = Boolean(msg.keys);
        pointerOn = msg.pointer !== false;
        if (!pointerOn) pointer.style.display = 'none';
        mask = Array.isArray(msg.mask) ? (msg.mask as string[]) : [];
        applyMask();
        showSlide((msg.slide as Slide | null) ?? null);
        const text = msg.caption as string | null | undefined;
        caption.hidden = !text;
        caption.textContent = text ?? '';
        const mode = msg.cover as string | undefined;
        cover.hidden = !mode || mode === 'none';
        cover.textContent = mode === 'curtain' ? 'One moment' : '';
        break;
      }
      case 'cover': {
        const mode = msg.mode as string;
        cover.hidden = mode === 'none';
        cover.textContent = mode === 'curtain' ? 'One moment' : '';
        break;
      }
      case 'spot': {
        const r = msg.rect as Rect | null;
        spot.hidden = !r;
        if (r) place(spot, r, 6);
        break;
      }
      case 'zoom': {
        const src = msg.src as string | null;
        const r = msg.rect as Rect | undefined;
        zoom.hidden = !src || !r;
        if (!src || !r) break;
        // The picture is the whole window. Show only the area around the element, bigger.
        const pad = 24;
        const w = r.width + pad * 2;
        const h = r.height + pad * 2;
        const k = Math.min(
          Number(msg.zoom) || 2,
          (window.innerWidth * 0.8 - 12) / w,
          (window.innerHeight * 0.7 - 12) / h,
        );
        lens.style.width = `${w * k}px`;
        lens.style.height = `${h * k}px`;
        Object.assign(zoomImage.style, {
          width: `${window.innerWidth * k}px`,
          height: `${window.innerHeight * k}px`,
          left: `${-(r.x - pad) * k}px`,
          top: `${-(r.y - pad) * k}px`,
        });
        zoomImage.src = src;
        break;
      }
      case 'glide':
        movePointer(msg.x as number, msg.y as number, (msg.ms as number) ?? 400);
        break;
      case 'ripple':
        if (!pointerOn) break;
        ripple.hidden = false;
        ripple.style.left = `${at.x}px`;
        ripple.style.top = `${at.y}px`;
        ripple.classList.remove('go');
        void ripple.offsetWidth;
        ripple.classList.add('go');
        break;
    }
  };

  // Clicker keys go to the presentation, not to the app. Most clickers send these.
  const KEYS = new Set([
    'ArrowRight',
    'ArrowLeft',
    'PageDown',
    'PageUp',
    ' ',
    'b',
    'B',
    '.',
    'Escape',
  ]);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!keys || !event.isTrusted || !KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'key', key: event.key });
    },
    true,
  );

  w.__uiwalkStage = { receive };

  // The stage stays in the top layer, above the app's own dialogs and popovers.
  const raise = (): void => {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {}
  };
  const mount = (): void => {
    const parent = document.documentElement;
    if (parent && host.parentNode !== parent) {
      parent.appendChild(host);
      raise();
    }
  };
  const start = (): void => {
    mount();
    new MutationObserver(() => {
      if (!host.isConnected) mount();
    }).observe(document.documentElement, { childList: true });
    // A dialog or popover that opens goes above the stage. Raise the stage again.
    document.addEventListener(
      'toggle',
      (event) => event.target !== host && queueMicrotask(raise),
      true,
    );
    new MutationObserver(() => queueMicrotask(raise)).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    send({ type: 'hello', width: window.innerWidth, height: window.innerHeight });
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
