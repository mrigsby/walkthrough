import { type Device, KnownDevices, type Page, PredefinedNetworkConditions } from 'puppeteer-core';
import { ToolError } from '../errors.js';

// Screen presets. Each is a size, or the name of a Puppeteer device.
export const DEVICE_PRESETS: Record<string, { width: number; height: number } | string> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: 'iPad Pro 11',
  mobile: 'iPhone 15',
};

export const NETWORKS = ['normal', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g', 'offline'] as const;
export type NetworkName = (typeof NETWORKS)[number];
export type ColorScheme = 'light' | 'dark' | 'system';

const NETWORK_PRESETS: Record<string, keyof typeof PredefinedNetworkConditions> = {
  'slow-3g': 'Slow 3G',
  'fast-3g': 'Fast 3G',
  'slow-4g': 'Slow 4G',
  'fast-4g': 'Fast 4G',
};

export interface Emulation {
  device?: string;
  colorScheme?: ColorScheme;
  network?: NetworkName;
}

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

// Sets the screen, color scheme, and network for one tab.
// Returns true when the page must reload, because touch or mobile mode changed.
export async function applyEmulation(
  page: Page,
  emulation: Emulation,
  options: { headless: boolean; userAgent: string; wasMobile: boolean },
): Promise<{ needsReload: boolean; isMobile: boolean }> {
  let isMobile = options.wasMobile;
  if (emulation.device !== undefined) {
    const resolved = resolveDevice(emulation.device);
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
  if (emulation.colorScheme !== undefined) {
    await page.emulateMediaFeatures(
      emulation.colorScheme === 'system'
        ? []
        : [{ name: 'prefers-color-scheme', value: emulation.colorScheme }],
    );
  }
  if (emulation.network !== undefined) {
    // Speed first: setting the speed also turns offline mode off.
    const preset = NETWORK_PRESETS[emulation.network];
    await page.emulateNetworkConditions(preset ? PredefinedNetworkConditions[preset] : null);
    await page.setOfflineMode(emulation.network === 'offline');
  }
  return { needsReload: isMobile !== options.wasMobile, isMobile };
}

export function describeEmulation(emulation: Emulation): string {
  const parts = [
    `device: ${emulation.device ?? 'default'}`,
    `color scheme: ${emulation.colorScheme ?? 'system'}`,
    `network: ${emulation.network ?? 'normal'}`,
  ];
  return parts.join(', ');
}
