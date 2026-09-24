import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Emulation } from '../browser/devices.js';
import type { Tab } from '../browser/driver.js';
import { loadSession, restoreSession } from '../browser/sessions.js';
import type { Context } from '../context.js';
import { doctorReport } from '../doctor.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { runTool } from './util.js';

async function pageSummary(tab: Tab): Promise<string> {
  const title = await tab.page.title().catch(() => '');
  return untrusted(`Tab: ${tab.id}\nTitle: ${title || '(no title)'}\nURL: ${tab.page.url()}`);
}

// Makes a full URL from a path like "/cart", using the current page or the base URL.
function fullUrl(input: string, current: string, baseUrl?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  const base = /^https?:/.test(current) ? current : baseUrl;
  if (!base) {
    throw new ToolError(
      `"${input}" is not a full URL, and there is no page or baseUrl to start from. Use a full URL like http://localhost:3000${input.startsWith('/') ? input : `/${input}`}.`,
      'bad_input',
    );
  }
  return new URL(input, base).href;
}

// Many apps draw the page after "load". Wait a moment for their requests to finish.
async function settle(tab: Tab): Promise<void> {
  await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => undefined);
}

async function goTo(tab: Tab, url: string): Promise<string | undefined> {
  try {
    const response = await tab.page.goto(url, { waitUntil: 'load' });
    await settle(tab);
    const status = response?.status();
    return status && status >= 400 ? `The server answered with HTTP ${status}.` : undefined;
  } catch (error) {
    const message = (error as Error).message;
    if (/timeout/i.test(message))
      return 'The page took more than 30 seconds to finish loading. It may still be usable.';
    if (/ERR_CONNECTION_REFUSED/.test(message)) {
      throw new ToolError(
        `Nothing is running at ${url}. Ask the developer to start the app.`,
        'connection_refused',
      );
    }
    throw new ToolError(`Could not open ${url}: ${message}`, 'navigation_failed');
  }
}

// Opens the browser if needed, then goes to the url (or the baseUrl for a new browser).
export async function openBrowser(
  ctx: Context,
  options: {
    url?: string;
    attach?: string;
    alwaysGo?: boolean;
    session?: string;
    emulation?: Emulation;
  },
): Promise<{ text: string; tab: Tab }> {
  const config = await ctx.config();
  const guard = await ctx.guard();
  const lines: string[] = [];

  let driver = ctx.driver?.alive ? ctx.driver : undefined;
  const alreadyOpen = Boolean(driver);
  if (driver) {
    lines.push('The browser is already open.');
  } else {
    driver = await ctx.startDriver(options.attach);
    lines.push(
      driver.mode === 'attached'
        ? `Connected to your Chrome (${driver.chromeVersion}) and opened a new tab for testing.`
        : `Opened Chrome (${driver.chromeVersion}) with a fresh profile.`,
    );
  }
  for (const warning of config.warnings) lines.push(`Warning: ${warning}`);

  const tab = driver.activeTab();
  if (options.emulation && Object.keys(options.emulation).length > 0) {
    // No reload here. The page loads next anyway.
    await driver.setEmulation(options.emulation, { reload: false });
  }
  if (options.session) {
    await restoreSession(driver, tab, loadSession(config.projectDir, options.session));
    lines.push(`Loaded the saved login "${options.session}".`);
  }
  // A new browser starts at the baseUrl. An open one stays where it is.
  // After a saved login, go to the page again, so the login takes effect.
  const goAgain = Boolean(options.session) || !alreadyOpen || options.alwaysGo;
  const target =
    options.url ??
    (goAgain ? (config.baseUrl ?? (options.session ? tab.page.url() : undefined)) : undefined);
  if (target) {
    const full = fullUrl(target, tab.page.url(), config.baseUrl);
    guard.check(full);
    const problem = await goTo(tab, full);
    if (problem) lines.push(problem);
  }
  lines.push(await pageSummary(tab));
  lines.push('Next, take a snapshot to see the page.');
  return { text: lines.join('\n'), tab };
}

export function registerBrowserTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'doctor',
    {
      title: 'Check setup',
      description:
        'Check that Walkthrough can run: Node version, Chrome, project folder, settings, and secrets. Use it first when something does not work.',
      inputSchema: {
        projectDir: z
          .string()
          .optional()
          .describe('Project folder to check. Leave empty to find it automatically.'),
      },
    },
    ({ projectDir }) =>
      runTool(ctx, 'doctor', async () => {
        const config = await ctx.refresh(projectDir);
        return doctorReport(config, await ctx.secrets(), ctx.driver);
      }),
  );

  server.registerTool(
    'browser_open',
    {
      title: 'Open browser',
      description:
        'Open a visible Chrome window for testing, or connect to a Chrome that is already running. Opens the url, or the baseUrl from .walkthrough/config.yaml. If the browser is already open, it goes to the url.',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe('Page to open. A full URL, or a path like "/login" when baseUrl is set.'),
        attach: z
          .string()
          .optional()
          .describe(
            'Connect to a running Chrome instead of starting one. Example: "http://127.0.0.1:9222".',
          ),
        session: z.string().optional().describe('A saved login to use, from the session tool.'),
        projectDir: z
          .string()
          .optional()
          .describe('Project folder. Leave empty to find it automatically.'),
      },
    },
    ({ url, attach, session, projectDir }) =>
      runTool(ctx, 'browser_open', async () => {
        await ctx.refresh(projectDir);
        return (await openBrowser(ctx, { url, attach, session })).text;
      }),
  );

  server.registerTool(
    'browser_close',
    {
      title: 'Close browser',
      description:
        'Close the test browser. If Walkthrough connected to your own Chrome, it disconnects and leaves Chrome open.',
      inputSchema: {},
    },
    () =>
      runTool(ctx, 'browser_close', async () => {
        const driver = ctx.driver;
        if (!driver?.alive) return 'No browser is open.';
        await driver.close();
        return driver.mode === 'attached'
          ? 'Disconnected from Chrome. Chrome is still open.'
          : 'Closed the browser.';
      }),
  );

  server.registerTool(
    'navigate',
    {
      title: 'Navigate',
      description:
        'Go to a URL in the active tab, or go back, forward, or reload. Walkthrough opens only the sites in the allowed list.',
      inputSchema: {
        url: z.string().optional().describe('A full URL, or a path like "/cart".'),
        action: z.enum(['back', 'forward', 'reload']).optional().describe('Use instead of url.'),
      },
    },
    ({ url, action }) =>
      runTool(ctx, 'navigate', async () => {
        const driver = ctx.requireDriver();
        const config = await ctx.config();
        const guard = await ctx.guard();
        // A reload is the way out of a crashed page.
        const tab = action === 'reload' ? reloadableTab(driver) : driver.activeTab();
        let problem: string | undefined;
        if (url) {
          const full = fullUrl(url, tab.page.url(), config.baseUrl);
          guard.check(full);
          const from = tab.page.url();
          problem = await goTo(tab, full);
          // Keep it with the actions, for reports and script export.
          ctx.actionLog.push({
            at: new Date().toISOString(),
            tabId: tab.id,
            action: 'navigate',
            label: full,
            value: full,
            url: from,
          });
        } else if (action === 'back') {
          await tab.page.goBack({ waitUntil: 'load' });
        } else if (action === 'forward') {
          await tab.page.goForward({ waitUntil: 'load' });
        } else if (action === 'reload') {
          await tab.page.reload({ waitUntil: 'load' });
          tab.crashed = false;
        } else {
          throw new ToolError('Give a url or an action (back, forward, reload).', 'bad_input');
        }
        if (!url) await settle(tab);
        return [problem, await pageSummary(tab), 'Take a snapshot to see the page.']
          .filter(Boolean)
          .join('\n');
      }),
  );

  server.registerTool(
    'tabs',
    {
      title: 'Tabs',
      description:
        'List the open tabs, switch the active tab, or close a tab. Tools act on the active tab.',
      inputSchema: {
        action: z.enum(['list', 'switch', 'close']).default('list'),
        id: z.string().optional().describe('Tab id, like "t2". Needed for switch and close.'),
      },
    },
    ({ action, id }) =>
      runTool(ctx, 'tabs', async () => {
        const driver = ctx.requireDriver();
        if (action === 'switch') {
          if (!id) throw new ToolError('Give the id of the tab to switch to.', 'bad_input');
          const tab = driver.switchTo(id);
          return `Switched to tab ${tab.id}.\n${await pageSummary(tab)}\nTake a snapshot to see the page.`;
        }
        if (action === 'close') {
          if (!id) throw new ToolError('Give the id of the tab to close.', 'bad_input');
          const tab = driver.tabs.get(id);
          if (!tab) throw new ToolError(`There is no tab "${id}".`, 'no_tab');
          if (driver.tabs.size === 1)
            throw new ToolError('This is the last tab. Use browser_close instead.', 'bad_input');
          await tab.page.close();
          return `Closed tab ${id}. The active tab is ${driver.activeId}.`;
        }
        const rows: string[] = [];
        for (const tab of driver.tabs.values()) {
          const title = await tab.page.title().catch(() => '');
          const flags = [
            tab.id === driver.activeId ? 'active' : '',
            tab.openerId ? `opened by ${tab.openerId}` : '',
            driver.pendingDialog(tab.id) ? 'dialog open' : '',
            tab.crashed ? 'crashed' : '',
          ].filter(Boolean);
          rows.push(
            `${tab.id}${flags.length ? ` (${flags.join(', ')})` : ''}: "${title}" ${tab.page.url()}`,
          );
        }
        return untrusted(rows.join('\n'));
      }),
  );

  server.registerTool(
    'dialog',
    {
      title: 'Answer dialog',
      description:
        'Answer an alert, confirm, or prompt dialog that is open in the active tab. Ask the developer first if you are not sure. Or set how Walkthrough answers dialogs: "ask" (default), "accept", or "dismiss".',
      inputSchema: {
        action: z.enum(['accept', 'dismiss', 'policy']),
        text: z.string().optional().describe('Text to type into a prompt dialog.'),
        policy: z.enum(['ask', 'accept', 'dismiss']).optional().describe('For action "policy".'),
      },
    },
    ({ action, text, policy }) =>
      runTool(ctx, 'dialog', async () => {
        const driver = ctx.requireDriver();
        if (action === 'policy') {
          if (!policy) throw new ToolError('Give a policy: ask, accept, or dismiss.', 'bad_input');
          driver.dialogPolicy = policy;
          return `Walkthrough now answers new confirm and prompt dialogs with: ${policy}.`;
        }
        const answered = await driver.answerDialog(action === 'accept', text);
        const tab = driver.activeTab();
        return [
          `${action === 'accept' ? 'Accepted' : 'Dismissed'} the ${answered.type} dialog.`,
          await pageSummary(tab),
          'Take a snapshot to see what changed.',
        ].join('\n');
      }),
  );
}

// Gets the active tab even if its page crashed, so it can be reloaded.
function reloadableTab(driver: ReturnType<Context['requireDriver']>): Tab {
  const tab = driver.activeId ? driver.tabs.get(driver.activeId) : undefined;
  if (!tab) throw new ToolError('No tab is open.', 'no_tab');
  return tab;
}
