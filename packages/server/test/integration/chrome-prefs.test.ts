import { expect, it } from 'vitest';
import { killChrome, launchChrome, removeProfile } from '../../src/browser/launch.js';
import { loadConfig } from '../../src/config.js';
import { tempDir } from '../helpers/temp.js';

// Chrome's "Change your password" dialog blocks all clicks in the tab. It comes after a
// login with a password from a leak list, like the demo password. Chrome must not check.
it('starts Chrome with the password manager and the leak check off', async () => {
  const { browser, profileDir } = await launchChrome({
    ...loadConfig(tempDir('chrome-prefs')),
    browser: { headless: true, slowMo: 0 },
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
