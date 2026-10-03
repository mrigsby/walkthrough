import { Document, isMap, isPair, isScalar, visit } from 'yaml';
import { slug } from '../text.js';

export interface RecordedTarget {
  role?: string;
  name?: string;
  selector?: string;
}

export interface RecordedStep {
  kind:
    | 'click'
    | 'fill'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'press'
    | 'upload'
    | 'navigate'
    | 'newTab'
    | 'switchTab';
  target?: RecordedTarget;
  // For newTab and switchTab.
  tab?: { name: string; login?: string; url?: string; newest?: boolean };
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

// What the recorder needs to know about a tab.
export type TabLookup = (
  tabId: string,
) => { name: string; login: string; opener?: string } | undefined;

// Collects what the developer does while recording, and writes a plan draft.
export class Recorder {
  readonly steps: RecordedStep[] = [];
  private lastEventAt = 0;
  private readonly secretNames = new Set<string>();
  // The tab of the last step, and the plan name of each tab seen.
  private currentTab?: string;
  private readonly tabNames = new Map<string, string>();
  private popups = 0;
  private newTabs = 0;

  constructor(
    readonly name: string,
    readonly baseUrl?: string,
    private readonly lookup?: TabLookup,
  ) {}

  // The tabs that are open when recording starts, and the active one.
  startTabs(tabIds: string[], activeId?: string): void {
    for (const id of tabIds) this.tabNames.set(id, this.lookup?.(id)?.name ?? id);
    this.currentTab = activeId;
  }

  // Adds a tab step when an event comes from another tab.
  // Returns true when a new tab step already holds this page address.
  private followTab(tabId: string | undefined, url?: string): boolean {
    if (!tabId || !this.lookup || tabId === this.currentTab) return false;
    this.currentTab = tabId;
    const known = this.tabNames.get(tabId);
    if (known) {
      this.steps.push({ kind: 'switchTab', label: known, tab: { name: known } });
      return false;
    }
    const info = this.lookup(tabId);
    if (info?.opener) {
      // The page opened this tab, so a click in the plan opens it again.
      const name = `popup-${++this.popups}`;
      this.tabNames.set(tabId, name);
      this.steps.push({ kind: 'switchTab', label: name, tab: { name, newest: true } });
      return false;
    }
    const name = info && !/^t\d+$/.test(info.name) ? info.name : `tab-${++this.newTabs}`;
    this.tabNames.set(tabId, name);
    const path = url && !url.startsWith('about:') ? this.path(url) : undefined;
    this.steps.push({
      kind: 'newTab',
      label: name,
      tab: { name, login: info && info.login !== 'main' ? info.login : undefined, url: path },
    });
    return Boolean(path);
  }

  private path(url: string): string {
    try {
      const parsed = new URL(url);
      if (this.baseUrl && parsed.origin === new URL(this.baseUrl).origin)
        return parsed.pathname + parsed.search;
    } catch {}
    return url;
  }

  // Adds one event from the page. Typing in the same field again replaces the value.
  add(
    event: {
      kind: RecordedStep['kind'];
      target: RecordedTarget;
      label: string;
      key: string;
      value?: string;
      secret?: boolean;
      fieldName?: string;
      files?: string[];
    },
    tabId?: string,
  ): void {
    this.followTab(tabId);
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
  addNavigation(url: string, tabId?: string): void {
    if (url.startsWith('about:')) return;
    if (tabId && this.lookup && tabId !== this.currentTab) {
      // A tab that a click opened loads by itself. Only the developer's use of it counts.
      if (this.lookup(tabId)?.opener) return;
      this.lastEventAt = Date.now();
      if (this.followTab(tabId, url)) return;
    } else if (Date.now() - this.lastEventAt < 1500) {
      // The page load came from the last click.
      return;
    }
    const path = this.path(url);
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
    // No baseUrl: the paths start at the base URL of whichever environment runs the plan.
    const plan: Record<string, unknown> = { name: this.name };
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
    case 'newTab': {
      const tab = step.tab;
      const login = tab?.login ? ' with its own login' : '';
      return `Open a new tab "${tab?.name ?? step.label}"${login}${tab?.url ? ` at ${tab.url}` : ''}`;
    }
    case 'switchTab':
      return step.tab?.newest
        ? `Switch to the new tab, and name it "${step.label}"`
        : `Switch to the tab "${step.label}"`;
  }
}

function actionOf(step: RecordedStep): Record<string, unknown> {
  if (step.kind === 'navigate') return { navigate: step.value };
  if (step.kind === 'switchTab') {
    const name = step.tab?.name ?? step.label;
    return { switchTab: step.tab?.newest ? { tab: 'newest', name } : name };
  }
  if (step.kind === 'newTab') {
    const tab = step.tab;
    const out: Record<string, unknown> = { name: tab?.name ?? step.label };
    // A one-off login gets a new login again. A named login keeps its name.
    if (tab?.login) out.isolated = tab.login.startsWith('iso-') ? true : tab.login;
    if (tab?.url) out.url = tab.url;
    return { newTab: out };
  }
  const target: Record<string, unknown> = { ...step.target };
  if (step.kind === 'fill')
    target.value = step.secret ? `{{secret:${step.secret}}}` : (step.value ?? '');
  if (step.kind === 'select' || step.kind === 'press') target.value = step.value ?? '';
  if (step.kind === 'upload') target.files = (step.files ?? []).map((f) => `fixtures/${f}`);
  return { [step.kind]: target };
}
