import type { StepPanel } from './panel-schema.js';
import { type Block, blocksText, parseRichText } from './rich-text.js';

// What the panel shows for one question. The server builds it, and the panel only draws it.

export type AnswerResult = 'pass' | 'bug' | 'skip' | 'stop';
export type SectionKey = 'did' | 'expect' | 'next';

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
  kind: 'step' | 'confirm';
  title: string;
  sections: ViewSection[];
  buttons: ViewButton[];
  // A notes box, for step questions.
  notes: boolean;
  // The border color of a confirm question.
  color?: string;
}

export const DEFAULT_LABELS: Record<SectionKey, string> = {
  did: 'What I did',
  expect: 'What you should see',
  next: "What's next",
};

const BUTTON_ORDER: AnswerResult[] = ['pass', 'bug', 'skip', 'stop'];
const DEFAULT_BUTTON_LABELS: Record<AnswerResult, string> = {
  pass: 'Pass',
  bug: 'Bug',
  skip: 'Skip',
  stop: 'Stop',
};

// Settings from the plan, the step, and the agent. Later layers win.
export type PanelLayer = StepPanel & { next?: { collapsed?: boolean } };

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
  add('did', input.didWhat);
  add('expect', input.expected);
  add('next', input.next, { collapsible: true, collapsed: nextSettings.collapsed });

  // Each layer can change part of one button, so merge button by button.
  const buttonLayers = merged(layers, 'buttons') as Array<
    Partial<Record<AnswerResult, ButtonSetting>>
  >;
  const buttons: ViewButton[] = [];
  for (const result of BUTTON_ORDER) {
    const set: ButtonSetting = Object.assign({}, ...buttonLayers.map((b) => b[result] ?? {}));
    if (set.show === false) continue;
    const button: ViewButton = { result, label: set.label ?? DEFAULT_BUTTON_LABELS[result] };
    if (set.color) {
      button.color = set.color;
      button.textColor = textColorFor(set.color);
    }
    buttons.push(button);
  }
  return { kind: 'step', title: input.title, sections, buttons, notes: true };
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
  };
}

// The question as plain text, for chat when the panel is not available.
export function viewText(view: PanelView): string {
  const lines = [`Step: ${view.title}`];
  for (const section of view.sections) {
    const text = blocksText(section.blocks);
    lines.push(section.label ? `${section.label}:\n${text}` : text);
  }
  lines.push(`Answers: ${view.buttons.map((b) => b.label).join(', ')}`);
  return lines.join('\n');
}
