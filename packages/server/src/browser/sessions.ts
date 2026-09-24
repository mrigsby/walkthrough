import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Cookie, CookieData } from 'puppeteer-core';
import { ToolError } from '../errors.js';
import type { OriginGuard } from '../guards/origins.js';
import type { Driver, Tab } from './driver.js';

// A saved login: cookies, plus localStorage and sessionStorage for each site.
// This does not save IndexedDB, so apps that keep their login there need a new login.
export interface SavedSession {
  version: 1;
  name: string;
  savedAt: string;
  origins: string[];
  cookies: Cookie[];
  storage: Record<string, { local: Record<string, string>; session: Record<string, string> }>;
}

export function sessionsDir(projectDir: string): string {
  return join(projectDir, '.walkthrough', 'sessions');
}

function sessionFile(projectDir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new ToolError(
      'Use a session name with lowercase letters, numbers, and dashes, like "admin".',
      'bad_input',
    );
  }
  return join(sessionsDir(projectDir), `${name}.json`);
}

// True when a cookie belongs to one of these hosts.
function cookieMatches(cookie: Cookie, hosts: string[]): boolean {
  const domain = cookie.domain.replace(/^\./, '');
  return hosts.some((host) => host === domain || host.endsWith(`.${domain}`));
}

// Saves the login state for the allowed sites that are open in the browser.
export async function saveSession(
  driver: Driver,
  guard: OriginGuard,
  projectDir: string,
  name: string,
): Promise<SavedSession> {
  const file = sessionFile(projectDir, name);
  const tabs = [...driver.tabs.values()].filter(
    (t) => guard.isAllowed(t.page.url()) && /^https?:/.test(t.page.url()),
  );
  if (tabs.length === 0) {
    throw new ToolError(
      'No tab is on an allowed site. Open the app and log in. Then save the session.',
      'no_tab',
    );
  }
  const origins = [...new Set(tabs.map((t) => new URL(t.page.url()).origin))];
  const hosts = origins.map((o) => new URL(o).hostname);

  // Only cookies for the sites under test. In attach mode, the rest of the browser stays private.
  const cookies = (await driver.browser.defaultBrowserContext().cookies()).filter((c) =>
    cookieMatches(c, hosts),
  );

  const storage: SavedSession['storage'] = {};
  for (const tab of tabs) {
    const origin = new URL(tab.page.url()).origin;
    if (storage[origin]) continue;
    storage[origin] = await tab.page.evaluate(() => {
      const read = (s: Storage) => {
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          if (key !== null) out[key] = s.getItem(key) ?? '';
        }
        return out;
      };
      return { local: read(localStorage), session: read(sessionStorage) };
    });
  }

  const session: SavedSession = {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    origins,
    cookies,
    storage,
  };
  mkdirSync(sessionsDir(projectDir), { recursive: true, mode: 0o700 });
  // Only the developer's user account can read this file.
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return session;
}

export function loadSession(projectDir: string, name: string): SavedSession {
  const file = sessionFile(projectDir, name);
  if (!existsSync(file)) {
    throw new ToolError(
      `There is no saved session "${name}". Use the session tool with action "list".`,
      'session_not_found',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as SavedSession;
}

export function listSessions(projectDir: string): SavedSession[] {
  const dir = sessionsDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as SavedSession];
      } catch {
        return [];
      }
    });
}

export function deleteSession(projectDir: string, name: string): void {
  const file = sessionFile(projectDir, name);
  if (!existsSync(file))
    throw new ToolError(`There is no saved session "${name}".`, 'session_not_found');
  rmSync(file);
}

// Puts a saved login back. Cookies go in now. Storage is written by a script
// that runs before the app's own scripts on the next page load, then stops.
export async function restoreSession(
  driver: Driver,
  tab: Tab,
  session: SavedSession,
): Promise<void> {
  if (session.cookies.length > 0) {
    const cookies: CookieData[] = session.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    await driver.browser.defaultBrowserContext().setCookie(...cookies);
  }
  if (Object.keys(session.storage).length === 0) return;
  const { identifier } = await tab.page.evaluateOnNewDocument((storage) => {
    const saved = (storage as SavedSession['storage'])[location.origin];
    if (!saved || window !== window.top) return;
    for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value);
  }, session.storage);
  // Only for the next page load. Later loads must not undo a logout.
  tab.page.once(
    'load',
    () => void tab.page.removeScriptToEvaluateOnNewDocument(identifier).catch(() => undefined),
  );
}
