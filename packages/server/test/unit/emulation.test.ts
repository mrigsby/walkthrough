import { describe, expect, it } from 'vitest';
import {
  checkEmulation,
  describeEmulation,
  mediaFeatures,
  withoutDefaults,
} from '../../src/browser/devices.js';
import { mergeEmulation, permissionEntries } from '../../src/browser/emulation-schema.js';

describe('emulation settings', () => {
  it('merges settings, and merges permissions one by one', () => {
    const merged = mergeEmulation(
      { device: 'mobile', permissions: { notifications: 'grant' } },
      { timezone: 'Asia/Tokyo', device: undefined, permissions: { clipboard: 'deny' } },
    );
    expect(merged).toEqual({
      device: 'mobile',
      timezone: 'Asia/Tokyo',
      permissions: { notifications: 'grant', clipboard: 'deny' },
    });
  });

  it('turns settings into Chrome permissions', () => {
    expect(permissionEntries({ geolocation: { latitude: 1, longitude: 2 } })).toEqual([
      { permission: { name: 'geolocation' }, state: 'granted' },
    ]);
    expect(permissionEntries({ geolocation: 'off' })[0]?.state).toBe('denied');
    expect(
      permissionEntries({ permissions: { clipboard: 'grant' } }).map((e) => e.permission.name),
    ).toEqual(['clipboard-read', 'clipboard-write']);
  });

  it('keeps the color scheme and reduced motion together', () => {
    expect(mediaFeatures({ colorScheme: 'dark', reducedMotion: 'reduce' })).toEqual([
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    expect(mediaFeatures({ colorScheme: 'system' })).toEqual([]);
  });

  it('explains a bad time zone, locale, or device', () => {
    expect(() => checkEmulation({ timezone: 'Mars/Olympus' })).toThrow(/not a time zone/);
    expect(() => checkEmulation({ locale: 'not a locale!' })).toThrow(/not a locale/);
    expect(() => checkEmulation({ device: 'toaster' })).toThrow(/no device/);
    expect(() => checkEmulation({ timezone: 'Europe/Berlin', locale: 'de-DE' })).not.toThrow();
  });

  it('leaves out settings that match a plain browser', () => {
    expect(
      withoutDefaults({ colorScheme: 'system', cpu: 1, device: 'mobile', media: 'screen' }),
    ).toEqual({
      device: 'mobile',
    });
  });

  it('describes all settings, or only the ones that are set', () => {
    expect(describeEmulation({})).toBe('device: default, color scheme: system, network: normal');
    expect(describeEmulation({ cpu: 4, timezone: 'Asia/Tokyo' }, true)).toBe(
      'CPU: 4x slower, time zone: Asia/Tokyo',
    );
  });
});
