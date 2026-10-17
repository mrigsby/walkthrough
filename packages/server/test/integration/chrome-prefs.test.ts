import { expect, it } from 'vitest';
import { resolveBrowserSettings } from '../../src/browser/browser-settings.js';
import { killChrome, launchChrome, removeProfile } from '../../src/browser/launch.js';
import { loadConfig } from '../../src/config.js';
import { tempDir } from '../helpers/temp.js';

// Chrome's "Change your password" dialog blocks all clicks in the tab. It comes after a
// login with a password from a leak list, like the demo password. Chrome must not check.
it('starts Chrome with the password manager and the leak check off', async () => {
  const { browser, profileDir } = await launchChrome({
    ...loadConfig(tempDir('chrome-prefs')),
    browser: { headless: true, slowMo: 0, window: { width: 1280, height: 800 }, options: {} },
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto('chrome://prefs-internals');
    const prefs = JSON.parse(await page.evaluate(() => document.body.innerText));
    expect(prefs.credentials_enable_service.value).toBe(false);
    expect(prefs.profile.password_manager_leak_detection.value).toBe(false);
  } finally {
    await killChrome(browser);
    removeProfile(profileDir);
  }
}, 60_000);

// Browser settings become Chrome prefs and flags. The password prefs must stay.
it('starts Chrome with the browser settings of the plan', async () => {
  const dir = tempDir('chrome-settings');
  const config = loadConfig(dir);
  const { browser, profileDir } = await launchChrome(
    { ...config, browser: { ...config.browser, headless: true } },
    {
      settings: resolveBrowserSettings(
        [{ language: 'de-DE', thirdPartyCookies: 'block', fontSize: { default: 20, minimum: 12 } }],
        dir,
      ),
    },
  );
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto('chrome://prefs-internals');
    const prefs = JSON.parse(await page.evaluate(() => document.body.innerText));
    const value = (path: string) =>
      path.split('.').reduce((o, k) => o?.[k], prefs)?.value as unknown;
    expect(value('credentials_enable_service')).toBe(false);
    expect(value('profile.password_manager_leak_detection')).toBe(false);
    expect(value('autofill.profile_enabled')).toBe(false);
    expect(value('autofill.credit_card_enabled')).toBe(false);
    expect(value('browser.enable_spellchecking')).toBe(false);
    expect(value('intl.accept_languages')).toBe('de-DE,de');
    expect(value('profile.cookie_controls_mode')).toBe(1);
    expect(value('webkit.webprefs.default_font_size')).toBe(20);
    expect(value('webkit.webprefs.minimum_font_size')).toBe(12);
    // The flags: no permission prompts, and the language.
    const probe = await browser.newPage();
    await probe.goto('data:text/html,<p>x</p>');
    expect(await probe.evaluate(() => navigator.language)).toBe('de-DE');
  } finally {
    await killChrome(browser);
    removeProfile(profileDir);
  }
}, 60_000);
