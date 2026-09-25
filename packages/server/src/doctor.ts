import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, NO_CHROME_MESSAGE } from './browser/chrome.js';
import type { Driver } from './browser/driver.js';
import type { Config } from './config.js';
import type { SecretStore } from './guards/secrets.js';
import { MIN_NODE, nodeVersionOk, VERSION } from './version.js';

// A plain report of what works and what needs a fix.
export async function doctorReport(
  config: Config,
  secrets: SecretStore,
  driver?: Driver,
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

  lines.push(info(`Allowed sites: ${config.allowedOrigins.join(', ')}`));
  if (config.baseUrl) lines.push(info(`Base URL: ${config.baseUrl}`));
  lines.push(
    info(
      `Browser: ${config.browser.headless ? 'headless (hidden)' : 'visible'}, slow motion ${config.browser.slowMo} ms`,
    ),
  );
  lines.push(info(`Dialogs: ${config.dialogs}`));
  lines.push(info(`Page JavaScript (evaluate tool): ${config.allowEvaluate ? 'ON' : 'off'}`));
  if (config.screenshotRoots.length)
    lines.push(
      info(`Screenshot folders outside the project: ${config.screenshotRoots.join(', ')}`),
    );
  lines.push(
    secrets.names.length > 0
      ? ok(`Secrets in .walkthrough/.env: ${secrets.names.join(', ')}`)
      : info('No secrets in .walkthrough/.env.'),
  );

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
