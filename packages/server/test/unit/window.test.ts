import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, fitSize } from '../../src/browser/browser-settings.js';
import { describeEmulation, deviceSize, orientedDevice } from '../../src/browser/devices.js';
import { loadConfig } from '../../src/config.js';
import { exportScript } from '../../src/export/puppeteer-script.js';
import { validatePlanText } from '../../src/run/plans.js';
import type { Run } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

const MAC = { width: 1728, height: 1079, frameWidth: 0, frameHeight: 143 };

describe('window size', () => {
  it('keeps the page area on the screen', () => {
    expect(fitSize({ width: 1280, height: 800 }, MAC)).toEqual({
      size: { width: 1280, height: 800 },
      clipped: false,
    });
    expect(fitSize({ width: 1920, height: 1080 }, MAC)).toEqual({
      size: { width: 1728, height: 936 },
      clipped: true,
    });
    expect(fitSize({ width: 5000, height: 400 }).clipped).toBe(false);
  });

  it('has 1280 x 800 by default, and config.yaml can change it', () => {
    expect(DEFAULT_WINDOW).toEqual({ width: 1280, height: 800 });
    const dir = tempDir('window-config');
    expect(loadConfig(dir).browser.window).toEqual({ width: 1280, height: 800 });
    mkdirSync(join(dir, '.walkthrough'));
    writeFileSync(
      join(dir, '.walkthrough', 'config.yaml'),
      'browser:\n  window: { width: 1440, height: 900 }\n',
    );
    expect(loadConfig(dir).browser.window).toEqual({ width: 1440, height: 900 });
  });

  it('accepts a window in a plan, within limits', () => {
    const plan = (w: number, h: number) =>
      validatePlanText(
        `name: W\nbrowser: { window: { width: ${w}, height: ${h} } }\nsteps:\n  - do: x\n`,
      ).ok;
    expect(plan(1440, 900)).toBe(true);
    expect(plan(300, 900)).toBe(false);
    expect(plan(1440, 9000)).toBe(false);
  });

  it('knows the page size of devices', () => {
    expect(deviceSize('desktop')).toEqual({ width: 1440, height: 900 });
    expect(deviceSize('mobile')?.width).toBe(393);
    expect(deviceSize('default')).toBeUndefined();
    expect(deviceSize(undefined)).toBeUndefined();
  });

  it('turns devices to portrait or landscape', () => {
    const phone = orientedDevice('mobile', 'landscape');
    expect(phone?.name).toBe('iPhone 15 landscape');
    expect(phone?.device?.viewport.isLandscape).toBe(true);
    expect(orientedDevice('mobile', 'portrait')?.name).toBe('iPhone 15');
    expect(orientedDevice('iPhone 15 landscape', 'portrait')?.name).toBe('iPhone 15');
    expect(deviceSize('desktop', 'portrait')).toEqual({ width: 900, height: 1440 });
    expect(deviceSize('desktop', 'landscape')).toEqual({ width: 1440, height: 900 });
    const turned = deviceSize('mobile', 'landscape');
    expect((turned?.width ?? 0) > (turned?.height ?? 0)).toBe(true);
    expect(orientedDevice(undefined, 'landscape')).toBeUndefined();
    expect(describeEmulation({ device: 'mobile', orientation: 'landscape' }, true)).toBe(
      'device: mobile, orientation: landscape',
    );
  });

  it('uses the page size of the run in an exported script', () => {
    const run: Run = {
      version: 1,
      id: 'r',
      name: 'W',
      mode: 'interactive',
      status: 'finished',
      startedAt: '2026-10-17T10:00:00.000Z',
      baseUrl: 'http://localhost:4321',
      window: { width: 1024, height: 700 },
      steps: [],
    };
    expect(exportScript(run).code).toContain(
      'await page.setViewport({ width: 1024, height: 700, deviceScaleFactor: 1 });',
    );
    const turned = exportScript({
      ...run,
      emulation: { device: 'mobile', orientation: 'landscape' },
    }).code;
    expect(turned).toContain('// Screen: mobile (landscape).');
    expect(turned).toContain('"isLandscape":true');
  });
});
