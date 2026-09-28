import {
  type CDPSession,
  type Device,
  KnownDevices,
  type Page,
  PredefinedNetworkConditions,
} from 'puppeteer-core';
import { ToolError } from '../errors.js';
import type { Emulation } from './emulation-schema.js';

export {
  type ColorScheme,
  type Emulation,
  NETWORKS,
  type NetworkName,
} from './emulation-schema.js';

// Screen presets. Each is a size, or the name of a Puppeteer device.
export const DEVICE_PRESETS: Record<string, { width: number; height: number } | string> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: 'iPad Pro 11',
  mobile: 'iPhone 15',
};

export const NETWORK_PRESETS: Record<string, keyof typeof PredefinedNetworkConditions> = {
  'slow-3g': 'Slow 3G',
  'fast-3g': 'Fast 3G',
  'slow-4g': 'Slow 4G',
  'fast-4g': 'Fast 4G',
};

interface ResolvedDevice {
  label: string;
  device?: Device;
  size?: { width: number; height: number };
}

// Finds a preset or a Puppeteer device by name. "default" means no emulation.
export function resolveDevice(name: string): ResolvedDevice | undefined {
  const key = name.trim();
  if (['default', 'none', 'off'].includes(key.toLowerCase())) return undefined;
  const preset = DEVICE_PRESETS[key.toLowerCase()];
  if (typeof preset === 'object') return { label: key.toLowerCase(), size: preset };
  const deviceName = typeof preset === 'string' ? preset : key;
  const match = Object.keys(KnownDevices).find((d) => d.toLowerCase() === deviceName.toLowerCase());
  if (!match) {
    throw new ToolError(
      `There is no device "${name}". Use desktop, laptop, tablet, mobile, default, or a Puppeteer device name like "Pixel 5".`,
      'bad_input',
    );
  }
  return {
    label: typeof preset === 'string' ? key.toLowerCase() : match,
    device: KnownDevices[match as keyof typeof KnownDevices],
  };
}

// Chrome refuses a time zone or a locale it does not know. Say so clearly first.
export function checkEmulation(emulation: Emulation): void {
  if (emulation.device !== undefined) resolveDevice(emulation.device);
  const zone = emulation.timezone;
  if (zone && zone !== 'system') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      throw new ToolError(
        `"${zone}" is not a time zone. Use a name like "Europe/Berlin" or "America/New_York".`,
        'bad_input',
      );
    }
  }
  const locale = emulation.locale;
  if (locale && locale !== 'system') {
    try {
      Intl.getCanonicalLocales(locale);
    } catch {
      throw new ToolError(
        `"${locale}" is not a locale. Use a tag like "de-DE" or "en-GB".`,
        'bad_input',
      );
    }
  }
}

// Applies the changed settings to one tab. "full" is everything the tab has now.
// Returns true when the page must reload, because touch or mobile mode changed.
// Permissions belong to the login, so the driver sets them.
export async function applyEmulation(
  page: Page,
  change: Emulation,
  full: Emulation,
  options: { headless: boolean; userAgent: string; wasMobile: boolean; cdp?: CDPSession },
): Promise<{ needsReload: boolean; isMobile: boolean }> {
  let isMobile = options.wasMobile;
  if (change.device !== undefined) {
    const resolved = resolveDevice(change.device);
    if (resolved?.device) {
      await page.emulate(resolved.device);
      isMobile = Boolean(resolved.device.viewport.isMobile || resolved.device.viewport.hasTouch);
    } else {
      await page.setUserAgent(options.userAgent);
      const size = resolved?.size ?? (options.headless ? { width: 1280, height: 800 } : undefined);
      // No size means the page fills the visible window again.
      await page.setViewport(
        size ? { ...size, deviceScaleFactor: 1, isMobile: false, hasTouch: false } : null,
      );
      isMobile = false;
    }
  }
  if (
    change.colorScheme !== undefined ||
    change.reducedMotion !== undefined ||
    change.media !== undefined
  ) {
    await applyMedia(page, options.cdp, full);
  }
  if (change.network !== undefined) {
    // Speed first: setting the speed also turns offline mode off.
    const preset = NETWORK_PRESETS[change.network];
    await page.emulateNetworkConditions(preset ? PredefinedNetworkConditions[preset] : null);
    await page.setOfflineMode(change.network === 'offline');
  }
  if (change.cpu !== undefined) await page.emulateCPUThrottling(change.cpu > 1 ? change.cpu : null);
  if (change.timezone !== undefined)
    await page.emulateTimezone(change.timezone === 'system' ? undefined : change.timezone);
  if (change.locale !== undefined)
    await page.emulateLocale(change.locale === 'system' ? undefined : change.locale);
  if (change.geolocation !== undefined && change.geolocation !== 'off')
    await page.setGeolocation(change.geolocation);
  return { needsReload: isMobile !== options.wasMobile, isMobile };
}

// Sets the media type and the media features in one call. Chrome clears the one
// that a call leaves out, so separate calls would undo each other.
// The session must stay open: Chrome drops the setting when it closes.
export async function applyMedia(
  page: Page,
  cdp: CDPSession | undefined,
  emulation: Emulation,
): Promise<void> {
  const features = mediaFeatures(emulation);
  if (cdp) {
    await cdp.send('Emulation.setEmulatedMedia', {
      media: emulation.media === 'print' ? 'print' : '',
      features,
    });
    return;
  }
  await page.emulateMediaType(emulation.media === 'print' ? 'print' : undefined);
  await page.emulateMediaFeatures(features);
}

// The CSS media features that the settings ask for.
export function mediaFeatures(emulation: Emulation): { name: string; value: string }[] {
  const features: { name: string; value: string }[] = [];
  if (emulation.colorScheme && emulation.colorScheme !== 'system')
    features.push({ name: 'prefers-color-scheme', value: emulation.colorScheme });
  if (emulation.reducedMotion && emulation.reducedMotion !== 'system')
    features.push({ name: 'prefers-reduced-motion', value: emulation.reducedMotion });
  return features;
}

// The settings that differ from a plain browser. Lists show only these.
export function withoutDefaults(emulation: Emulation): Emulation {
  const plain: Record<string, unknown> = {
    device: 'default',
    colorScheme: 'system',
    network: 'normal',
    cpu: 1,
    timezone: 'system',
    locale: 'system',
    reducedMotion: 'system',
    media: 'screen',
  };
  return Object.fromEntries(
    Object.entries(emulation).filter(([key, value]) => value !== undefined && plain[key] !== value),
  ) as Emulation;
}

// Plain words for the settings of a tab. With onlySet, it skips settings that are not set.
export function describeEmulation(emulation: Emulation, onlySet = false): string {
  const parts = onlySet
    ? [
        emulation.device ? `device: ${emulation.device}` : '',
        emulation.colorScheme ? `color scheme: ${emulation.colorScheme}` : '',
        emulation.network ? `network: ${emulation.network}` : '',
      ].filter(Boolean)
    : [
        `device: ${emulation.device ?? 'default'}`,
        `color scheme: ${emulation.colorScheme ?? 'system'}`,
        `network: ${emulation.network ?? 'normal'}`,
      ];
  if (emulation.cpu === 1) parts.push('CPU: normal');
  if (emulation.cpu && emulation.cpu > 1) parts.push(`CPU: ${emulation.cpu}x slower`);
  if (emulation.timezone) parts.push(`time zone: ${emulation.timezone}`);
  if (emulation.locale) parts.push(`locale: ${emulation.locale}`);
  const place = emulation.geolocation;
  if (place)
    parts.push(`location: ${place === 'off' ? 'off' : `${place.latitude}, ${place.longitude}`}`);
  if (emulation.reducedMotion) parts.push(`reduced motion: ${emulation.reducedMotion}`);
  if (emulation.media) parts.push(`media: ${emulation.media}`);
  const perms = Object.entries(emulation.permissions ?? {});
  if (perms.length) parts.push(`permissions: ${perms.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return parts.join(', ');
}
