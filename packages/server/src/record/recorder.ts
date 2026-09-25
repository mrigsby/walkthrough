import { Document, isMap, isPair, isScalar, visit } from 'yaml';
import { slug } from '../text.js';

export interface RecordedTarget {
  role?: string;
  name?: string;
  selector?: string;
}

export interface RecordedStep {
  kind: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'upload' | 'navigate';
  target?: RecordedTarget;
  label: string;
  key?: string;
  value?: string;
  secret?: string;
  files?: string[];
  expect?: string;
}

// Makes a secret name like PASSWORD or EMAIL_PASSWORD from a field name.
function secretName(field: string): string {
  const name = field
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  return name.includes('PASSWORD') || name.includes('SECRET') || name.includes('TOKEN')
    ? name
    : `${name || 'FIELD'}_SECRET`;
}

// Collects what the developer does while recording, and writes a plan draft.
export class Recorder {
  readonly steps: RecordedStep[] = [];
  private lastEventAt = 0;
  private readonly secretNames = new Set<string>();

  constructor(
    readonly name: string,
    readonly baseUrl?: string,
  ) {}

  // Adds one event from the page. Typing in the same field again replaces the value.
  add(event: {
    kind: RecordedStep['kind'];
    target: RecordedTarget;
    label: string;
    key: string;
    value?: string;
    secret?: boolean;
    fieldName?: string;
    files?: string[];
  }): void {
    this.lastEventAt = Date.now();
    const last = this.steps.at(-1);
    if (event.kind === 'fill' && last?.kind === 'fill' && last.key === event.key) this.steps.pop();
    const step: RecordedStep = {
      kind: event.kind,
      target: event.target,
      label: event.label,
      key: event.key,
    };
    if (event.secret) {
      step.secret = secretName(event.fieldName ?? 'password');
      this.secretNames.add(step.secret);
    } else if (event.value !== undefined) {
      step.value = event.value;
    }
    if (event.files) step.files = event.files;
    this.steps.push(step);
  }

  // A page load that no click caused, like an address the developer typed.
  addNavigation(url: string): void {
    if (Date.now() - this.lastEventAt < 1500) return;
    let path = url;
    try {
      const parsed = new URL(url);
      if (this.baseUrl && parsed.origin === new URL(this.baseUrl).origin)
        path = parsed.pathname + parsed.search;
    } catch {}
    const last = this.steps.at(-1);
    if (last?.kind === 'navigate' && last.value === path) return;
    this.lastEventAt = Date.now();
    this.steps.push({ kind: 'navigate', label: path, value: path });
  }

  addExpectation(text: string): boolean {
    const last = this.steps.at(-1);
    if (!last) return false;
    last.expect = last.expect ? `${last.expect} ${text}` : text;
    return true;
  }

  // Turns the last typed value into a secret. The value is thrown away.
  markLastSecret(): string | undefined {
    const last = [...this.steps].reverse().find((s) => s.kind === 'fill');
    if (!last) return undefined;
    if (!last.secret) {
      last.secret = secretName(last.label.replace(/"/g, ''));
      delete last.value;
      this.secretNames.add(last.secret);
    }
    return last.secret;
  }

  get lastLabel(): string {
    const last = this.steps.at(-1);
    return last ? describe(last) : '';
  }

  get secrets(): string[] {
    return [...this.secretNames];
  }

  // The plan draft in YAML.
  toYaml(): string {
    const ids = new Set<string>();
    const steps = this.steps.map((step) => {
      let id = slug(describe(step), 40, 'step');
      for (let n = 2; ids.has(id); n++) id = `${slug(describe(step), 40, 'step')}-${n}`;
      ids.add(id);
      const out: Record<string, unknown> = { id, do: describe(step) };
      out.action = actionOf(step);
      if (step.expect) out.expect = step.expect;
      return out;
    });
    const plan: Record<string, unknown> = { name: this.name };
    if (this.baseUrl) plan.baseUrl = this.baseUrl;
    plan.mode = 'checkpoints';
    plan.steps = steps.length ? steps : [{ do: 'Nothing was recorded' }];
    const doc = new Document(plan);
    // Actions read better on one line, like { click: { role: button, name: Save } }.
    visit(doc, {
      Pair(_key, pair) {
        if (
          isPair(pair) &&
          isScalar(pair.key) &&
          pair.key.value === 'action' &&
          isMap(pair.value)
        ) {
          visit(pair.value, {
            Map(_k, map) {
              map.flow = true;
            },
          });
          pair.value.flow = true;
        }
      },
    });
    const body = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
    return `# yaml-language-server: $schema=../plan.schema.json\n${body}`;
  }
}

// Plain words for a step, like: Click "Add to cart".
export function describe(step: RecordedStep): string {
  switch (step.kind) {
    case 'click':
      return `Click ${step.label}`;
    case 'fill':
      return step.secret
        ? `Type the ${step.secret} secret in ${step.label}`
        : `Type "${step.value ?? ''}" in ${step.label}`;
    case 'select':
      return `Choose "${step.value ?? ''}" in ${step.label}`;
    case 'check':
      return `Check ${step.label}`;
    case 'uncheck':
      return `Uncheck ${step.label}`;
    case 'press':
      return `Press ${step.value ?? 'Enter'} in ${step.label}`;
    case 'upload':
      return `Upload ${(step.files ?? []).join(', ') || 'a file'} to ${step.label}`;
    case 'navigate':
      return `Go to ${step.value}`;
  }
}

function actionOf(step: RecordedStep): Record<string, unknown> {
  if (step.kind === 'navigate') return { navigate: step.value };
  const target: Record<string, unknown> = { ...step.target };
  if (step.kind === 'fill')
    target.value = step.secret ? `{{secret:${step.secret}}}` : (step.value ?? '');
  if (step.kind === 'select' || step.kind === 'press') target.value = step.value ?? '';
  if (step.kind === 'upload') target.files = (step.files ?? []).map((f) => `fixtures/${f}`);
  return { [step.kind]: target };
}
