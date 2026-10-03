import { spawnSync } from 'node:child_process';
import type { LookupOptions } from 'node:dns';
import { existsSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { join } from 'node:path';
import { findChrome, NO_CHROME_MESSAGE } from './browser/chrome.js';
import type { Driver } from './browser/driver.js';
import type { Config } from './config.js';
import { SELF } from './downloads/cache.js';
import { findFfmpeg } from './downloads/ffmpeg.js';
import { findLighthouse } from './downloads/lighthouse.js';
import { describeEnvironment, type Environment } from './environments.js';
import type { SecretStore } from './guards/secrets.js';
import { MIN_NODE, nodeVersionOk, VERSION } from './version.js';

// Sends a *.localhost name to this computer.
const toThisComputer = ((_host: string, options: LookupOptions, callback: AnyCallback) => {
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
}) as unknown as LookupFunction;
type AnyCallback = (error: null, ...result: unknown[]) => void;

// Asks the base URL of an environment for an answer, in 3 seconds or less.
// Node does not find *.localhost names, so those go to this computer, like Chrome does.
export function checkReachable(url: string): Promise<string> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve('not a valid URL');
      return;
    }
    const local = target.hostname.endsWith('.localhost');
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'GET',
        timeout: 3000,
        rejectUnauthorized: false,
        ...(local ? { lookup: toThisComputer } : {}),
      },
      (res) => {
        res.resume();
        resolve(`HTTP ${res.statusCode}`);
      },
    );
    req.on('timeout', () => req.destroy(new Error('no answer in 3 seconds')));
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    req.end();
  });
}

// The .env.<name> files that Git would commit. Empty when Git is not there.
function trackedEnvFiles(projectDir: string): string[] {
  const dir = join(projectDir, '.walkthrough');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\.env\..+/.test(f) && f !== '.env.example');
  } catch {
    return [];
  }
  return files.filter((f) => {
    const result = spawnSync('git', ['check-ignore', '-q', join('.walkthrough', f)], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    // 1 means "not ignored". Other codes mean no Git or no repository.
    return result.status === 1;
  });
}

async function environmentLines(config: Config): Promise<string[]> {
  const envs = Object.values(config.environments).filter(
    (e): e is Environment & { baseUrl: string } => Boolean(e.baseUrl),
  );
  if (envs.length < 2) return [];
  const lines: string[] = [];
  const answers = await Promise.all(
    envs.map(async (e) => (e.protected ? undefined : await checkReachable(e.baseUrl))),
  );
  envs.forEach((e, i) => {
    const answer = answers[i];
    if (answer === undefined) {
      lines.push(`INFO  ${e.name} (${e.baseUrl}): not checked, because it is protected.`);
    } else if (/^HTTP [1-4]\d\d$/.test(answer)) {
      lines.push(`OK    ${e.name} (${e.baseUrl}) answers: ${answer}.`);
    } else {
      lines.push(
        `INFO  ${e.name} (${e.baseUrl}) does not answer: ${answer}. Start it before you test there.`,
      );
    }
  });
  // Cookies belong to a host, not a port, so two environments on one host share a login.
  const hosts = new Map<string, string[]>();
  for (const e of envs) {
    const host = new URL(e.baseUrl).hostname;
    hosts.set(host, [...(hosts.get(host) ?? []), e.name]);
  }
  for (const [host, names] of hosts) {
    if (names.length > 1)
      lines.push(
        `INFO  ${names.join(' and ')} use the same host (${host}), so they share cookies and logins. A different host name for each one keeps them apart.`,
      );
  }
  return lines;
}

// A plain report of what works and what needs a fix.
export async function doctorReport(
  config: Config,
  secrets: SecretStore,
  driver?: Driver,
  // The MCP client, when the report comes from the doctor tool.
  client?: { name?: string; canAsk: boolean },
): Promise<string> {
  const ok = (text: string) => `OK    ${text}`;
  const fix = (text: string) => `FIX   ${text}`;
  const info = (text: string) => `INFO  ${text}`;
  const lines = [`Walkthrough (uiwalk) ${VERSION}`, ''];

  lines.push(
    nodeVersionOk()
      ? ok(`Node ${process.versions.node}`)
      : fix(
          `Node ${process.versions.node} is too old. Install Node ${MIN_NODE.join('.')} or later.`,
        ),
  );

  try {
    const chrome = await findChrome(config.browser.executablePath);
    lines.push(chrome ? ok(`Chrome (${chrome.source}): ${chrome.path}`) : fix(NO_CHROME_MESSAGE));
  } catch (error) {
    lines.push(fix((error as Error).message));
  }

  lines.push(info(`Project folder: ${config.projectDir} (found by ${config.projectDirSource})`));
  const configFile = join(config.projectDir, '.walkthrough', 'config.yaml');
  lines.push(
    existsSync(configFile)
      ? ok('Settings file: .walkthrough/config.yaml')
      : info('No .walkthrough/config.yaml. Walkthrough uses the default settings.'),
  );
  for (const warning of config.warnings) lines.push(fix(warning));

  const envs = Object.values(config.environments);
  lines.push(
    info(
      `Environment: ${describeEnvironment(config.environment)}${config.environment.protected ? ', protected' : ''}`,
    ),
  );
  if (envs.length > 1) {
    lines.push(
      info(
        `Environments: ${envs.map((e) => `${e.name}${e.protected ? ' (protected)' : ''}`).join(', ')}. Default: ${config.defaultEnvironment}.`,
      ),
    );
  }
  lines.push(...(await environmentLines(config)));
  for (const file of trackedEnvFiles(config.projectDir)) {
    lines.push(
      fix(
        `.walkthrough/${file} has secrets, but Git does not ignore it. Run /walkthrough:init to add ".env.*" to .walkthrough/.gitignore.`,
      ),
    );
  }
  lines.push(info(`Allowed sites: ${config.allowedOrigins.join(', ')}`));
  if (config.baseUrl) lines.push(info(`Base URL: ${config.baseUrl}`));
  lines.push(
    info(
      `Browser: ${config.browser.headless ? 'headless (hidden)' : 'visible'}, slow motion ${config.browser.slowMo} ms`,
    ),
  );
  lines.push(info(`Dialogs: ${config.dialogs}`));
  lines.push(info(`Page JavaScript (evaluate tool): ${config.allowEvaluate ? 'ON' : 'off'}`));
  lines.push(
    info(
      `Cookie, storage, and header values in replies: ${config.allowSecretValues ? 'SHOWN' : 'masked'}`,
    ),
  );
  if (config.screenshotRoots.length)
    lines.push(
      info(`Screenshot folders outside the project: ${config.screenshotRoots.join(', ')}`),
    );
  const envName = config.environment.name;
  const files =
    envName === 'development'
      ? '.walkthrough/.env'
      : `.walkthrough/.env.${envName}${config.environment.protected ? '' : ' and .walkthrough/.env'}`;
  lines.push(
    secrets.names.length > 0
      ? ok(`Secrets in ${files}: ${secrets.names.join(', ')}`)
      : info(`No secrets in ${files}.`),
  );
  if (client) {
    lines.push(
      info(
        `MCP client: ${client.name ?? 'unknown'}. ${client.canAsk ? 'It can ask the developer to confirm a protected environment when the browser panel is not there.' : 'It cannot ask the developer questions, so the browser panel asks to confirm a protected environment.'}`,
      ),
    );
  }

  const lighthouse = findLighthouse();
  lines.push(
    lighthouse
      ? ok(`Lighthouse ${lighthouse.version}: ${lighthouse.dir}`)
      : info(`Lighthouse is not installed. For performance reports, run: ${SELF} setup lighthouse`),
  );
  try {
    const ffmpeg = findFfmpeg({ configPath: config.ffmpegPath });
    lines.push(
      ffmpeg
        ? ok(`ffmpeg (${ffmpeg.source}): ${ffmpeg.path}`)
        : info(
            `Walkthrough did not find ffmpeg. Videos still work as GIF and WebM, and as MP4 when Chrome can make it. For exported videos and the MP4 fallback, run: ${SELF} setup ffmpeg`,
          ),
    );
  } catch (error) {
    lines.push(fix((error as Error).message));
  }

  if (driver) {
    lines.push(
      driver.alive
        ? info(
            `Browser is open (${driver.mode}, ${driver.chromeVersion}), ${driver.tabs.size} tab(s).`,
          )
        : info('The browser is closed.'),
    );
  } else {
    lines.push(info('No browser is open.'));
  }
  return lines.join('\n');
}
