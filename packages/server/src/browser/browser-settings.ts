import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

// Browser settings for config.yaml and for a plan. See docs/config.md.

// The size of the page area of a visible window, and of the page in headless Chrome.
export const windowSchema = z
  .object({
    width: z.number().int().min(500).max(3840).describe('Width in screen points, like 1280.'),
    height: z.number().int().min(400).max(2160).describe('Height in screen points, like 800.'),
  })
  .strict()
  .describe('The size of the page area, like { width: 1280, height: 800 }. The window fits it.');

export type WindowSize = z.infer<typeof windowSchema>;

export const DEFAULT_WINDOW: WindowSize = { width: 1280, height: 800 };

// The screen that a window is on. The frame is the space that tabs and toolbars take.
export interface ScreenSize {
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
}

// The page area that fits on the screen. Chrome keeps a window's height on the screen,
// but not its width, so both are checked here.
export function fitSize(
  wanted: WindowSize,
  screen?: ScreenSize,
): { size: WindowSize; clipped: boolean } {
  if (!screen) return { size: wanted, clipped: false };
  const width = Math.min(wanted.width, screen.width - screen.frameWidth);
  const height = Math.min(wanted.height, screen.height - screen.frameHeight);
  return {
    size: { width, height },
    clipped: width < wanted.width || height < wanted.height,
  };
}

const HOST = /^[A-Za-z0-9*]([A-Za-z0-9-.*]*[A-Za-z0-9])?$/;

export const browserFields = {
  window: windowSchema.optional(),
  autofill: z
    .boolean()
    .optional()
    .describe('Chrome offers to save and fill addresses and cards. Default: false.'),
  passwords: z
    .boolean()
    .optional()
    .describe('Chrome offers to save passwords and checks them for leaks. Default: false.'),
  permissionPrompts: z
    .enum(['deny', 'ask'])
    .optional()
    .describe(
      'deny (default): Chrome says no to camera, location, and notification questions. emulate permissions still grant them. ask: Chrome asks.',
    ),
  spellcheck: z
    .boolean()
    .optional()
    .describe('Red lines under words that Chrome thinks are wrong. Default: false.'),
  keepFocus: z
    .boolean()
    .optional()
    .describe(
      'The page acts as if it has focus when you click in another window, so menus stay open. Default: true.',
    ),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language tag, like "de-DE".')
    .optional()
    .describe('The language of Chrome and of the Accept-Language header, like "de-DE".'),
  downloads: z
    .boolean()
    .optional()
    .describe(
      'Save downloads in the run folder with no Save dialog, and list them in the report. Default: false.',
    ),
  fakeMedia: z
    .boolean()
    .optional()
    .describe('A fake camera and microphone, with no question. Default: false.'),
  autoplay: z
    .boolean()
    .optional()
    .describe('Video and sound can play without a click. Default: false.'),
  thirdPartyCookies: z
    .enum(['allow', 'block'])
    .optional()
    .describe('Cookies of other sites in frames. Default: allow.'),
  fontSize: z
    .object({
      default: z.number().int().min(6).max(72).optional().describe('Like 16 (the Chrome default).'),
      minimum: z.number().int().min(0).max(72).optional().describe('Text is never smaller.'),
    })
    .strict()
    .optional()
    .describe('Chrome font sizes, to test larger text.'),
  zoom: z
    .number()
    .min(0.25)
    .max(5)
    .optional()
    .describe('Page zoom for the sites of the app, like 1.25.'),
  devtools: z
    .union([
      z.boolean(),
      z
        .object({
          dock: z
            .enum(['right', 'bottom', 'window'])
            .optional()
            .describe('Where DevTools shows. window: in a window of its own. Default: right.'),
          deviceToolbar: z
            .boolean()
            .optional()
            .describe(
              "Show DevTools' device toolbar. Then DevTools controls the page size, and emulate cannot set a device.",
            ),
        })
        .strict(),
    ])
    .optional()
    .describe('Open DevTools in each tab. A visible browser only.'),
  extensions: z
    .array(z.string().min(1))
    .optional()
    .describe('Folders of unpacked extensions, like React DevTools. From the project folder.'),
  hosts: z
    .record(
      z.string().regex(HOST, 'Use a host name, like "api.example.com".'),
      z.string().regex(HOST, 'Use an address or a host name, like "127.0.0.1".'),
    )
    .optional()
    .describe('Send a host name to another address, like { "api.example.com": "127.0.0.1" }.'),
  secureOrigins: z
    .array(z.url())
    .optional()
    .describe(
      'http sites that Chrome treats as secure, like "http://dev.test:8080", so the clipboard and service workers work there.',
    ),
  automationBar: z
    .boolean()
    .optional()
    .describe('The "controlled by automated test software" bar. Default: true.'),
};

export const browserSchema = z.object(browserFields).strict();
export type BrowserOptions = z.infer<typeof browserSchema>;

// The browser block of a plan. It wins over the block in config.yaml, key by key.
export const planBrowserSchema = browserSchema;
export type PlanBrowser = BrowserOptions;

// All settings, with the defaults filled in.
export interface BrowserSettings {
  window: WindowSize;
  autofill: boolean;
  passwords: boolean;
  permissionPrompts: 'deny' | 'ask';
  spellcheck: boolean;
  keepFocus: boolean;
  language?: string;
  downloads: boolean;
  fakeMedia: boolean;
  autoplay: boolean;
  thirdPartyCookies: 'allow' | 'block';
  fontSize?: { default?: number; minimum?: number };
  zoom?: number;
  devtools?: { dock: 'right' | 'bottom' | 'window'; deviceToolbar: boolean };
  // Full paths.
  extensions: string[];
  hosts: Record<string, string>;
  secureOrigins: string[];
  automationBar: boolean;
}

export function resolveBrowserSettings(
  layers: Array<BrowserOptions | undefined>,
  projectDir: string,
): BrowserSettings {
  const o: BrowserOptions = Object.assign({}, ...layers.filter(Boolean));
  const devtools =
    o.devtools === true
      ? { dock: 'right' as const, deviceToolbar: false }
      : o.devtools
        ? { dock: o.devtools.dock ?? 'right', deviceToolbar: o.devtools.deviceToolbar ?? false }
        : undefined;
  return {
    window: o.window ?? DEFAULT_WINDOW,
    autofill: o.autofill ?? false,
    passwords: o.passwords ?? false,
    permissionPrompts: o.permissionPrompts ?? 'deny',
    spellcheck: o.spellcheck ?? false,
    keepFocus: o.keepFocus ?? true,
    ...(o.language ? { language: o.language } : {}),
    downloads: o.downloads ?? false,
    fakeMedia: o.fakeMedia ?? false,
    autoplay: o.autoplay ?? false,
    thirdPartyCookies: o.thirdPartyCookies ?? 'allow',
    ...(o.fontSize ? { fontSize: o.fontSize } : {}),
    ...(o.zoom && o.zoom !== 1 ? { zoom: o.zoom } : {}),
    ...(devtools ? { devtools } : {}),
    extensions: (o.extensions ?? []).map((p) => (isAbsolute(p) ? p : resolve(projectDir, p))),
    hosts: o.hosts ?? {},
    secureOrigins: o.secureOrigins ?? [],
    automationBar: o.automationBar ?? true,
  };
}

// What Chrome needs at launch for these settings.
export interface LaunchPlan {
  args: string[];
  prefs: Record<string, unknown>;
  ignoreDefaultArgs: string[];
  devtools: boolean;
  extensions: string[];
}

// Turns settings into Chrome flags and profile prefs. zoomHosts are the sites of the app.
export function launchPlan(
  settings: BrowserSettings,
  options: { headless: boolean; zoomHosts?: string[] },
): LaunchPlan {
  const args: string[] = [];
  const prefs: Record<string, unknown> = {};
  const put = (path: string, value: unknown) => {
    const keys = path.split('.');
    let at = prefs;
    for (const key of keys.slice(0, -1)) {
      at[key] ??= {};
      at = at[key] as Record<string, unknown>;
    }
    at[keys.at(-1) as string] = value;
  };
  // The password manager is off by default. Its "Change your password" dialog blocks clicks.
  put('credentials_enable_service', settings.passwords);
  put('profile.password_manager_enabled', settings.passwords);
  put('profile.password_manager_leak_detection', false);
  if (!settings.autofill) {
    put('autofill.profile_enabled', false);
    put('autofill.credit_card_enabled', false);
  }
  if (!settings.spellcheck) put('browser.enable_spellchecking', false);
  if (settings.permissionPrompts === 'deny') args.push('--deny-permission-prompts');
  if (settings.language) {
    args.push(`--lang=${settings.language}`);
    const base = settings.language.split('-')[0];
    put(
      'intl.accept_languages',
      base && base !== settings.language ? `${settings.language},${base}` : settings.language,
    );
  }
  if (settings.fakeMedia) {
    args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
  }
  if (settings.autoplay) args.push('--autoplay-policy=no-user-gesture-required');
  // 1 blocks the cookies of other sites. Chrome's own default blocks them only in incognito.
  if (settings.thirdPartyCookies === 'block') put('profile.cookie_controls_mode', 1);
  if (settings.fontSize?.default)
    put('webkit.webprefs.default_font_size', settings.fontSize.default);
  if (settings.fontSize?.minimum !== undefined)
    put('webkit.webprefs.minimum_font_size', settings.fontSize.minimum);
  if (settings.zoom && options.zoomHosts?.length) {
    // A zoom level is a power of 1.2. The time is in microseconds since 1601.
    const level = Math.log(settings.zoom) / Math.log(1.2);
    const modified = String((BigInt(Date.now()) + 11_644_473_600_000n) * 1000n);
    put(
      'partition.per_host_zoom_levels.x',
      Object.fromEntries(
        options.zoomHosts.map((host) => [host, { zoom_level: level, last_modified: modified }]),
      ),
    );
  }
  const hosts = Object.entries(settings.hosts);
  if (hosts.length) {
    args.push(`--host-resolver-rules=${hosts.map(([from, to]) => `MAP ${from} ${to}`).join(', ')}`);
  }
  if (settings.secureOrigins.length) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${settings.secureOrigins.join(',')}`);
  }
  const devtools = Boolean(settings.devtools) && !options.headless;
  if (devtools && settings.devtools) {
    // DevTools saves its own settings in the profile. JSON text, so strings have quotes.
    const dock = settings.devtools.dock === 'window' ? 'undocked' : settings.devtools.dock;
    put('devtools.preferences', {
      currentDockState: JSON.stringify(dock),
      ...(settings.devtools.deviceToolbar ? { 'emulation.show-device-mode': 'true' } : {}),
    });
  }
  return {
    args,
    prefs,
    ignoreDefaultArgs: settings.automationBar ? [] : ['--enable-automation'],
    devtools,
    extensions: settings.extensions,
  };
}

// The settings that need a new browser to change, as text that is the same for the same
// settings. The window, keepFocus, and downloads change in a browser that is open.
export function launchKey(settings: BrowserSettings, headless: boolean): string {
  const { window: _w, keepFocus: _k, downloads: _d, ...rest } = settings;
  return JSON.stringify({ ...rest, devtools: headless ? undefined : rest.devtools });
}

// Plan keys that change what a page does. A rehearsal with other values is not the same.
export const PAGE_KEYS = [
  'language',
  'zoom',
  'fontSize',
  'hosts',
  'secureOrigins',
  'thirdPartyCookies',
  'fakeMedia',
  'autoplay',
  'permissionPrompts',
] as const;

// The settings that change what a page does. Presentations and exported scripts use them.
export function pageSettings(settings: BrowserSettings): Partial<BrowserSettings> {
  const out: Partial<BrowserSettings> = {};
  if (settings.language) out.language = settings.language;
  if (settings.zoom) out.zoom = settings.zoom;
  if (settings.fontSize) out.fontSize = settings.fontSize;
  if (Object.keys(settings.hosts).length) out.hosts = settings.hosts;
  if (settings.secureOrigins.length) out.secureOrigins = settings.secureOrigins;
  if (settings.thirdPartyCookies === 'block') out.thirdPartyCookies = 'block';
  if (settings.fakeMedia) out.fakeMedia = true;
  if (settings.autoplay) out.autoplay = true;
  if (settings.permissionPrompts === 'ask') out.permissionPrompts = 'ask';
  return out;
}

// Settings in plain words, for doctor and run_start.
export function describeBrowserSettings(settings: BrowserSettings): string {
  const parts = [
    `page ${settings.window.width} x ${settings.window.height}`,
    `autofill ${settings.autofill ? 'on' : 'off'}`,
    `save passwords ${settings.passwords ? 'on' : 'off'}`,
    `permission prompts ${settings.permissionPrompts === 'deny' ? 'denied' : 'shown'}`,
    `spellcheck ${settings.spellcheck ? 'on' : 'off'}`,
    `keep focus ${settings.keepFocus ? 'on' : 'off'}`,
  ];
  if (settings.language) parts.push(`language ${settings.language}`);
  if (settings.downloads) parts.push('downloads to the run folder');
  if (settings.fakeMedia) parts.push('fake camera and microphone');
  if (settings.autoplay) parts.push('autoplay');
  if (settings.thirdPartyCookies === 'block') parts.push('third-party cookies blocked');
  if (settings.fontSize?.default) parts.push(`font size ${settings.fontSize.default}`);
  if (settings.fontSize?.minimum) parts.push(`minimum font size ${settings.fontSize.minimum}`);
  if (settings.zoom) parts.push(`zoom ${settings.zoom}`);
  if (settings.devtools)
    parts.push(
      `DevTools (${settings.devtools.dock}${settings.devtools.deviceToolbar ? ', device toolbar' : ''})`,
    );
  if (settings.extensions.length) parts.push(`${settings.extensions.length} extension(s)`);
  const hosts = Object.entries(settings.hosts);
  if (hosts.length) parts.push(`hosts ${hosts.map(([a, b]) => `${a} -> ${b}`).join(', ')}`);
  if (settings.secureOrigins.length)
    parts.push(`secure origins ${settings.secureOrigins.join(', ')}`);
  if (!settings.automationBar) parts.push('no automation bar');
  return parts.join(', ');
}
