import { relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CookieData } from 'puppeteer-core';
import { z } from 'zod';
import type { Tab } from '../browser/driver.js';
import type { Context } from '../context.js';
import { cookieCheckSchema } from '../devtools/cookie-schema.js';
import { DEFAULT_PROPERTIES, inspectElement } from '../devtools/inspect.js';
import {
  checkCookies,
  describeCookie,
  loginHosts,
  maskValue,
  readStorage,
  siteCookies,
  writeStorage,
} from '../devtools/storage.js';
import { ToolError } from '../errors.js';
import { networkDir, writeHar } from '../evidence/har.js';
import { maskBody, type NetEntry, SECRET_HEADER } from '../evidence/network.js';
import { scrubText, scrubUrl } from '../evidence/scrub.js';
import { untrusted } from '../guards/untrusted.js';
import { resolveTarget } from '../page/actions.js';
import { tokenizeUnique, withUnique } from '../page/unique.js';
import { runTool } from './util.js';

const KINDS = ['cookies', 'local', 'session'] as const;
const NET_TYPES = ['document', 'xhr', 'fetch'];
const MAX_SHOWN_BODY = 20_000;

// Keeps requests that match the filters.
function filterRequests(
  entries: NetEntry[],
  filters: { urlContains?: string; types?: string[]; status?: string },
): NetEntry[] {
  return entries.filter((e) => {
    if (filters.urlContains && !e.url.includes(filters.urlContains)) return false;
    if (filters.types && !filters.types.includes(e.type)) return false;
    const status = filters.status?.toLowerCase();
    if (!status) return true;
    if (status === 'failed') return Boolean(e.failure);
    if (status === 'errors') return Boolean(e.failure) || (e.status ?? 0) >= 400;
    const range = /^([1-5])xx$/.exec(status);
    if (range) return Math.floor((e.status ?? 0) / 100) === Number(range[1]);
    return String(e.status) === status;
  });
}

function sizeText(bytes?: number): string {
  if (bytes === undefined) return '? B';
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;
}

// One line for a request, like: r12 GET 500 xhr http://localhost/api/stock (12 ms, 45 B)
function requestLine(e: NetEntry): string {
  const time = e.endedAt ? `${e.endedAt - e.startedAt} ms` : 'not finished';
  const result = e.failure ? `failed (${e.failure})` : String(e.status ?? '...');
  const extra = [time, sizeText(e.size), e.fromCache ? 'from cache' : '', `tab ${e.tabId}`]
    .filter(Boolean)
    .join(', ');
  return `${e.id} ${e.method} ${result} ${e.type} ${scrubUrl(e.url)} (${extra})${e.step ? ` [step "${e.step}"]` : ''}`;
}
const STORAGE_NAMES = { local: 'localStorage', session: 'sessionStorage' } as const;

export function registerDevtoolsTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'storage',
    {
      title: 'Cookies and storage',
      description: [
        'List, get, set, delete, or clear cookies, localStorage, or sessionStorage. It works on the sites under test, in the login of the active tab.',
        'check compares cookies with checks, like { name: "session", httpOnly: true }. clearSiteData clears cookies, storage, cache, IndexedDB, and service workers of the active tab\'s site.',
        'Values show as a fingerprint unless the developer allows them in config.local.yaml. Walkthrough never touches other sites.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['list', 'get', 'set', 'delete', 'clear', 'check', 'clearSiteData']),
        kind: z.enum(KINDS).default('cookies').describe('cookies (default), local, or session.'),
        name: z.string().min(1).optional().describe('The cookie name or the storage key.'),
        value: z.string().optional().describe('For set. {{secret:NAME}} and {{unique}} work here.'),
        domain: z.string().optional().describe('For cookies: the domain. Default: the active tab.'),
        path: z.string().optional().describe('For cookies: the path. Default: "/".'),
        expires: z
          .number()
          .optional()
          .describe('For set cookie: when it ends, in Unix seconds. Default: with the session.'),
        httpOnly: z.boolean().optional().describe('For set cookie.'),
        secure: z.boolean().optional().describe('For set cookie.'),
        sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('For set cookie.'),
        checks: z
          .array(cookieCheckSchema)
          .optional()
          .describe('For check: the cookie checks. With stepId, the checks come from the plan.'),
        stepId: z.string().optional().describe('For check: a plan step with "cookies" checks.'),
      },
    },
    (input) =>
      runTool(ctx, 'storage', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const config = await ctx.config();
        const guard = await ctx.guard();
        const secrets = await ctx.secrets();
        const show = config.allowSecretValues;
        const resolve = (text: string) => secrets.resolve(withUnique(text, ctx.unique));
        // Writes are kept, so an export or a replay does them again.
        const keep = (label: string, detail: Record<string, unknown>) =>
          ctx.actionLog.push({
            at: new Date().toISOString(),
            tabId: tab.id,
            tab: tab.name,
            action: 'storage',
            label,
            value: JSON.stringify({ kind: input.kind, op: input.action, ...detail }),
            url: tokenizeUnique(tab.page.url(), ctx.unique),
          });

        if (input.action === 'clearSiteData') {
          const origin = pageOrigin(tab, guard.isAllowed.bind(guard));
          if (!tab.cdp)
            throw new ToolError('Walkthrough cannot reach this tab to clear its data.', 'no_tab');
          await tab.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
          keep(`Clear the site data of ${origin}`, {});
          return `Cleared the cookies, storage, cache, IndexedDB, and service workers of ${origin} in the login "${tab.login}". Reload the page to see the effect.`;
        }

        if (input.kind !== 'cookies') {
          return storageAction(
            tab,
            { ...input, kind: input.kind },
            show,
            resolve,
            keep,
            guard.isAllowed.bind(guard),
          );
        }

        const hosts = loginHosts(driver, tab, guard);
        const cookies = await siteCookies(tab, hosts);
        const context = tab.page.browserContext();
        const named = () => {
          if (!input.name)
            throw new ToolError(`Give the cookie "name" for ${input.action}.`, 'bad_input');
          return cookies.filter(
            (c) =>
              c.name === input.name &&
              (!input.domain || c.domain.replace(/^\./, '') === input.domain.replace(/^\./, '')) &&
              (!input.path || c.path === input.path),
          );
        };

        switch (input.action) {
          case 'list':
            return cookies.length
              ? untrusted(
                  [
                    `${cookies.length} cookie(s) for ${hosts.join(', ')}:`,
                    ...cookies.map((c) => describeCookie(c, show)),
                  ].join('\n'),
                )
              : `There are no cookies for ${hosts.join(', ')} in the login "${tab.login}".`;
          case 'get': {
            const found = named();
            if (found.length === 0)
              return `There is no cookie named "${input.name}" for ${hosts.join(', ')}.`;
            return untrusted(found.map((c) => describeCookie(c, show)).join('\n'));
          }
          case 'set': {
            if (!input.name || input.value === undefined)
              throw new ToolError('Give the cookie "name" and "value" to set.', 'bad_input');
            const domain = input.domain ?? new URL(tab.page.url()).hostname;
            if (
              !hosts.some(
                (h) =>
                  h === domain.replace(/^\./, '') || h.endsWith(`.${domain.replace(/^\./, '')}`),
              )
            ) {
              throw new ToolError(
                `Walkthrough only sets cookies for the sites under test (${hosts.join(', ')}), not for "${domain}".`,
                'origin_blocked',
              );
            }
            const cookie: CookieData = {
              name: input.name,
              value: resolve(input.value),
              domain,
              path: input.path ?? '/',
              ...(input.expires !== undefined ? { expires: input.expires } : {}),
              ...(input.httpOnly !== undefined ? { httpOnly: input.httpOnly } : {}),
              ...(input.secure !== undefined ? { secure: input.secure } : {}),
              ...(input.sameSite ? { sameSite: input.sameSite } : {}),
            };
            await context.setCookie(cookie);
            keep(`Set the cookie "${input.name}"`, {
              name: input.name,
              value: input.value,
              domain,
              path: cookie.path,
              expires: input.expires,
              httpOnly: input.httpOnly,
              secure: input.secure,
              sameSite: input.sameSite,
            });
            return `Set the cookie "${input.name}" for ${domain}${cookie.path === '/' ? '' : ` at ${cookie.path}`} in the login "${tab.login}". Reload the page if the app reads it on load.`;
          }
          case 'delete': {
            const found = named();
            if (found.length === 0)
              return `There is no cookie named "${input.name}" for ${hosts.join(', ')}.`;
            await context.deleteCookie(...found);
            keep(`Delete the cookie "${input.name}"`, {
              name: input.name,
              domain: input.domain,
              path: input.path,
            });
            return `Deleted ${found.length} cookie(s) named "${input.name}".`;
          }
          case 'clear': {
            if (cookies.length) await context.deleteCookie(...cookies);
            keep(`Clear the cookies of ${hosts.join(', ')}`, {});
            return `Deleted ${cookies.length} cookie(s) for ${hosts.join(', ')} in the login "${tab.login}". Other sites keep their cookies.`;
          }
          case 'check': {
            const checks = input.checks ?? stepChecks(ctx, input.stepId);
            const result = checkCookies(cookies, checks, resolve);
            return [
              `result: ${result.ok ? 'pass' : 'fail'}`,
              untrusted(result.lines.join('\n')),
            ].join('\n');
          }
        }
      }),
  );

  server.registerTool(
    'network',
    {
      title: 'Network requests',
      description: [
        'List the requests of the browser, like the Network panel in DevTools. By default, it lists page, XHR, and fetch requests since the current step started.',
        'show gives one request with its headers and body. har saves the requests as a HAR file.',
        'The reply masks login headers and secret body fields, unless the developer allows them in config.local.yaml.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['list', 'show', 'har']).default('list'),
        id: z.string().optional().describe('For show: the request id, like "r12".'),
        urlContains: z.string().optional().describe('Only requests whose address has this text.'),
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Resource types, like ["xhr", "fetch"]. Default for list: document, xhr, fetch. Default for har: all.',
          ),
        all: z
          .boolean()
          .optional()
          .describe('All resource types, also scripts, images, and styles.'),
        status: z
          .string()
          .optional()
          .describe('Like "500", "4xx", "errors" (400 and up, or failed), or "failed".'),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Requests after this marker number. 0 for all. Default: since the step started.',
          ),
        limit: z.number().int().min(1).max(500).optional().describe('For list. Default 50.'),
        name: z.string().optional().describe('For har: a short name for the file.'),
        stepId: z.string().optional().describe('For har during a run: add the file to this step.'),
      },
    },
    (input) =>
      runTool(ctx, 'network', async () => {
        const driver = ctx.requireDriver();
        const config = await ctx.config();
        const show = config.allowSecretValues;
        if (input.action === 'show') {
          if (!input.id) throw new ToolError('Give the request "id", like "r12".', 'bad_input');
          const e = driver.network.get(input.id);
          if (!e)
            throw new ToolError(
              `There is no request "${input.id}". It may be too old.`,
              'not_found',
            );
          const requestMime = e.requestHeaders['content-type']?.split(';')[0]?.trim();
          const lines = [
            requestLine(e),
            `Status: ${e.failure ? `failed: ${e.failure}` : `${e.status ?? '...'} ${e.statusText ?? ''}`.trim()}`,
            '',
            'Request headers:',
            ...headerLines(e.requestHeaders, show),
          ];
          if (e.postData) lines.push('', 'Request body:', bodyText(e.postData, requestMime, show));
          if (e.responseHeaders)
            lines.push('', 'Response headers:', ...headerLines(e.responseHeaders, show));
          if (e.body !== undefined) {
            lines.push(
              '',
              `Response body (${e.mimeType ?? 'unknown type'}):`,
              bodyText(e.body, e.mimeType, show),
            );
          }
          if (e.bodyNote) lines.push('', `Note: ${e.bodyNote}`);
          return untrusted(lines.join('\n'));
        }
        const base =
          input.since === undefined
            ? driver.network.currentStep()
            : driver.network.since(input.since);
        const types = input.all
          ? undefined
          : (input.types ?? (input.action === 'har' ? undefined : NET_TYPES));
        const entries = filterRequests(base, {
          urlContains: input.urlContains,
          types,
          status: input.status,
        });
        if (input.action === 'har') {
          if (entries.length === 0)
            return 'There are no requests to save. Try since: 0, or fewer filters.';
          const file = writeHar(
            networkDir(ctx, config.projectDir),
            input.name ?? 'requests',
            entries,
            await ctx.secrets(),
          );
          const relativePath = relative(config.projectDir, file);
          if (input.stepId && ctx.run?.run.status === 'running') {
            const step = ctx.run.step({ id: input.stepId });
            step.files = [...(step.files ?? []), relative(ctx.run.dir, file)];
            ctx.run.save();
          }
          return `Saved ${entries.length} request(s) to ${relativePath}. The file has no login headers, cookies, or secret body fields. DevTools and other tools can open the file.`;
        }
        const limit = input.limit ?? 50;
        const shown = entries.slice(-limit);
        const lines = shown.map(requestLine);
        const head = `${entries.length} request(s)${input.since === undefined ? ' since the current step started' : ` after marker ${input.since}`}${entries.length > shown.length ? `. Showing the last ${shown.length}.` : '.'}`;
        return [
          head,
          lines.length ? untrusted(lines.join('\n')) : '',
          `Latest marker: ${driver.network.marker}. Use show with an id to see headers and the body.`,
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );

  server.registerTool(
    'inspect',
    {
      title: 'Inspect an element',
      description: [
        'Show why an element looks and acts the way it does, like the Elements panel in DevTools.',
        'It gives the computed styles and the box size. It also gives the CSS rules and the event listeners, each with its file and line.',
        'Listeners on parents count too, because many frameworks put one handler on the root.',
      ].join(' '),
      inputSchema: {
        ref: z.string().optional().describe('A ref from the last snapshot, like "e12".'),
        selector: z.string().optional().describe('A CSS or Puppeteer selector.'),
        properties: z
          .array(z.string())
          .optional()
          .describe(
            `Computed styles to show. Default: ${DEFAULT_PROPERTIES.slice(0, 6).join(', ')}, and more.`,
          ),
        rules: z.boolean().optional().describe('Show the CSS rules. Default true.'),
        listeners: z.boolean().optional().describe('Show the event listeners. Default true.'),
        ancestors: z
          .boolean()
          .optional()
          .describe('Also show listeners on parents, the document, and the window. Default true.'),
      },
    },
    (input) =>
      runTool(ctx, 'inspect', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const target = await resolveTarget(driver, tab, input);
        if (!target) throw new ToolError('Give a "ref" or a "selector".', 'bad_input');
        const text = await inspectElement(tab, target.handle, {
          properties: input.properties,
          rules: input.rules ?? true,
          listeners: input.listeners ?? true,
          ancestors: input.ancestors ?? true,
        });
        return untrusted(text);
      }),
  );
}

// Headers, with login headers masked unless the developer allows them.
function headerLines(headers: Record<string, string> | undefined, show: boolean): string[] {
  return Object.entries(headers ?? {}).map(
    ([name, value]) =>
      `  ${name}: ${SECRET_HEADER.test(name) ? maskValue(value, show) : show ? value : scrubText(value)}`,
  );
}

// A body for a reply: secret fields masked, long bodies shortened.
function bodyText(text: string, mime: string | undefined, show: boolean): string {
  const masked = show
    ? maskBody(text, mime, (v) => v)
    : scrubText(maskBody(text, mime, (v) => maskValue(v, false)));
  return masked.length > MAX_SHOWN_BODY
    ? `${masked.slice(0, MAX_SHOWN_BODY)}\n... (${masked.length - MAX_SHOWN_BODY} more characters)`
    : masked;
}

// The origin of the active tab, if it is an allowed site.
function pageOrigin(tab: Tab, isAllowed: (url: string) => boolean): string {
  const url = tab.page.url();
  if (!/^https?:/.test(url) || !isAllowed(url)) {
    throw new ToolError(
      'The active tab is not on an allowed site. Walkthrough only reads and changes the data of the sites under test.',
      'origin_blocked',
    );
  }
  return new URL(url).origin;
}

// The cookie checks of a plan step.
function stepChecks(ctx: Context, stepId?: string) {
  if (!stepId)
    throw new ToolError(
      'Give "checks", or the "stepId" of a plan step with cookie checks.',
      'bad_input',
    );
  const run = ctx.run?.run;
  if (run?.status !== 'running')
    throw new ToolError('No run is going, so there is no plan step to read.', 'no_run');
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new ToolError(`The run has no step "${stepId}".`, 'bad_step');
  if (!step.cookies?.length)
    throw new ToolError(`Step "${stepId}" has no cookie checks.`, 'bad_step');
  return step.cookies;
}

// localStorage and sessionStorage of the active tab's site.
async function storageAction(
  tab: Tab,
  input: { action: string; kind: 'local' | 'session'; name?: string; value?: string },
  show: boolean,
  resolve: (text: string) => string,
  keep: (label: string, detail: Record<string, unknown>) => void,
  isAllowed: (url: string) => boolean,
): Promise<string> {
  const origin = pageOrigin(tab, isAllowed);
  const store = STORAGE_NAMES[input.kind];
  const entries = await readStorage(tab, input.kind);
  const line = ([key, value]: [string, string]) => `- ${key}: ${maskValue(value, show)}`;
  switch (input.action) {
    case 'list':
      return entries.length
        ? untrusted(
            [`${entries.length} item(s) in ${store} of ${origin}:`, ...entries.map(line)].join(
              '\n',
            ),
          )
        : `${store} of ${origin} is empty.`;
    case 'get': {
      if (!input.name) throw new ToolError('Give the key "name" to get.', 'bad_input');
      const found = entries.find(([key]) => key === input.name);
      return found ? untrusted(line(found)) : `${store} of ${origin} has no key "${input.name}".`;
    }
    case 'set':
      if (!input.name || input.value === undefined)
        throw new ToolError('Give the key "name" and the "value" to set.', 'bad_input');
      await writeStorage(tab, input.kind, 'set', input.name, resolve(input.value));
      keep(`Set "${input.name}" in ${store}`, { name: input.name, value: input.value });
      return `Set "${input.name}" in ${store} of ${origin}.`;
    case 'delete':
      if (!input.name) throw new ToolError('Give the key "name" to delete.', 'bad_input');
      await writeStorage(tab, input.kind, 'delete', input.name);
      keep(`Delete "${input.name}" from ${store}`, { name: input.name });
      return `Deleted "${input.name}" from ${store} of ${origin}.`;
    case 'clear':
      await writeStorage(tab, input.kind, 'clear');
      keep(`Clear ${store}`, {});
      return `Cleared ${store} of ${origin}.`;
    default:
      throw new ToolError(`The ${input.action} action works only for cookies.`, 'bad_input');
  }
}
