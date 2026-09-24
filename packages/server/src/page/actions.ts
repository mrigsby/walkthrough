import type { ElementHandle, KeyInput } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { dialogOpenMessage } from '../browser/driver.js';
import type { Config } from '../config.js';
import { ToolError } from '../errors.js';
import { elementRect } from '../evidence/annotate.js';
import type { OriginGuard } from '../guards/origins.js';
import { checkUploadPath } from '../guards/paths.js';
import { MASK, type SecretStore } from '../guards/secrets.js';
import { stableSelector } from './selectors.js';

export const ACTIONS = [
  'click',
  'dblclick',
  'hover',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'upload',
] as const;
export type Action = (typeof ACTIONS)[number];

const ACTION_LABELS: Record<Action, string> = {
  click: 'Click',
  dblclick: 'Double-click',
  hover: 'Point',
  fill: 'Type',
  select: 'Choose',
  check: 'Check',
  uncheck: 'Uncheck',
  press: 'Press a key',
  scroll: 'Scroll',
  upload: 'Upload',
};

export interface ActInput {
  action: Action;
  ref?: string;
  selector?: string;
  value?: string;
  files?: string[];
}

export interface Target {
  handle: ElementHandle<Element>;
  label: string;
  role?: string;
  name?: string;
}

// A record of each action, for reports and script export later.
export interface ActionRecord {
  at: string;
  tabId: string;
  action: Action;
  selector?: string;
  label: string;
  value?: string;
  url: string;
}

export interface ActContext {
  driver: Driver;
  config: Config;
  guard: OriginGuard;
  secrets: SecretStore;
  log: ActionRecord[];
}

// Finds the element from a ref (preferred) or a selector.
export async function resolveTarget(
  driver: Driver,
  tab: Tab,
  input: { ref?: string; selector?: string },
): Promise<Target | undefined> {
  if (input.ref) {
    const { handle, role, name } = await driver.refs.resolve(input.ref, tab.id, tab.nav);
    return { handle, role, name, label: `${role}${name ? ` "${name}"` : ''} [${input.ref}]` };
  }
  if (input.selector) {
    const handle = (await tab.page.$(input.selector).catch((error: Error) => {
      throw new ToolError(
        `The selector "${input.selector}" is not valid: ${error.message}`,
        'bad_selector',
      );
    })) as ElementHandle<Element> | null;
    if (!handle) {
      throw new ToolError(
        `Nothing on the page matches the selector "${input.selector}". Take a snapshot and use a ref.`,
        'not_found',
      );
    }
    return { handle, label: `element "${input.selector}"` };
  }
  return undefined;
}

// Presses a key or a combination like "Control+A".
async function pressKeys(tab: Tab, combo: string): Promise<void> {
  const keys = combo.split('+').map((k) => k.trim()) as KeyInput[];
  const main = keys.pop();
  if (!main)
    throw new ToolError('Give a key to press, such as "Enter" or "Control+A".', 'bad_input');
  for (const key of keys) await tab.page.keyboard.down(key);
  try {
    await tab.page.keyboard.press(main);
  } finally {
    for (const key of keys.reverse()) await tab.page.keyboard.up(key);
  }
}

async function selectOption(handle: ElementHandle<Element>, wanted: string): Promise<string> {
  // Match the option by its value or by the text the user sees.
  const value = await handle.evaluate((el, text) => {
    if (!(el instanceof HTMLSelectElement)) return null;
    const option = [...el.options].find(
      (o) => o.value === text || o.label.trim() === text || o.text.trim() === text,
    );
    return option ? option.value : undefined;
  }, wanted);
  if (value === null)
    throw new ToolError('The select action only works on a <select> element.', 'bad_target');
  if (value === undefined) throw new ToolError(`The list has no option "${wanted}".`, 'not_found');
  await handle.select(value);
  return value;
}

// Runs one action. Throws ToolError with a clear message when it cannot.
async function perform(
  ctx: ActContext,
  tab: Tab,
  input: ActInput,
  target: Target | undefined,
): Promise<string> {
  const { action } = input;
  const timeout = ctx.config.actionTimeoutMs;
  const need = (): Target => {
    if (!target)
      throw new ToolError(`The ${action} action needs a "ref" or a "selector".`, 'bad_input');
    return target;
  };

  switch (action) {
    case 'click':
    case 'dblclick': {
      const t = need();
      await t.handle
        .asLocator()
        .setTimeout(timeout)
        .click({ count: action === 'dblclick' ? 2 : 1 });
      return `${action === 'click' ? 'Clicked' : 'Double-clicked'} ${t.label}.`;
    }
    case 'hover': {
      const t = need();
      await t.handle.asLocator().setTimeout(timeout).hover();
      return `Moved the mouse over ${t.label}.`;
    }
    case 'fill': {
      const t = need();
      if (input.value === undefined)
        throw new ToolError('The fill action needs a "value".', 'bad_input');
      const hasSecret = ctx.secrets.hasTokens(input.value);
      const real = ctx.secrets.resolve(input.value);
      await t.handle.asLocator().setTimeout(timeout).fill(real);
      if (hasSecret) ctx.driver.secretFields.push(t.handle);
      return `Filled ${t.label} with "${hasSecret ? MASK : input.value}".`;
    }
    case 'select': {
      const t = need();
      if (!input.value)
        throw new ToolError(
          'The select action needs a "value" (the option value or text).',
          'bad_input',
        );
      const chosen = await selectOption(t.handle, input.value);
      return `Selected "${input.value}" in ${t.label}${chosen !== input.value ? ` (value "${chosen}")` : ''}.`;
    }
    case 'check':
    case 'uncheck': {
      const t = need();
      const want = action === 'check';
      const now = await t.handle.evaluate((el) => (el as HTMLInputElement).checked);
      if (now !== want) await t.handle.asLocator().setTimeout(timeout).click();
      const after = await t.handle.evaluate((el) => (el as HTMLInputElement).checked);
      if (after !== want)
        throw new ToolError(
          `${t.label} did not change to ${want ? 'checked' : 'not checked'}.`,
          'no_effect',
        );
      return `${want ? 'Checked' : 'Unchecked'} ${t.label}${now === want ? ' (it was already in that state)' : ''}.`;
    }
    case 'press': {
      if (!input.value)
        throw new ToolError(
          'The press action needs a "value", such as "Enter" or "Control+A".',
          'bad_input',
        );
      if (target) await target.handle.focus();
      await pressKeys(tab, input.value);
      return `Pressed ${input.value}${target ? ` in ${target.label}` : ''}.`;
    }
    case 'scroll': {
      if (target) {
        await target.handle.scrollIntoView();
        return `Scrolled ${target.label} into view.`;
      }
      const amount =
        input.value === 'up'
          ? -600
          : input.value === 'down' || !input.value
            ? 600
            : Number(input.value);
      if (Number.isNaN(amount))
        throw new ToolError(
          'For scroll, "value" is "up", "down", or a number of pixels.',
          'bad_input',
        );
      await tab.page.mouse.wheel({ deltaY: amount });
      return `Scrolled the page ${amount < 0 ? 'up' : 'down'} by ${Math.abs(amount)} pixels.`;
    }
    case 'upload': {
      const t = need();
      const files = input.files ?? (input.value ? input.value.split(',').map((f) => f.trim()) : []);
      if (files.length === 0) throw new ToolError('The upload action needs "files".', 'bad_input');
      const paths = files.map((f) =>
        checkUploadPath(f, ctx.config.uploadsRoot, ctx.config.projectDir),
      );
      const isFileInput = await t.handle.evaluate(
        (el) => el instanceof HTMLInputElement && el.type === 'file',
      );
      if (isFileInput) {
        await (t.handle as ElementHandle<HTMLInputElement>).uploadFile(...paths);
      } else {
        // A button that opens the file picker.
        const [chooser] = await Promise.all([
          tab.page.waitForFileChooser({ timeout }),
          t.handle.asLocator().setTimeout(timeout).click(),
        ]);
        await chooser.accept(paths);
      }
      return `Uploaded ${files.join(', ')} to ${t.label}.`;
    }
  }
}

// Shows a pulsing box on the element, so the developer can see what comes next.
async function highlightTarget(
  ctx: ActContext,
  tab: Tab,
  target: Target,
  action: Action,
): Promise<void> {
  const ms = ctx.config.highlightMs;
  const panel = ctx.driver.panel;
  if (!panel || ms <= 0) return;
  await target.handle.scrollIntoView().catch(() => undefined);
  const rect = await elementRect(target.handle);
  if (!rect) return;
  await panel.highlight(tab.id, rect, `Next: ${ACTION_LABELS[action]}`, ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits a moment for the page to react, without failing if it stays busy.
async function settle(tab: Tab): Promise<void> {
  await tab.page.waitForNetworkIdle({ idleTime: 250, timeout: 2000 }).catch(() => undefined);
}

export async function act(ctx: ActContext, input: ActInput): Promise<string> {
  const tab = ctx.driver.activeTab();
  const startUrl = tab.page.url();
  if (!ctx.guard.isAllowed(startUrl)) {
    throw new ToolError(
      `${ctx.guard.blockedMessage(startUrl)}\nNavigate back to an allowed page first.`,
      'origin_blocked',
    );
  }

  const target = await resolveTarget(ctx.driver, tab, input);
  if (target && (await target.handle.evaluate((el) => Boolean(el.closest('uiwalk-panel'))))) {
    throw new ToolError(
      'That element is part of the Walkthrough panel. Only the developer uses the panel.',
      'bad_target',
    );
  }
  const selector = target ? await stableSelector(target.handle, target) : undefined;
  if (target) {
    ctx.driver.lastTarget = { tabId: tab.id, handle: target.handle, label: target.label };
    await highlightTarget(ctx, tab, target, input.action);
  }

  // Watch for a dialog that the action opens. It would block the action.
  const dialogWatch = ctx.driver.nextDialog(tab.id);
  const work = perform(ctx, tab, input, target);
  let outcome: { kind: 'done'; text: string } | { kind: 'dialog' };
  try {
    outcome = await Promise.race([
      work.then((text) => ({ kind: 'done' as const, text })),
      dialogWatch.promise.then(() => ({ kind: 'dialog' as const })),
    ]);
  } finally {
    dialogWatch.cancel();
  }

  ctx.log.push({
    at: new Date().toISOString(),
    tabId: tab.id,
    action: input.action,
    selector,
    label: target?.label ?? '(page)',
    // Secrets stay as {{secret:NAME}} here. The real value is never stored.
    value: ['fill', 'select', 'press'].includes(input.action) ? input.value : undefined,
    url: startUrl,
  });

  const lines: string[] = [];
  if (outcome.kind === 'dialog') {
    ctx.driver.setPendingWork(tab.id, work);
    const dialog = ctx.driver.pendingDialog(tab.id);
    lines.push(`Did the ${input.action} action. It opened a dialog, so the page is waiting.`);
    if (dialog) lines.push(`dialog_pending: ${dialogOpenMessage(dialog)}`);
  } else {
    await settle(tab);
    // Clicks and keys can open tabs or leave the page. Wait for those reports.
    if (['click', 'dblclick', 'press'].includes(input.action)) await ctx.driver.settleEvents();
    lines.push(outcome.text);
    const endUrl = tab.page.url();
    if (endUrl !== startUrl) lines.push(`The page is now ${endUrl}.`);
  }
  if (selector) lines.push(`Selector: ${selector}`);
  return lines.join('\n');
}
