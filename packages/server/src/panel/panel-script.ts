// The in-page panel. The server turns this function into text. It runs in an
// isolated world inside the page, so it must not use anything from outside itself.
// Page scripts cannot see its variables or call its binding.

export interface PanelOptions {
  binding: string;
  css: string;
}

export function panelMain(opts: PanelOptions, candidates: (el: Element) => string[]): void {
  if (window !== window.top) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__uiwalkPanel) return;

  // A panel that starts after the page's own scripts cannot fully guard what it copies.
  const late = document.readyState !== 'loading';
  let copying = false;
  // This listener comes before page scripts, so they never see or change the panel's own copy.
  window.addEventListener(
    'copy',
    (event) => {
      if (copying) event.stopImmediatePropagation();
    },
    true,
  );

  type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  // The same shapes as panel/view.ts and panel/rich-text.ts.
  type Inline = { t: 'text' | 'b' | 'i' | 'code'; v: string } | { t: 'copy'; id: string };
  type Block =
    | { t: 'p'; lines: Inline[][] }
    | { t: 'ul'; items: Inline[][] }
    | { t: 'ol'; start: number; items: Inline[][] }
    | { t: 'check'; items: Array<{ text: Inline[]; checked: boolean }> }
    | { t: 'code'; v: string };
  interface Section {
    key: string;
    label: string;
    blocks: Block[];
    collapsible?: boolean;
    collapsed?: boolean;
  }
  interface ViewButton {
    result: string;
    label: string;
    color?: string;
    textColor?: string;
  }
  interface View {
    kind: 'step' | 'confirm';
    title: string;
    sections: Section[];
    buttons: ViewButton[];
    notes: boolean;
    color?: string;
    snippets: Record<string, { code: string; help?: Block[] }>;
    image?: boolean;
  }
  interface Question {
    id: string;
    nonce: string;
    step?: number;
    total?: number;
    view: View;
    ui: Record<string, boolean>;
  }
  interface Badge {
    label: string;
    color: string;
  }
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

  // ---------- Build the panel ----------
  const host = document.createElement('uiwalk-panel');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-uiwalk', 'panel');
  const root = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(opts.css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = opts.css;
    root.appendChild(style);
  }

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const pulse = el('div', 'pulse');
  const pulseLabel = el('div', 'pulse-label');
  const annotation = el('div', 'annotation');

  const card = el('section', 'card');
  const header = el('header', 'header');
  const brand = el('span', 'brand', 'Walkthrough');
  const envBadge = el('span', 'env');
  const stepBadge = el('span', 'step');
  const moveButton = el('button', 'icon', '⇄');
  moveButton.title = 'Move to another corner';
  const collapseButton = el('button', 'icon', '\u2212');
  collapseButton.title = 'Collapse';
  header.append(brand, envBadge, stepBadge, moveButton, collapseButton);

  const body = el('div', 'body');
  const status = el('p', 'status');
  const title = el('h2', 'title');
  const sections = el('div', 'sections');
  const notes = el('textarea', 'notes');
  notes.rows = 3;
  const error = el('p', 'error');
  const buttons = el('div', 'buttons');
  const questionBox = el('div', 'question');
  questionBox.append(title, sections, notes, error, buttons);

  // The recording view.
  const recordBox = el('div', 'recording');
  const recordText = el('p', 'text');
  const expectInput = el('textarea', 'notes rec-notes');
  expectInput.placeholder = 'What should the page show now?';
  expectInput.rows = 2;
  const recordButtons = el('div', 'buttons record-buttons');
  const expectButton = el('button', 'rec-expect', 'Add expectation');
  const saveExpectButton = el('button', 'rec-save', 'Save expectation');
  const secretButton = el('button', 'rec-secret', 'Mark last field as secret');
  const stopRecordButton = el('button', 'rec-stop', 'Stop recording');
  recordButtons.append(expectButton, secretButton, stopRecordButton);
  recordBox.append(recordText, expectInput, saveExpectButton, recordButtons);
  body.append(status, questionBox, recordBox);
  card.append(header, body);

  // A window in the middle of the page, for snippet help and big images.
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.tabIndex = -1;
  const modalHead = el('div', 'modal-head');
  const modalTitle = el('h2', 'modal-title');
  const modalClose = el('button', 'icon modal-close', '\u00D7');
  modalClose.title = 'Close';
  modalHead.append(modalTitle, modalClose);
  const modalBody = el('div', 'modal-body');
  modal.append(modalHead, modalBody);
  backdrop.append(modal);
  backdrop.hidden = true;
  root.append(pulse, pulseLabel, annotation, card, backdrop);

  // ---------- State ----------
  let question: Question | null = null;
  let env: Badge | null = null;
  let recording: { count: number; last: string } | null = null;
  let addingExpect = false;
  let corner: Corner = 'bottom-right';
  let collapsed = false;
  let pulseTimer: number | undefined;

  const placeCard = (): void => {
    card.style.left = '';
    card.style.top = '';
    card.dataset.corner = corner;
  };

  // ---------- The window in the middle ----------
  const openModal = (heading: string, nodes: Node[]): void => {
    modalTitle.textContent = heading;
    modalBody.replaceChildren(...nodes);
    backdrop.hidden = false;
    modal.focus();
  };
  const closeModal = (): void => {
    backdrop.hidden = true;
    modalBody.replaceChildren();
  };
  backdrop.addEventListener('click', (event) => {
    if (event.isTrusted && event.target === backdrop) closeModal();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Escape') closeModal();
  });

  // ---------- Copy ----------
  // A short note next to a button, like "Copied".
  const flash = (button: HTMLElement, text: string, ms = 1500): void => {
    const note = el('span', 'copy-note', text);
    button.after(note);
    window.setTimeout(() => note.remove(), ms);
  };

  const copyText = async (text: string, button: HTMLElement): Promise<void> => {
    let ok = false;
    let fallback = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      // Not allowed on this page. Try the other way.
    }
    if (!ok) {
      fallback = true;
      const area = el('textarea', 'copy-area');
      area.value = text;
      root.append(area);
      area.select();
      copying = true;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        copying = false;
        area.remove();
      }
    }
    if (!ok) flash(button, 'Could not copy. Select the text and copy it.', 4000);
    else if (fallback && late) flash(button, 'Copied. Check the text before you paste it.', 4000);
    else flash(button, 'Copied');
  };

  // ---------- Question parts ----------
  let snippets: View['snippets'] = {};
  let ui: Record<string, boolean> = {};
  // The check boxes of the question, so Pass can see the open ones.
  let boxes: HTMLInputElement[] = [];
  let passWarned = false;

  // Tells the server about a change, like a tick, so it survives a page load.
  const sendUi = (key: string, value: boolean): void => {
    if (!question) return;
    question.ui[key] = value;
    send({ type: 'ui', id: question.id, nonce: question.nonce, key, value });
  };

  const snippetHelp = (code: string, help: Block[]): void => {
    const wrap = codeBlock(code, 'copy-modal');
    openModal('About this snippet', [wrap, ...help.map((b) => drawBlock(b))]);
  };

  const inlineNodes = (parts: Inline[]): Node[] =>
    parts.map((part) => {
      if (part.t === 'copy') {
        const snippet = snippets[part.id];
        if (!snippet) return el('code', undefined, `{{copy:${part.id}}}`);
        const chip = el('span', 'snip');
        const copy = el('button', 'copy-snip', 'Copy');
        copy.title = 'Copy to the clipboard';
        onTrusted(copy, () => void copyText(snippet.code, copy));
        chip.append(el('code', undefined, snippet.code), copy);
        if (snippet.help) {
          const help = el('button', 'help-snip', '?');
          help.title = 'About this snippet';
          const blocks = snippet.help;
          onTrusted(help, () => snippetHelp(snippet.code, blocks));
          chip.append(help);
        }
        return chip;
      }
      if (part.t === 'b') return el('strong', undefined, part.v);
      if (part.t === 'i') return el('em', undefined, part.v);
      if (part.t === 'code') return el('code', undefined, part.v);
      return document.createTextNode(part.v);
    });

  function codeBlock(code: string, buttonClass: string): HTMLElement {
    const wrap = el('div', 'code-wrap');
    const pre = el('pre', 'code');
    pre.append(el('code', undefined, code));
    const copy = el('button', `copy-button ${buttonClass}`, 'Copy');
    copy.title = 'Copy to the clipboard';
    onTrusted(copy, () => void copyText(code, copy));
    wrap.append(pre, copy);
    return wrap;
  }

  // "where" is the section and block number of a check list the developer can tick.
  function drawBlock(block: Block, where?: string): HTMLElement {
    switch (block.t) {
      case 'p': {
        const p = el('p', 'text');
        block.lines.forEach((line, i) => {
          if (i > 0) p.append(el('br'));
          p.append(...inlineNodes(line));
        });
        return p;
      }
      case 'ul':
      case 'ol': {
        const list = el(block.t, 'list');
        if (block.t === 'ol' && block.start !== 1) (list as HTMLOListElement).start = block.start;
        for (const item of block.items) {
          const li = el('li', undefined);
          li.append(...inlineNodes(item));
          list.append(li);
        }
        return list;
      }
      case 'check': {
        const list = el('ul', 'checks');
        block.items.forEach((item, i) => {
          const key = `check:${where}:${i}`;
          const box = el('input', `check ${key.replace(/:/g, '-')}`);
          box.type = 'checkbox';
          box.checked = ui[key] ?? item.checked;
          box.disabled = !where;
          if (where) {
            boxes.push(box);
            box.addEventListener('click', (event) => {
              if (!event.isTrusted) {
                event.preventDefault();
                return;
              }
              passWarned = false;
              error.textContent = '';
              sendUi(key, box.checked);
            });
          }
          const text = el('span', undefined);
          text.append(...inlineNodes(item.text));
          const li = el('li', undefined);
          li.append(box, text);
          list.append(li);
        });
        return list;
      }
      case 'code':
        return codeBlock(block.v, 'copy-code');
    }
  }

  // ---------- Reference image ----------
  let imageBox: HTMLElement | null = null;
  let bitmap: ImageBitmap | null = null;
  const canvasOf = (image: ImageBitmap, className: string): HTMLCanvasElement => {
    const canvas = el('canvas', className);
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    return canvas;
  };
  // A canvas, not an <img>, because a page's image rules (CSP) can block data: images.
  const showImage = async (id: string, mime: string, data: string): Promise<void> => {
    try {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: mime }));
      if (question?.id !== id || !imageBox) return;
      bitmap = image;
      const thumb = canvasOf(image, 'ref-thumb');
      thumb.title = 'Show it bigger';
      onTrusted(thumb, () => {
        if (bitmap) openModal('What the page should look like', [canvasOf(bitmap, 'ref-big')]);
      });
      imageBox.replaceChildren(
        thumb,
        el('span', 'caption', 'Reference image. Click to make it bigger.'),
      );
    } catch {
      imageBox?.replaceChildren(
        el('span', 'caption', 'Walkthrough could not show the reference image.'),
      );
    }
  };

  const drawSection = (section: Section): HTMLElement => {
    const box = el('div', `section section-${section.key}`);
    const content = el('div', 'section-body');
    content.append(...section.blocks.map((b, i) => drawBlock(b, `${section.key}:${i}`)));
    if (section.collapsible) {
      let open = ui[`open:${section.key}`] ?? !section.collapsed;
      const toggle = el('button', `toggle toggle-${section.key}`);
      const arrow = el('span', 'arrow');
      const label = el('span', undefined, section.label || 'More');
      toggle.append(arrow, label);
      const sync = () => {
        arrow.textContent = open ? '\u25BE' : '\u25B8';
        toggle.setAttribute('aria-expanded', String(open));
        content.hidden = !open;
      };
      onTrusted(toggle, () => {
        open = !open;
        sync();
        sendUi(`open:${section.key}`, open);
      });
      sync();
      box.append(toggle, content);
    } else {
      if (section.label) box.append(el('p', 'label', section.label));
      box.append(content);
    }
    return box;
  };

  // Draws the parts of a question once. A part drawn again would lose a click.
  let drawnId = '';
  const drawQuestion = (q: Question): void => {
    if (drawnId === q.id) return;
    drawnId = q.id;
    const view = q.view;
    snippets = view.snippets ?? {};
    ui = q.ui ?? {};
    q.ui = ui;
    boxes = [];
    passWarned = false;
    bitmap = null;
    closeModal();
    title.textContent = view.title;
    const parts = view.sections.map(drawSection);
    imageBox = null;
    if (view.image) {
      imageBox = el('div', 'ref-image');
      imageBox.append(el('span', 'caption', 'Loading the reference image...'));
      // Under "What you should see", or last.
      const at = view.sections.findIndex((s) => s.key === 'expect');
      parts.splice(at >= 0 ? at + 1 : parts.length, 0, imageBox);
    }
    sections.replaceChildren(...parts);
    buttons.replaceChildren(
      ...view.buttons.map((b) => {
        const button = el('button', b.result, b.label);
        if (b.color) {
          button.style.background = b.color;
          button.style.borderColor = b.color;
          button.style.color = b.textColor ?? '';
        }
        onTrusted(button, () => answer(b.result));
        return button;
      }),
    );
    buttons.classList.toggle('two', view.buttons.length === 2);
    notes.hidden = !view.notes;
    error.hidden = !view.notes;
    const bug = view.buttons.find((b) => b.result === 'bug');
    notes.placeholder = bug ? `Notes (required for ${bug.label})` : 'Notes';
  };

  const render = (): void => {
    envBadge.hidden = !env;
    envBadge.textContent = env?.label ?? '';
    envBadge.style.background = env?.color ?? '';
    const confirm = question?.view.kind === 'confirm';
    card.classList.toggle('confirming', confirm);
    card.style.borderColor = confirm && question?.view.color ? question.view.color : '';
    card.classList.toggle('collapsed', collapsed);
    card.classList.toggle('asking', Boolean(question));
    card.classList.toggle('recording-on', Boolean(recording));
    recordBox.hidden = !recording;
    expectInput.hidden = !addingExpect;
    saveExpectButton.hidden = !addingExpect;
    if (recording) {
      stepBadge.textContent = '\u25CF Recording';
      recordText.textContent = recording.count
        ? `${recording.count} step${recording.count === 1 ? '' : 's'} so far. Last: ${recording.last}`
        : 'Use the app as usual. Walkthrough records each click and each field that you type in.';
      questionBox.hidden = true;
      status.hidden = true;
      return;
    }
    collapseButton.textContent = collapsed ? '+' : '\u2212';
    collapseButton.title = collapsed ? 'Expand' : 'Collapse';
    if (question) {
      stepBadge.textContent = confirm
        ? 'Confirm'
        : question.step
          ? `Step ${question.step}${question.total ? ` of ${question.total}` : ''}`
          : 'Check';
      drawQuestion(question);
      questionBox.hidden = false;
      status.hidden = true;
    } else {
      drawnId = '';
      stepBadge.textContent = '';
      questionBox.hidden = true;
      status.hidden = false;
    }
  };

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  // Only real clicks from the developer count. Page scripts cannot fake them.
  const onTrusted = (button: HTMLElement, fn: () => void): void => {
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      fn();
    });
  };

  function answer(result: string): void {
    if (!question) return;
    const note = notes.value.trim();
    const label = question.view.buttons.find((b) => b.result === result)?.label ?? result;
    if (result === 'bug' && !note) {
      error.textContent = `Describe the bug in the notes. Then click ${label}.`;
      notes.focus();
      return;
    }
    // Open boxes need a second click on Pass.
    const open = boxes.filter((b) => !b.checked).length;
    if (result === 'pass' && open && !passWarned) {
      passWarned = true;
      error.textContent = `${open} item${open === 1 ? ' is' : 's are'} not ticked. Click ${label} again to pass anyway.`;
      return;
    }
    closeModal();
    send({ type: 'answer', id: question.id, nonce: question.nonce, result, note });
    const confirmed = question.view.kind === 'confirm';
    question = null;
    notes.value = '';
    error.textContent = '';
    if (confirmed) {
      setStatus(result === 'pass' ? 'Confirmed. The agent is working.' : 'Canceled.');
    } else {
      setStatus(`Sent: ${label}. The agent is working.`);
    }
    render();
  }

  onTrusted(expectButton, () => {
    addingExpect = true;
    render();
    expectInput.focus();
  });
  onTrusted(saveExpectButton, () => {
    const text = expectInput.value.trim();
    if (text) send({ type: 'rec-expect', text });
    expectInput.value = '';
    addingExpect = false;
    render();
  });
  onTrusted(secretButton, () => send({ type: 'rec-secret' }));
  onTrusted(stopRecordButton, () => send({ type: 'rec-stop' }));

  onTrusted(collapseButton, () => {
    collapsed = !collapsed;
    render();
  });
  const corners: Corner[] = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
  onTrusted(moveButton, () => {
    corner = corners[(corners.indexOf(corner) + 1) % corners.length] as Corner;
    placeCard();
    send({ type: 'moved', corner });
  });

  onTrusted(modalClose, closeModal);

  // Keys typed in the panel must not reach the app's shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste']) {
    card.addEventListener(type, (event) => event.stopPropagation());
    backdrop.addEventListener(type, (event) => event.stopPropagation());
  }

  // Drag the panel by its header.
  header.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || (event.target as HTMLElement).tagName === 'BUTTON') return;
    const box = card.getBoundingClientRect();
    const dx = event.clientX - box.left;
    const dy = event.clientY - box.top;
    header.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      card.dataset.corner = 'free';
      card.style.left = `${Math.max(0, Math.min(window.innerWidth - box.width, e.clientX - dx))}px`;
      card.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy))}px`;
    };
    const up = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  });

  // Move the card out of the way of the element the agent is about to use.
  const avoid = (rect: Rect): void => {
    const box = card.getBoundingClientRect();
    const overlaps =
      rect.x < box.right &&
      rect.x + rect.width > box.left &&
      rect.y < box.bottom &&
      rect.y + rect.height > box.top;
    if (!overlaps) return;
    const flip: Record<string, Corner> = {
      'bottom-right': 'bottom-left',
      'bottom-left': 'bottom-right',
      'top-left': 'top-right',
      'top-right': 'top-left',
    };
    corner = flip[card.dataset.corner ?? corner] ?? 'bottom-left';
    placeCard();
  };

  const showPulse = (rect: Rect, label: string, ms: number): void => {
    Object.assign(pulse.style, {
      left: `${rect.x - 4}px`,
      top: `${rect.y - 4}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 8}px`,
      display: 'block',
    });
    pulseLabel.textContent = label;
    Object.assign(pulseLabel.style, {
      left: `${rect.x - 4}px`,
      top: `${Math.max(0, rect.y - 30)}px`,
      display: label ? 'block' : 'none',
    });
    avoid(rect);
    window.clearTimeout(pulseTimer);
    pulseTimer = window.setTimeout(() => {
      pulse.style.display = 'none';
      pulseLabel.style.display = 'none';
    }, ms + 200);
  };

  // Messages from the server.
  const receive = (msg: Record<string, unknown>): void => {
    switch (msg.type) {
      case 'state': {
        const next = (msg.question as Question | null) ?? null;
        // A new question starts with empty notes.
        if (next?.id !== question?.id) {
          notes.value = '';
          error.textContent = '';
        }
        question = next;
        env = (msg.env as Badge | null) ?? null;
        recording = (msg.recording as { count: number; last: string } | null) ?? null;
        if (!recording) addingExpect = false;
        setStatus((msg.status as string) ?? 'The agent is working.');
        if (msg.corner) corner = msg.corner as Corner;
        placeCard();
        render();
        break;
      }
      case 'image':
        void showImage(msg.id as string, msg.mime as string, msg.data as string);
        break;
      case 'hide':
        backdrop.style.visibility = msg.hidden ? 'hidden' : '';
        card.style.visibility = msg.hidden ? 'hidden' : '';
        pulse.style.visibility = msg.hidden ? 'hidden' : '';
        pulseLabel.style.visibility = msg.hidden ? 'hidden' : '';
        break;
      case 'highlight':
        showPulse(msg.rect as Rect, (msg.label as string) ?? '', (msg.ms as number) ?? 600);
        break;
      case 'annotate': {
        const rect = msg.rect as Rect | null;
        if (!rect) {
          annotation.style.display = 'none';
          break;
        }
        // Page position, so it also lines up in a full-page screenshot.
        Object.assign(annotation.style, {
          left: `${rect.x + window.scrollX - 3}px`,
          top: `${rect.y + window.scrollY - 3}px`,
          width: `${rect.width + 6}px`,
          height: `${rect.height + 6}px`,
          display: 'block',
        });
        break;
      }
    }
  };

  // ---------- Recorder ----------
  // Records the developer's own clicks and typing while recording is on.
  const inPanel = (target: EventTarget | null): boolean =>
    target === host || host.contains(target as Node);

  const roleOf = (node: Element): string | undefined => {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute('type') ?? 'text').toLowerCase();
    if (tag === 'a' && node.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type))
        return 'textbox';
    }
    return undefined;
  };

  // The name a person sees for the element, like its label or its text.
  const nameOf = (node: Element): string => {
    const html = node as HTMLInputElement;
    const aria = node.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    if (html.labels && html.labels.length > 0) {
      const label = html.labels[0] as HTMLLabelElement;
      // The label text, without the text of the field inside it.
      const copy = label.cloneNode(true) as HTMLElement;
      for (const inner of Array.from(copy.querySelectorAll('input, select, textarea')))
        inner.remove();
      const text = copy.textContent?.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    const text = (node as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
    if (text && ['a', 'button'].includes(node.tagName.toLowerCase())) return text;
    return (
      html.placeholder ||
      node.getAttribute('title') ||
      node.getAttribute('alt') ||
      html.value ||
      text ||
      ''
    ).trim();
  };

  // A target for the plan: role and name when they are unique, or a CSS selector.
  const targetOf = (node: Element): Record<string, string> => {
    const role = roleOf(node);
    const name = nameOf(node).slice(0, 80);
    const all = candidates(node);
    const testId = all.find((c) => c.startsWith('[data-'));
    if (testId && document.querySelectorAll(testId).length === 1) return { selector: testId };
    if (role && name && !/[()[\]"]/.test(name)) {
      const same = Array.from(
        document.querySelectorAll('a, button, input, select, textarea, [role]'),
      ).filter((other) => roleOf(other) === role && nameOf(other).slice(0, 80) === name);
      if (same.length === 1) return { role, name };
    }
    for (const selector of all) {
      if (selector.includes('::-p-')) continue;
      try {
        if (document.querySelectorAll(selector).length === 1) return { selector };
      } catch {}
    }
    return { selector: all[all.length - 1] ?? node.tagName.toLowerCase() };
  };

  const label = (node: Element): string => {
    const name = nameOf(node);
    return name ? `"${name.slice(0, 60)}"` : node.tagName.toLowerCase();
  };

  const record = (kind: string, node: Element, extra: Record<string, unknown> = {}): void => {
    if (!recording) return;
    const target = targetOf(node);
    send({ type: 'rec', kind, target, label: label(node), key: JSON.stringify(target), ...extra });
  };

  const isTextField = (node: Element): boolean => {
    const tag = node.tagName.toLowerCase();
    return (
      tag === 'textarea' ||
      (tag === 'input' && roleOf(node) === 'textbox') ||
      (node as HTMLElement).isContentEditable
    );
  };

  const fieldValue = (node: Element): Record<string, unknown> => {
    const input = node as HTMLInputElement;
    // A password never leaves the page. The plan gets a secret instead.
    if (input.type === 'password')
      return { secret: true, fieldName: input.name || input.id || 'password' };
    return {
      value: (node as HTMLElement).isContentEditable
        ? (node as HTMLElement).innerText
        : input.value,
    };
  };

  document.addEventListener(
    'click',
    (event) => {
      if (!recording || !event.isTrusted || inPanel(event.target)) return;
      const start = event.target as Element | null;
      const node = start?.closest?.(
        'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [onclick]',
      );
      if (!node) return;
      const tag = node.tagName.toLowerCase();
      // Fields, lists, and check boxes are recorded when their value changes.
      if (tag === 'select' || tag === 'textarea' || tag === 'label') return;
      if (tag === 'input' && roleOf(node) !== 'button') return;
      record('click', node);
    },
    true,
  );

  document.addEventListener(
    'change',
    (event) => {
      if (!recording || !event.isTrusted || inPanel(event.target)) return;
      const node = event.target as HTMLInputElement;
      const tag = node.tagName.toLowerCase();
      if (tag === 'select') {
        const option = (node as unknown as HTMLSelectElement).selectedOptions[0];
        record('select', node, { value: option?.label.trim() || node.value });
      } else if (node.type === 'checkbox') {
        record(node.checked ? 'check' : 'uncheck', node);
      } else if (node.type === 'radio') {
        record('check', node);
      } else if (node.type === 'file') {
        record('upload', node, { files: Array.from(node.files ?? []).map((f) => f.name) });
      } else if (isTextField(node)) {
        record('fill', node, fieldValue(node));
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!recording || !event.isTrusted || inPanel(event.target) || event.key !== 'Enter') return;
      const node = event.target as Element;
      if (!isTextField(node) || node.tagName.toLowerCase() === 'textarea') return;
      // Save the text first. The change event may come after the Enter key.
      record('fill', node, fieldValue(node));
      record('press', node, { value: 'Enter' });
    },
    true,
  );

  w.__uiwalkPanel = { receive };

  // Put the panel on the page, and put it back if the app removes it.
  const mount = (): void => {
    const parent = document.documentElement;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  };
  const start = (): void => {
    mount();
    new MutationObserver(() => {
      if (!host.isConnected) mount();
    }).observe(document.documentElement, { childList: true });
    placeCard();
    render();
    send({ type: 'hello' });
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
