// The in-page panel. The server turns this function into text. It runs in an
// isolated world inside the page, so it must not use anything from outside itself.
// Page scripts cannot see its variables or call its binding.

export interface PanelOptions {
  binding: string;
  css: string;
}

export function panelMain(opts: PanelOptions): void {
  if (window !== window.top) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__uiwalkPanel) return;

  type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  interface Question {
    id: string;
    nonce: string;
    title: string;
    didWhat: string;
    expected: string;
    step?: number;
    total?: number;
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
  const stepBadge = el('span', 'step');
  const moveButton = el('button', 'icon', '⇄');
  moveButton.title = 'Move to another corner';
  const collapseButton = el('button', 'icon', '\u2212');
  collapseButton.title = 'Collapse';
  header.append(brand, stepBadge, moveButton, collapseButton);

  const body = el('div', 'body');
  const status = el('p', 'status');
  const title = el('h2', 'title');
  const didLabel = el('p', 'label', 'What I did');
  const didText = el('p', 'text');
  const expectLabel = el('p', 'label', 'What you should see');
  const expectText = el('p', 'text');
  const notes = el('textarea', 'notes');
  notes.placeholder = 'Notes (required for Bug)';
  notes.rows = 3;
  const error = el('p', 'error');
  const buttons = el('div', 'buttons');
  const passButton = el('button', 'pass', 'Pass');
  const bugButton = el('button', 'bug', 'Bug');
  const skipButton = el('button', 'skip', 'Skip');
  const stopButton = el('button', 'stop', 'Stop');
  buttons.append(passButton, bugButton, skipButton, stopButton);
  const questionBox = el('div', 'question');
  questionBox.append(title, didLabel, didText, expectLabel, expectText, notes, error, buttons);
  body.append(status, questionBox);
  card.append(header, body);
  root.append(pulse, pulseLabel, annotation, card);

  // ---------- State ----------
  let question: Question | null = null;
  let corner: Corner = 'bottom-right';
  let collapsed = false;
  let pulseTimer: number | undefined;

  const placeCard = (): void => {
    card.style.left = '';
    card.style.top = '';
    card.dataset.corner = corner;
  };

  const render = (): void => {
    card.classList.toggle('collapsed', collapsed);
    card.classList.toggle('asking', Boolean(question));
    collapseButton.textContent = collapsed ? '+' : '\u2212';
    collapseButton.title = collapsed ? 'Expand' : 'Collapse';
    if (question) {
      stepBadge.textContent = question.step
        ? `Step ${question.step}${question.total ? ` of ${question.total}` : ''}`
        : 'Check';
      title.textContent = question.title;
      didText.textContent = question.didWhat;
      expectText.textContent = question.expected;
      questionBox.hidden = false;
      status.hidden = true;
    } else {
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

  const answer = (result: 'pass' | 'bug' | 'skip' | 'stop'): void => {
    if (!question) return;
    const note = notes.value.trim();
    if (result === 'bug' && !note) {
      error.textContent = 'Describe the bug in the notes. Then click Bug.';
      notes.focus();
      return;
    }
    send({ type: 'answer', id: question.id, nonce: question.nonce, result, note });
    question = null;
    notes.value = '';
    error.textContent = '';
    setStatus(
      `Sent: ${result === 'pass' ? 'Pass' : result === 'bug' ? 'Bug' : result === 'skip' ? 'Skip' : 'Stop'}. The agent is working.`,
    );
    render();
  };

  onTrusted(passButton, () => answer('pass'));
  onTrusted(bugButton, () => answer('bug'));
  onTrusted(skipButton, () => answer('skip'));
  onTrusted(stopButton, () => answer('stop'));
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

  // Keys typed in the panel must not reach the app's shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste']) {
    card.addEventListener(type, (event) => event.stopPropagation());
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
        setStatus((msg.status as string) ?? 'The agent is working.');
        if (msg.corner) corner = msg.corner as Corner;
        placeCard();
        render();
        break;
      }
      case 'hide':
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
