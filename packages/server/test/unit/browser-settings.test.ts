import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeBrowserSettings,
  launchKey,
  launchPlan,
  pageSettings,
  resolveBrowserSettings,
} from '../../src/browser/browser-settings.js';
import { loadConfig } from '../../src/config.js';
import { exportScript } from '../../src/export/puppeteer-script.js';
import { executionHash } from '../../src/presentation/rehearsal.js';
import { validatePlanText } from '../../src/run/plans.js';
import type { Run } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

describe('browser settings', () => {
  it('turns prompts off by default', () => {
    const settings = resolveBrowserSettings([], '/p');
    expect(settings).toMatchObject({
      autofill: false,
      passwords: false,
      permissionPrompts: 'deny',
      spellcheck: false,
      keepFocus: true,
      downloads: false,
      automationBar: true,
    });
    const plan = launchPlan(settings, { headless: false });
    expect(plan.args).toEqual(['--deny-permission-prompts']);
    expect(plan.prefs).toEqual({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false, password_manager_leak_detection: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      browser: { enable_spellchecking: false },
    });
    expect(plan.ignoreDefaultArgs).toEqual([]);
  });

  it('lets the plan win, key by key, and turns settings into flags and prefs', () => {
    const settings = resolveBrowserSettings(
      [
        { language: 'en-GB', autoplay: true, hosts: { 'api.test': '127.0.0.1' } },
        {
          language: 'de-DE',
          passwords: true,
          permissionPrompts: 'ask',
          fakeMedia: true,
          thirdPartyCookies: 'block',
          zoom: 1.25,
          devtools: { dock: 'window', deviceToolbar: true },
          secureOrigins: ['http://dev.test:8080'],
          automationBar: false,
          extensions: ['tools/react-devtools'],
        },
      ],
      '/p',
    );
    expect(settings.autoplay).toBe(true);
    expect(settings.extensions).toEqual(['/p/tools/react-devtools']);
    const plan = launchPlan(settings, { headless: false, zoomHosts: ['localhost'] });
    expect(plan.args).toEqual([
      '--lang=de-DE',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--host-resolver-rules=MAP api.test 127.0.0.1',
      '--unsafely-treat-insecure-origin-as-secure=http://dev.test:8080',
    ]);
    expect(plan.prefs).toMatchObject({
      credentials_enable_service: true,
      intl: { accept_languages: 'de-DE,de' },
      profile: { cookie_controls_mode: 1, password_manager_enabled: true },
      devtools: {
        preferences: { currentDockState: '"undocked"', 'emulation.show-device-mode': 'true' },
      },
    });
    const zoom = (
      plan.prefs.partition as {
        per_host_zoom_levels: { x: Record<string, { zoom_level: number }> };
      }
    ).per_host_zoom_levels.x.localhost;
    expect(zoom?.zoom_level).toBeCloseTo(Math.log(1.25) / Math.log(1.2));
    expect(plan.ignoreDefaultArgs).toEqual(['--enable-automation']);
    expect(plan.devtools).toBe(true);
    expect(launchPlan(settings, { headless: true }).devtools).toBe(false);
    expect(describeBrowserSettings(settings)).toContain('DevTools (window, device toolbar)');
  });

  it('needs a new browser only for launch settings', () => {
    const base = resolveBrowserSettings([], '/p');
    const key = launchKey(base, false);
    expect(
      launchKey(resolveBrowserSettings([{ window: { width: 1440, height: 900 } }], '/p'), false),
    ).toBe(key);
    expect(
      launchKey(resolveBrowserSettings([{ downloads: true, keepFocus: false }], '/p'), false),
    ).toBe(key);
    expect(launchKey(resolveBrowserSettings([{ language: 'de-DE' }], '/p'), false)).not.toBe(key);
    // Headless Chrome has no DevTools, so it needs no new browser for it.
    expect(launchKey(resolveBrowserSettings([{ devtools: true }], '/p'), true)).toBe(
      launchKey(base, true),
    );
    expect(
      pageSettings(resolveBrowserSettings([{ language: 'de-DE', spellcheck: true }], '/p')),
    ).toEqual({
      language: 'de-DE',
    });
  });

  it('reads the settings from config.yaml, and keeps full extension paths local', () => {
    const dir = tempDir('browser-config');
    mkdirSync(join(dir, '.walkthrough'));
    writeFileSync(
      join(dir, '.walkthrough', 'config.yaml'),
      'browser:\n  language: fr-FR\n  extensions: [ext/one, /abs/two]\n',
    );
    writeFileSync(
      join(dir, '.walkthrough', 'config.local.yaml'),
      'browser:\n  extensions: [/abs/three]\n',
    );
    const config = loadConfig(dir);
    expect(config.browser.options.language).toBe('fr-FR');
    expect(config.browser.options.extensions).toEqual(['/abs/three']);
    const shared = tempDir('browser-config-shared');
    mkdirSync(join(shared, '.walkthrough'));
    writeFileSync(
      join(shared, '.walkthrough', 'config.yaml'),
      'browser:\n  extensions: [ext/one, /abs/two]\n',
    );
    const warned = loadConfig(shared);
    expect(warned.browser.options.extensions).toEqual(['ext/one']);
    expect(warned.warnings.join(' ')).toContain('full paths in "browser.extensions"');
  });

  it('checks the browser block of a plan', () => {
    const ok = (block: string) =>
      validatePlanText(`name: B\nbrowser: ${block}\nsteps:\n  - do: x\n`).ok;
    expect(ok('{ language: de-DE, downloads: true, devtools: { dock: bottom } }')).toBe(true);
    expect(ok('{ language: "not a tag" }')).toBe(false);
    expect(ok('{ hosts: { "api.test": "127.0.0.1 x" } }')).toBe(false);
    expect(ok('{ devtools: { dock: left } }')).toBe(false);
    expect(ok('{ unknownKey: red }')).toBe(false);
  });

  it('counts page settings in a rehearsal, and exported scripts use the flags', () => {
    const plan = (block: string) => {
      const result = validatePlanText(`name: B\n${block}steps:\n  - do: x\n`);
      if (!result.ok) throw new Error('invalid');
      return result.plan;
    };
    const plain = executionHash(plan(''));
    expect(executionHash(plan('browser: { devtools: true }\n'))).toBe(plain);
    expect(executionHash(plan('browser: { language: de-DE }\n'))).not.toBe(plain);
    const run: Run = {
      version: 1,
      id: 'r',
      name: 'B',
      mode: 'interactive',
      status: 'finished',
      startedAt: '2026-10-17T10:00:00.000Z',
      baseUrl: 'http://localhost:4321',
      browser: { language: 'de-DE', zoom: 1.25 },
      steps: [],
    };
    const code = exportScript(run).code;
    expect(code).toContain('args: ["--deny-permission-prompts","--lang=de-DE"]');
    expect(code).toContain('which this script does not set: zoom.');
  });
});
