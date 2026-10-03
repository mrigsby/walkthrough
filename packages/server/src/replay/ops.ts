import type { CookieCheck } from '../devtools/cookie-schema.js';
import { ELEMENT_ACTIONS } from '../page/actions.js';
import type { Run, RunCapture, RunStep } from '../run/run-store.js';

export type RunAction = RunStep['actions'][number];

// One thing that a replay or an exported script does. Both use the same list, so they
// always repeat a run the same way.
export type Op =
  // Go to the address, unless the page is there already.
  | { type: 'reach'; url: string }
  | { type: 'action'; action: RunAction }
  // An action on an element that has no stable selector.
  | { type: 'no-selector'; label: string }
  | { type: 'cookie'; check: CookieCheck }
  | { type: 'expect'; text: string }
  | { type: 'check-by-hand'; text: string }
  | { type: 'capture'; shot: RunCapture }
  | { type: 'capture-no-selector'; shot: RunCapture };

export interface StepOps {
  step: RunStep;
  ops: Op[];
}

export interface RunOps {
  steps: StepOps[];
  // Actions and screenshots without a stable selector, like 'Step 2: button "Save"'.
  missingSelectors: string[];
}

// Text in an expectation that can be checked: quoted text and money amounts.
export function checkableText(expect: string): string[] {
  const found = new Set<string>();
  for (const m of expect.matchAll(/"([^"]{1,80})"/g)) if (m[1]) found.add(m[1]);
  for (const m of expect.matchAll(/(?:\$|€|£)\d[\d,]*(?:\.\d+)?/g)) found.add(m[0]);
  return [...found];
}

// The address in a new-tab record.
function parseUrl(value?: string): string | undefined {
  try {
    const url = (JSON.parse(value ?? '{}') as { url?: unknown }).url;
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
}

// The steps of a run that did something, as operations. Steps that did not run and
// saved no screenshot are left out.
export function buildOps(run: Run): RunOps {
  const steps: StepOps[] = [];
  const missingSelectors: string[] = [];
  let lastUrl = run.baseUrl ?? '';
  for (const step of run.steps) {
    const shots = step.captures ?? [];
    if ((step.status === 'pending' || step.status === 'skip') && shots.length === 0) continue;
    const ops: Op[] = [];
    for (const action of step.actions) {
      if (action.url && action.url !== lastUrl) {
        ops.push({ type: 'reach', url: action.url });
        lastUrl = action.url;
      }
      if (!action.selector && ELEMENT_ACTIONS.includes(action.action)) {
        missingSelectors.push(`Step ${step.index}: ${action.label}`);
        ops.push({ type: 'no-selector', label: action.label });
        continue;
      }
      ops.push({ type: 'action', action });
      // After a page load, the next action starts at the new address.
      if (action.action === 'navigate') lastUrl = action.value ?? lastUrl;
      if (action.action === 'tab-new') lastUrl = parseUrl(action.value) ?? 'about:blank';
      if (action.action === 'tab-close') lastUrl = '';
    }
    for (const check of step.cookies ?? []) ops.push({ type: 'cookie', check });
    // The token form, so a replay or export elsewhere checks its own values.
    const expect = step.template?.expect ?? step.expect;
    if (expect) {
      const texts = checkableText(expect);
      for (const text of texts) ops.push({ type: 'expect', text });
      if (texts.length === 0) ops.push({ type: 'check-by-hand', text: expect });
    }
    for (const shot of shots) {
      if (shot.element && !shot.selector) {
        missingSelectors.push(`Step ${step.index}: screenshot of ${shot.element}`);
        ops.push({ type: 'capture-no-selector', shot });
        continue;
      }
      ops.push({ type: 'capture', shot });
    }
    steps.push({ step, ops });
  }
  return { steps, missingSelectors };
}

export interface DialogAnswer {
  accept: boolean;
  text?: string;
}

// The dialog answers of a step, in order, from one operation on. A retry from the middle
// of a step leaves out the dialogs before it.
export function dialogAnswers(ops: Op[], from = 0): DialogAnswer[] {
  const answers: DialogAnswer[] = [];
  for (const op of ops.slice(from)) {
    if (op.type !== 'action' || op.action.action !== 'dialog') continue;
    let detail: { accept?: unknown; text?: unknown } = {};
    try {
      detail = JSON.parse(op.action.value ?? '{}') as typeof detail;
    } catch {}
    answers.push({
      accept: detail.accept !== false,
      ...(typeof detail.text === 'string' ? { text: detail.text } : {}),
    });
  }
  return answers;
}

// The operations of each step, by the step id from the plan.
export function opsByStep(ops: RunOps): Map<string, StepOps> {
  return new Map(ops.steps.map((s) => [s.step.id, s]));
}
