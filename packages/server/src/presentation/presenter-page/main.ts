// The presenter window: controls, notes, the time, the step list, a mirror of the
// audience screen, and the chat with the agent. It runs in its own browser login.
import type {
  PresenterBoot,
  PresenterChat,
  PresenterMessage,
  PresenterStep,
  PresenterView,
  ToPresenter,
} from '../presenter-protocol.js';
import { PRESENTER_CSS } from './css.js';

const w = window as unknown as Record<string, unknown>;
const boot = w.__uiwalkPresenterBoot as PresenterBoot;

function send(msg: PresenterMessage): void {
  const fn = w[boot.binding] as ((payload: string) => void) | undefined;
  if (typeof fn === 'function') fn(JSON.stringify({ nonce: boot.nonce, msg }));
}

// ---------- Small helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// Only real clicks and key presses count. A script on the page cannot press the buttons.
function onClick(node: HTMLElement, fn: () => void): void {
  node.addEventListener('click', (event) => {
    if (event.isTrusted) fn();
  });
}

function button(label: string, act: string, fn: () => void, kind = ''): HTMLButtonElement {
  const node = h('button', { type: 'button', class: kind, 'data-act': act }, label);
  onClick(node, fn);
  return node;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

// Notes use a small part of Markdown: paragraphs, "- " lists, **bold**, *italic*, and
// `code`. Raw HTML shows as text. A link shows its text and its address as text.
function inline(text: string): Node[] {
  const out: Node[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    const token = match[0];
    if (token.startsWith('**')) out.push(h('strong', {}, token.slice(2, -2)));
    else if (token.startsWith('`')) out.push(h('code', {}, token.slice(1, -1)));
    else if (token.startsWith('[')) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) ?? [];
      out.push(document.createTextNode(`${label} (${url})`));
    } else out.push(h('em', {}, token.slice(1, -1)));
    last = at + token.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function markdown(text: string): Node[] {
  const blocks: Node[] = [];
  const item = /^\s*[-*]\s+/;
  for (const block of text.trim().split(/\n\s*\n/)) {
    // Lines that start with "- " make a list. Other lines next to each other make a paragraph.
    let list: HTMLUListElement | undefined;
    let para: HTMLParagraphElement | undefined;
    for (const line of block.split('\n')) {
      if (item.test(line)) {
        para = undefined;
        if (!list) {
          list = h('ul');
          blocks.push(list);
        }
        list.append(h('li', {}, ...inline(line.replace(item, ''))));
        continue;
      }
      list = undefined;
      if (para) para.append(h('br'));
      else {
        para = h('p');
        blocks.push(para);
      }
      para.append(...inline(line));
    }
  }
  return blocks;
}

// ---------- The page ----------

const style = document.createElement('style');
style.textContent = PRESENTER_CSS;
document.head.append(style);

const nameEl = h('b', { class: 'name' });
const envEl = h('span', { class: 'env' });
const urlEl = h('span', { class: 'url' });
const stepNoEl = h('span', { class: 'stepno' });
const elapsedEl = h('span', { class: 'elapsed', 'data-part': 'elapsed' });
const clockEl = h('span', { class: 'clock' });
const header = h(
  'header',
  {},
  h('div', { class: 'title' }, nameEl, envEl, urlEl),
  h('div', { class: 'clocks' }, stepNoEl, elapsedEl, clockEl),
);

const chipEl = h('span', { class: 'chip', 'data-part': 'state' });
const stepTitleEl = h('h1', { 'data-part': 'step-title' });
const stepTimeEl = h('span', { class: 'steptime', 'data-part': 'step-time' });
const now = h(
  'div',
  { class: 'now' },
  h('div', { class: 'nowbar' }, chipEl, stepTimeEl),
  stepTitleEl,
);

const failureText = h('p', { 'data-part': 'failure-text' });
const failure = h(
  'div',
  { class: 'failure', 'data-part': 'failure' },
  h('b', {}, 'This step did not work.'),
  failureText,
  h(
    'div',
    { class: 'row' },
    button('Retry', 'retry', () => command({ type: 'retry' }), 'primary'),
    button('Skip', 'skip-failed', () => command({ type: 'skip' })),
    button('I will do it by hand', 'manual', () => command({ type: 'manual' })),
  ),
);
const manualNote = h(
  'div',
  { class: 'manual', 'data-part': 'manual' },
  'Use the app in the audience window. Then click Continue.',
);

let notesSize = 22;
const notesEl = h('div', { class: 'notes-text', 'data-part': 'notes' });
const notes = h(
  'div',
  { class: 'notes' },
  h(
    'div',
    { class: 'notesbar' },
    h('span', {}, 'Notes'),
    button('A-', 'smaller', () => setNotesSize(notesSize - 2), 'small'),
    button('A+', 'bigger', () => setNotesSize(notesSize + 2), 'small'),
  ),
  notesEl,
);
function setNotesSize(px: number): void {
  notesSize = Math.min(48, Math.max(12, px));
  notesEl.style.fontSize = `${notesSize}px`;
}
setNotesSize(notesSize);

const nextEl = h('div', { class: 'next', 'data-part': 'next' });

const primary = h('div', { class: 'primary-row' });
const backBtn = button('Back', 'back', () => command({ type: 'back' }));
const skipBtn = button('Skip', 'skip', () => command({ type: 'skip' }));
const blankBtn = button('Blank', 'blank', () => send({ type: 'blank' }));
const titleBtn = button('Title', 'title', () => send({ type: 'title' }));
const fullBtn = button('Fullscreen', 'fullscreen', () => send({ type: 'fullscreen' }));
const screenBtn = button('Other screen', 'screen', () => void chooseScreen());
const endBtn = button('Go to end', 'end', () => command({ type: 'end' }), 'danger');
const controls = h(
  'div',
  { class: 'controls' },
  primary,
  h('div', { class: 'row' }, backBtn, skipBtn, endBtn),
  h('div', { class: 'row' }, blankBtn, titleBtn, fullBtn, screenBtn),
);

const left = h('section', { class: 'left' }, now, failure, manualNote, notes, nextEl, controls);

const mirrorImg = h('img', { alt: 'The audience screen', 'data-part': 'mirror' });
const mirror = h('div', { class: 'mirror' }, mirrorImg);
const stepList = h('ol', { class: 'steps', 'data-part': 'steps' });
const jumpBar = h('div', { class: 'jumpbar', 'data-part': 'jump' });

const chatLog = h('div', { class: 'chatlog', 'data-part': 'chat' });
const chatStatus = h('div', { class: 'chatstatus', 'data-part': 'chat-status' });
const chatInput = h('textarea', {
  rows: '2',
  maxlength: '500',
  placeholder: 'Ask Claude about the app. Enter sends.',
  'data-part': 'chat-input',
});
const askBtn = button('Ask', 'ask', () => ask(), 'primary');
const chat = h(
  'div',
  { class: 'chat' },
  h('div', { class: 'chathead' }, 'Chat'),
  chatLog,
  chatStatus,
  h('div', { class: 'chatform' }, chatInput, askBtn),
);

const right = h('aside', { class: 'right' }, mirror, jumpBar, stepList, chat);
const main = h('main', {}, left, right);

// A question in front of everything: the protected environment.
const confirmTitle = h('h2');
const confirmBox = h(
  'div',
  { class: 'modal', 'data-part': 'confirm' },
  h(
    'div',
    { class: 'dialog' },
    confirmTitle,
    h(
      'p',
      {},
      'This is a protected environment. The steps can create real data there. The app opens after you confirm.',
    ),
    h(
      'div',
      { class: 'row' },
      button('Present here', 'confirm', () => send({ type: 'confirm' }), 'danger'),
      button('Cancel', 'cancel', () => send({ type: 'cancel' })),
    ),
  ),
);

const screenList = h('div', { class: 'screens' });
const screenBox = h(
  'div',
  { class: 'modal', 'data-part': 'screens' },
  h(
    'div',
    { class: 'dialog' },
    h('h2', {}, 'Send the audience window to a screen'),
    screenList,
    h(
      'div',
      { class: 'row' },
      button('Cancel', 'screens-cancel', () => hide(screenBox)),
    ),
  ),
);

const toast = h('div', { class: 'toast', 'data-part': 'notice' });

document.body.append(header, main, confirmBox, screenBox, toast);
hide(confirmBox);
hide(screenBox);
hide(toast);

function hide(node: HTMLElement): void {
  node.hidden = true;
}

function show(node: HTMLElement, on = true): void {
  node.hidden = !on;
}

let toastTimer: number | undefined;
function notice(text: string): void {
  toast.textContent = text;
  show(toast);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hide(toast), 4000);
}

// ---------- Actions ----------

let view: PresenterView | undefined;

function command(cmd: Extract<PresenterMessage, { type: 'command' }>['command']): void {
  if (!view?.can.includes(cmd.type)) return;
  send({ type: 'command', command: cmd });
}

function ask(): void {
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: 'ask', text });
  chatInput.value = '';
  // The keys go back to the presentation, so a clicker works again.
  chatInput.blur();
}

chatInput.addEventListener('keydown', (event) => {
  if (!event.isTrusted) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ask();
  } else if (event.key === 'Escape') {
    chatInput.blur();
  }
});

interface ScreenInfo {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

async function chooseScreen(): Promise<void> {
  let screens: ScreenInfo[] = [];
  try {
    const details = await (
      window as unknown as { getScreenDetails(): Promise<{ screens: ScreenInfo[] }> }
    ).getScreenDetails();
    screens = details.screens;
  } catch {
    notice('Chrome did not list the screens. Drag the audience window to the other screen.');
    return;
  }
  if (screens.length < 2) {
    notice('Only one screen is connected.');
    return;
  }
  screenList.replaceChildren(
    ...screens.map((s, i) =>
      button(
        `${s.label || `Screen ${i + 1}`}: ${s.width} x ${s.height}${s.isPrimary ? ' (main)' : ''}`,
        `screen-${i + 1}`,
        () => {
          hide(screenBox);
          send({ type: 'screen', left: s.left, top: s.top, width: s.width, height: s.height });
        },
      ),
    ),
  );
  show(screenBox);
}

// The step list: a click asks before it jumps.
function askJump(step: PresenterStep): void {
  if (!view) return;
  const back = step.index - 1 < view.current;
  jumpBar.replaceChildren(
    h(
      'span',
      {},
      back
        ? `Go back to step ${step.index}? The app starts over in a new login. The steps before it run at full speed.`
        : `Jump to step ${step.index}? The steps before it run at full speed.`,
    ),
    button(
      'Jump',
      'jump-go',
      () => {
        jumpBar.replaceChildren();
        command({ type: 'jump', step: step.index });
      },
      'primary',
    ),
    button('Cancel', 'jump-cancel', () => jumpBar.replaceChildren()),
  );
}

// Keys for the presenter, like on a clicker. They do not count while the chat has focus.
window.addEventListener('keydown', (event) => {
  if (!event.isTrusted || !view) return;
  const key = event.key;
  const target = event.target as HTMLElement | null;
  const typing = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
  // Most clickers send Page Down and Page Up. Those work while the chat has the cursor.
  if (typing && key !== 'PageDown' && key !== 'PageUp') return;
  if (key === 'Escape') {
    hide(screenBox);
    jumpBar.replaceChildren();
    return;
  }
  if (view.confirmNeeded) return;
  if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
    event.preventDefault();
    send({ type: 'next' });
  } else if (key === 'ArrowLeft' || key === 'PageUp') {
    event.preventDefault();
    command({ type: 'back' });
  } else if (key === 'b' || key === 'B' || key === '.') {
    event.preventDefault();
    send({ type: 'blank' });
  }
});

// ---------- Drawing ----------

const STATE_TEXT: Record<string, string> = {
  title: 'Title',
  gate: 'Waiting',
  running: 'Playing',
  failed: 'Failed',
  manual: 'By hand',
  end: 'End screen',
  stopped: 'Ended',
};

let viewAt = 0;

function stepElapsed(v: PresenterView): number {
  return v.stepElapsedMs + (v.stepClockRunning ? Date.now() - viewAt : 0);
}

function budgetClass(spent: number, budgetSec?: number): string {
  if (!budgetSec) return '';
  if (spent > budgetSec * 1000) return 'over';
  if (spent > budgetSec * 800) return 'near';
  return '';
}

function drawClocks(): void {
  const d = new Date();
  clockEl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!view) return;
  const elapsed = view.startedAt ? Date.now() - view.startedAt : 0;
  elapsedEl.textContent = `${clock(elapsed)}${view.timeBudgetSec ? ` of ${clock(view.timeBudgetSec * 1000)}` : ''}`;
  elapsedEl.className = `elapsed ${budgetClass(elapsed, view.timeBudgetSec)}`;
  const step = view.steps[view.current];
  if (step && view.state !== 'title') {
    const spent = stepElapsed(view);
    stepTimeEl.textContent = `${clock(spent)}${step.timeBudgetSec ? ` of ${clock(step.timeBudgetSec * 1000)}` : ''}`;
    stepTimeEl.className = `steptime ${budgetClass(spent, step.timeBudgetSec)}`;
  } else {
    stepTimeEl.textContent = '';
  }
}

// A part is drawn again only when its content changes. A click that lands while a new
// view comes in still reaches its button, and long notes keep their scroll position.
const drawn = new Map<string, string>();
function changed(part: string, key: unknown): boolean {
  const text = JSON.stringify(key);
  if (drawn.get(part) === text) return false;
  drawn.set(part, text);
  return true;
}

function drawPrimary(v: PresenterView): void {
  if (!changed('primary', v.state)) return;
  const parts: HTMLElement[] = [];
  if (v.state === 'title')
    parts.push(button('Start', 'start', () => command({ type: 'start' }), 'primary big'));
  else if (v.state === 'gate' || v.state === 'manual')
    parts.push(button('Continue', 'continue', () => command({ type: 'continue' }), 'primary big'));
  else if (v.state === 'running')
    parts.push(h('button', { type: 'button', class: 'primary big', disabled: '' }, 'Playing'));
  else if (v.state === 'end') {
    parts.push(
      button('Back to app', 'back-to-app', () => command({ type: 'manual' }), 'big'),
      button('Close presentation', 'close', () => command({ type: 'end' }), 'danger big'),
    );
  }
  primary.replaceChildren(...parts);
}

function drawSteps(v: PresenterView): void {
  const rows = v.steps.map((step) => {
    const i = step.index - 1;
    return {
      step,
      done: i < v.current,
      here: i === v.current && v.state !== 'title' && v.state !== 'end',
      spent: step.spentMs >= 1000 ? clock(step.spentMs) : '',
    };
  });
  const canJump = v.can.includes('jump');
  if (!changed('steps', [rows.map((r) => [r.done, r.here, r.spent]), canJump])) return;
  stepList.replaceChildren(
    ...rows.map(({ step, done, here, spent }) => {
      const item = h(
        'li',
        { class: `${done ? 'done' : ''} ${here ? 'here' : ''}`, 'data-step': String(step.index) },
        h('span', { class: 'mark' }, done ? '✓' : here ? '▶' : String(step.index)),
        h('span', { class: 'label' }, `${step.slide ? '[Slide] ' : ''}${step.title}`),
        h('span', { class: 'spent' }, spent),
      );
      if (canJump) {
        item.classList.add('can-jump');
        onClick(item, () => askJump(step));
      }
      return item;
    }),
  );
}

function chatLine(entry: PresenterChat): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (entry.question) out.push(h('div', { class: 'msg q' }, entry.question));
  if (entry.answer) {
    const answer = h(
      'div',
      { class: 'msg a', 'data-answer': entry.id },
      entry.question ? '' : 'Note: ',
      entry.answer,
    );
    answer.append(
      h(
        'div',
        { class: 'msgbar' },
        entry.onScreen
          ? h('span', { class: 'shown' }, 'On the screen')
          : button(
              'Show on screen',
              `show-${entry.id}`,
              () => send({ type: 'show', id: entry.id }),
              'small',
            ),
      ),
    );
    out.push(answer);
  }
  return out;
}

function drawChat(v: PresenterView): void {
  if (changed('chat', v.chat)) {
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.replaceChildren(...v.chat.flatMap(chatLine));
    if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }
  const thinking = v.chat.some((c) => c.state === 'thinking');
  const waiting = v.chat.some((c) => c.state === 'waiting');
  chatStatus.textContent = thinking
    ? 'Claude is thinking.'
    : waiting
      ? 'Claude is not listening now. Your question waits.'
      : v.listening
        ? 'Claude is listening.'
        : 'Claude is not listening now.';
  chatStatus.className = `chatstatus ${thinking ? 'thinking' : v.listening ? 'ok' : 'off'}`;
}

function draw(v: PresenterView): void {
  view = v;
  viewAt = Date.now();
  document.title = `Presenter: ${v.name}`;
  nameEl.textContent = v.name;
  envEl.textContent = v.environment.label;
  envEl.style.background = v.environment.color;
  urlEl.textContent = v.environment.baseUrl ?? '';
  const step = v.steps[v.current];
  stepNoEl.textContent =
    v.state === 'title'
      ? `${v.steps.length} steps`
      : step
        ? `Step ${step.index} of ${v.steps.length}`
        : 'End';
  chipEl.textContent = STATE_TEXT[v.state] ?? v.state;
  chipEl.className = `chip ${v.state}`;
  stepTitleEl.textContent =
    v.state === 'title'
      ? 'The title shows. Click Start.'
      : v.state === 'end' || !step
        ? 'The end screen shows.'
        : step.title;

  show(failure, v.state === 'failed');
  failureText.textContent = v.failure ? `Step ${v.failure.step}: ${v.failure.message}` : '';
  show(manualNote, v.state === 'manual');

  const noteStep = v.state === 'title' ? v.steps[0] : step;
  if (changed('notes', noteStep?.notes ?? '')) {
    notesEl.replaceChildren(
      ...(noteStep?.notes ? markdown(noteStep.notes) : [h('p', { class: 'muted' }, 'No notes.')]),
    );
    notesEl.scrollTop = 0;
  }
  const next = v.state === 'title' ? v.steps[0] : v.steps[v.current + 1];
  nextEl.textContent =
    v.state === 'end'
      ? ''
      : next
        ? `Next: step ${next.index}, ${next.title}`
        : 'Next: the end screen';

  drawPrimary(v);
  show(backBtn, v.can.includes('back'));
  show(skipBtn, v.state === 'gate');
  show(endBtn, v.state !== 'end' && v.can.includes('end'));
  blankBtn.classList.toggle('on', v.blank);
  blankBtn.textContent = v.blank ? 'Show screen' : 'Blank';
  titleBtn.classList.toggle('on', v.titleShown);
  titleBtn.textContent = v.titleShown ? 'Hide title' : 'Title';
  show(mirror, v.mirror);
  drawSteps(v);
  drawChat(v);

  confirmTitle.textContent = v.confirmNeeded ? `Present on ${v.confirmNeeded.label}?` : '';
  show(confirmBox, Boolean(v.confirmNeeded));
  drawClocks();
}

function receive(msg: ToPresenter): void {
  if (msg.type === 'view') draw(msg.view);
  else if (msg.type === 'frame') mirrorImg.src = msg.src;
  else if (msg.type === 'notice') notice(msg.text);
}

w.__uiwalkPresenter = { receive };
setInterval(drawClocks, 500);
send({ type: 'hello' });
