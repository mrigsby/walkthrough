import { createHash } from 'node:crypto';
import type { Cookie } from 'puppeteer-core';
import type { Driver, Tab } from '../browser/driver.js';
import { cookieMatches } from '../browser/sessions.js';
import { ToolError } from '../errors.js';
import type { OriginGuard } from '../guards/origins.js';
import type { CookieCheck } from './cookie-schema.js';

// Cookie and storage values often hold logins. Show a fingerprint, not the value,
// unless the developer set allowSecretValues in config.local.yaml.
export function maskValue(value: string, show: boolean): string {
  if (value === '') return '(empty)';
  if (show) return JSON.stringify(value.length > 500 ? `${value.slice(0, 500)}...` : value);
  const id = createHash('sha256').update(value).digest('hex').slice(0, 4);
  return `**** (${value.length} characters, id ${id})`;
}

// The sites under test in one login: the allowed sites that its tabs have open.
export function loginHosts(driver: Driver, tab: Tab, guard: OriginGuard): string[] {
  const hosts = new Set<string>();
  for (const t of driver.tabs.values()) {
    const url = t.page.url();
    if (t.login === tab.login && /^https?:/.test(url) && guard.isAllowed(url))
      hosts.add(new URL(url).hostname);
  }
  if (hosts.size === 0) {
    throw new ToolError(
      'No tab of this login is on an allowed site. Open the app first. Walkthrough only reads and changes cookies of the sites under test.',
      'no_tab',
    );
  }
  return [...hosts];
}

// The cookies of the active tab's login, for the sites under test only.
export async function siteCookies(tab: Tab, hosts: string[]): Promise<Cookie[]> {
  return (await tab.page.browserContext().cookies()).filter((c) => cookieMatches(c, hosts));
}

export function describeCookie(cookie: Cookie, show: boolean): string {
  const flags = [
    `domain ${cookie.domain}`,
    `path ${cookie.path}`,
    cookie.session || cookie.expires < 0
      ? 'ends with the session'
      : `ends ${new Date(cookie.expires * 1000).toISOString()}`,
    `${cookie.size} bytes`,
    cookie.httpOnly ? 'HttpOnly' : '',
    cookie.secure ? 'Secure' : '',
    cookie.sameSite ? `SameSite ${cookie.sameSite}` : 'no SameSite',
    cookie.partitionKey ? 'Partitioned' : '',
  ].filter(Boolean);
  return `- ${cookie.name}: ${maskValue(cookie.value, show)}. ${flags.join(', ')}.`;
}

// Runs cookie checks. The values are compared here, and never printed.
export function checkCookies(
  cookies: Cookie[],
  checks: CookieCheck[],
  resolve: (text: string) => string,
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const say = (pass: boolean, text: string) => {
    if (!pass) ok = false;
    lines.push(`${pass ? 'pass' : 'fail'}: ${text}`);
  };
  for (const check of checks) {
    const found = cookies.filter((c) => c.name === check.name);
    const cookie = found[0];
    if (check.exists === false) {
      say(!cookie, cookie ? `"${check.name}" is still set` : `"${check.name}" is not set`);
      continue;
    }
    if (!cookie) {
      say(false, `"${check.name}" is not set`);
      continue;
    }
    const facts: string[] = [];
    let pass = true;
    if (check.value !== undefined) {
      const same = cookie.value === resolve(check.value);
      pass &&= same;
      facts.push(
        same
          ? 'the value matches'
          : `the value does not match (it has ${cookie.value.length} characters)`,
      );
    }
    if (check.contains !== undefined) {
      const has = cookie.value.includes(resolve(check.contains));
      pass &&= has;
      facts.push(has ? 'the value has the text' : 'the value does not have the text');
    }
    for (const flag of ['httpOnly', 'secure'] as const) {
      if (check[flag] === undefined) continue;
      const same = cookie[flag] === check[flag];
      pass &&= same;
      const label = flag === 'httpOnly' ? 'HttpOnly' : 'Secure';
      facts.push(
        same ? `${label} is ${cookie[flag]}` : `${label} is ${cookie[flag]}, not ${check[flag]}`,
      );
    }
    if (check.sameSite !== undefined) {
      const same = cookie.sameSite === check.sameSite;
      pass &&= same;
      facts.push(
        same
          ? `SameSite is ${check.sameSite}`
          : `SameSite is ${cookie.sameSite ?? 'not set (Chrome then uses Lax)'}, not ${check.sameSite}`,
      );
    }
    const more =
      found.length > 1
        ? ` There are ${found.length} cookies with this name. Walkthrough checked the first.`
        : '';
    say(pass, `"${check.name}" is set${facts.length ? `, ${facts.join(', ')}` : ''}.${more}`);
  }
  return { ok, lines };
}

export type StorageKind = 'local' | 'session';

// Reads all keys and values of localStorage or sessionStorage in the page.
export async function readStorage(tab: Tab, kind: StorageKind): Promise<[string, string][]> {
  return tab.page.evaluate((which) => {
    const store = which === 'local' ? localStorage : sessionStorage;
    const out: [string, string][] = [];
    for (let i = 0; i < store.length && i < 500; i++) {
      const key = store.key(i);
      if (key !== null) out.push([key, store.getItem(key) ?? '']);
    }
    return out;
  }, kind);
}

// Sets, removes, or clears storage in the page.
export async function writeStorage(
  tab: Tab,
  kind: StorageKind,
  op: 'set' | 'delete' | 'clear',
  key?: string,
  value?: string,
): Promise<void> {
  await tab.page.evaluate(
    (which, what, k, v) => {
      const store = which === 'local' ? localStorage : sessionStorage;
      if (what === 'clear') store.clear();
      else if (what === 'delete' && k !== null) store.removeItem(k);
      else if (what === 'set' && k !== null) store.setItem(k, v ?? '');
    },
    kind,
    op,
    key ?? null,
    value ?? null,
  );
}
