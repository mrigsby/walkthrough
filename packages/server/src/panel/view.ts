import type { StepPanel } from './panel-schema.js';
import { type Block, blocksText, copyRefs, parseRichText } from './rich-text.js';

// What the panel shows for one question. The server builds it, and the panel only draws it.

export type AnswerResult = 'pass' | 'bug' | 'skip' | 'retry' | 'stop';
export type SectionKey = 'did' | 'command' | 'expect' | 'next' | 'content';

export interface ViewSection {
  key: SectionKey;
  label: string;
  blocks: Block[];
  // "What's next" opens and closes.
  collapsible?: boolean;
  collapsed?: boolean;
}

export interface ViewButton {
  result: AnswerResult;
  label: string;
  // Only when the plan sets a color. Otherwise the panel uses its own colors.
  color?: string;
  textColor?: string;
}

export interface PanelView {
  kind: 'step' | 'confirm' | 'card';
  title: string;
  // A card: smaller text under the title, and where the card shows.
  subheading?: string;
  size?: 'panel' | 'modal';
  sections: ViewSection[];
  buttons: ViewButton[];
  // A notes box, for step questions.
  notes: boolean;
  // The border color of a confirm question.
  color?: string;
  // Snippets that the text uses with {{copy:name}}.
  snippets: Record<string, ViewSnippet>;
  // Alt+Shift keys answer the question.
  shortcuts?: boolean;
  // A Point button, so the developer can show the element of a bug.
  point?: boolean;
  // A reference image goes under "What you should see". Its bytes come in a message of their own.
  image?: boolean;
}

export interface ViewSnippet {
  code: string;
  help?: Block[];
}

// A snippet after {{var:NAME}} and secrets are handled.
export interface SnippetText {
  code: string;
  help?: string;
}

export const DEFAULT_LABELS: Record<SectionKey, string> = {
  did: 'What I did',
  command: 'Run this command',
  expect: 'What you should see',
  next: "What's next",
  content: '',
};

const BUTTON_ORDER: AnswerResult[] = ['pass', 'bug', 'skip', 'retry', 'stop'];
const DEFAULT_BUTTON_LABELS: Record<AnswerResult, string> = {
  pass: 'Pass',
  bug: 'Bug',
  skip: 'Skip',
  retry: 'Retry',
  stop: 'Stop',
};

// Settings from the plan, the step, and the agent. Later layers win.
export type PanelLayer = StepPanel & { next?: { collapsed?: boolean }; shortcuts?: boolean };

interface ButtonSetting {
  label?: string;
  color?: string;
  show?: boolean;
}

function channel(hex: string, i: number): number {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  const v = Number.parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// White or dark text, whichever has more contrast on this color.
export function textColorFor(hex: string): string {
  const lum = 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const onWhite = 1.05 / (lum + 0.05);
  // #0f172a has a luminance of about 0.009.
  const onDark = (lum + 0.05) / (0.009 + 0.05);
  return onWhite >= onDark ? '#ffffff' : '#0f172a';
}

function merged<K extends keyof PanelLayer>(layers: Array<PanelLayer | undefined>, key: K) {
  return layers.map((l) => l?.[key]).filter((v) => v !== undefined) as Array<
    NonNullable<PanelLayer[K]>
  >;
}

export interface StepViewInput {
  title: string;
  didWhat?: string;
  expected?: string;
  next?: string;
  layers?: Array<PanelLayer | undefined>;
  // All snippets that the plan, the step, and the agent give. Later ones win.
  snippets?: Record<string, SnippetText>;
  image?: boolean;
  // A card instead of a step question.
  card?: { subheading?: string; content?: string; size?: 'panel' | 'modal' };
  // A terminal command for the step, with a Copy button.
  command?: { run: string; help?: string };
}

// Buttons that a card shows only when the plan says show: true.
const CARD_HIDDEN: AnswerResult[] = ['bug', 'skip', 'retry'];

// The snippets that the sections use, and the ones that their help texts use.
function usedSnippets(
  texts: Array<string | undefined>,
  all: Record<string, SnippetText>,
): Record<string, ViewSnippet> {
  const names = new Set(texts.flatMap((t) => copyRefs(t ?? '')));
  for (const name of [...names]) for (const ref of copyRefs(all[name]?.help ?? '')) names.add(ref);
  const out: Record<string, ViewSnippet> = {};
  for (const name of names) {
    const snippet = all[name];
    if (!snippet) continue;
    out[name] = {
      code: snippet.code,
      ...(snippet.help ? { help: parseRichText(snippet.help) } : {}),
    };
  }
  return out;
}

export function buildStepView(input: StepViewInput): PanelView {
  const layers = input.layers ?? [];
  const labels = Object.assign({}, DEFAULT_LABELS, ...merged(layers, 'labels')) as Record<
    SectionKey,
    string
  >;
  const nextSettings = Object.assign({ collapsed: true }, ...merged(layers, 'next')) as {
    collapsed: boolean;
  };
  const sections: ViewSection[] = [];
  const add = (key: SectionKey, text: string | undefined, extra: Partial<ViewSection> = {}) => {
    if (!text?.trim()) return;
    sections.push({ key, label: labels[key] ?? '', blocks: parseRichText(text), ...extra });
  };
  const card = input.card;
  if (card) {
    add('content', card.content);
  } else {
    add('did', input.didWhat);
    if (input.command) {
      const help = input.command.help ? parseRichText(input.command.help) : undefined;
      sections.push({
        key: 'command',
        label: labels.command ?? '',
        blocks: [{ t: 'code', v: input.command.run, ...(help ? { help } : {}) }],
      });
    }
    add('expect', input.expected);
  }
  add('next', input.next, { collapsible: true, collapsed: nextSettings.collapsed });

  // Each layer can change part of one button, so merge button by button.
  const buttonLayers = merged(layers, 'buttons') as Array<
    Partial<Record<AnswerResult, ButtonSetting>>
  >;
  const buttons: ViewButton[] = [];
  for (const result of BUTTON_ORDER) {
    const set: ButtonSetting = Object.assign({}, ...buttonLayers.map((b) => b[result] ?? {}));
    if (set.show === false || (card && CARD_HIDDEN.includes(result) && set.show !== true)) continue;
    const button: ViewButton = { result, label: set.label ?? DEFAULT_BUTTON_LABELS[result] };
    if (set.color) {
      button.color = set.color;
      button.textColor = textColorFor(set.color);
    }
    buttons.push(button);
  }
  return {
    kind: card ? 'card' : 'step',
    title: input.title,
    ...(card?.subheading ? { subheading: card.subheading } : {}),
    ...(card ? { size: card.size ?? 'panel' } : {}),
    sections,
    buttons,
    // Bug needs notes. A card has no notes box unless it shows Bug.
    notes: !card || buttons.some((b) => b.result === 'bug'),
    shortcuts: merged(layers, 'shortcuts').at(-1) ?? true,
    point: !card && buttons.some((b) => b.result === 'bug'),
    snippets: usedSnippets(
      card ? [card.content, input.next] : [input.didWhat, input.expected, input.next],
      input.snippets ?? {},
    ),
    ...(input.image ? { image: true } : {}),
  };
}

export interface ChecklistItem {
  // Section key, block number, and item number, like "expect:1:0".
  id: string;
  text: string;
  checked: boolean;
}

// The check list items of a view, with the ticks that the developer changed.
export function viewChecklist(view: PanelView, ui: Record<string, boolean> = {}): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const section of view.sections) {
    section.blocks.forEach((block, b) => {
      if (block.t !== 'check') return;
      block.items.forEach((item, i) => {
        const id = `${section.key}:${b}:${i}`;
        items.push({
          id,
          text: blocksText([{ t: 'p', lines: [item.text] }], view.snippets),
          checked: ui[`check:${id}`] ?? item.checked,
        });
      });
    });
  }
  return items;
}

export function buildConfirmView(input: {
  title: string;
  message: string;
  confirmLabel?: string;
  color?: string;
}): PanelView {
  return {
    kind: 'confirm',
    title: input.title,
    sections: [{ key: 'did', label: '', blocks: parseRichText(input.message) }],
    buttons: [
      { result: 'pass', label: input.confirmLabel ?? 'Continue' },
      { result: 'stop', label: 'Cancel' },
    ],
    notes: false,
    color: input.color,
    snippets: {},
  };
}

// The question as plain text, for chat when the panel is not available.
export function viewText(view: PanelView): string {
  const lines = [view.kind === 'card' ? `Card: ${view.title}` : `Step: ${view.title}`];
  if (view.subheading) lines.push(view.subheading);
  for (const section of view.sections) {
    const text = blocksText(section.blocks, view.snippets);
    lines.push(section.label ? `${section.label}:\n${text}` : text);
  }
  lines.push(`Answers: ${view.buttons.map((b) => b.label).join(', ')}`);
  return lines.join('\n');
}
