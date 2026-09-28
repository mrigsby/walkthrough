import { z } from 'zod';

// Emulation settings. The emulate tool and plans share them.
export const NETWORKS = ['normal', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g', 'offline'] as const;
export type NetworkName = (typeof NETWORKS)[number];
export type ColorScheme = 'light' | 'dark' | 'system';

const permission = z.enum(['grant', 'deny', 'prompt']);

export const emulationFields = {
  device: z
    .string()
    .optional()
    .describe(
      'desktop, laptop, tablet, mobile, default, or a Puppeteer device name like "Pixel 5".',
    ),
  colorScheme: z.enum(['light', 'dark', 'system']).optional().describe('Light or dark mode.'),
  network: z.enum(NETWORKS).optional().describe('Network speed.'),
  cpu: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('Make the CPU slower by this factor, like 4. 1 is normal speed.'),
  timezone: z.string().min(1).optional().describe('A time zone like "Europe/Berlin", or "system".'),
  locale: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A language and region like "de-DE", or "system". It changes date and number formats and the Accept-Language header.',
    ),
  geolocation: z
    .union([
      z.literal('off'),
      z
        .object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracy: z.number().min(0).optional(),
        })
        .strict(),
    ])
    .optional()
    .describe(
      'A place like { latitude: 52.52, longitude: 13.4 }. It also allows location for the login. "off" blocks location for the login.',
    ),
  reducedMotion: z
    .enum(['reduce', 'no-preference', 'system'])
    .optional()
    .describe('The prefers-reduced-motion setting.'),
  media: z
    .enum(['screen', 'print'])
    .optional()
    .describe('Show the page as on screen or as printed.'),
  permissions: z
    .object({
      geolocation: permission.optional(),
      notifications: permission.optional(),
      clipboard: permission.optional(),
    })
    .strict()
    .optional()
    .describe('Browser permissions. They apply to every tab of the same login.'),
};

export const emulationSchema = z.object(emulationFields).strict();
export type Emulation = z.infer<typeof emulationSchema>;
export type PermissionChoice = z.infer<typeof permission>;

// Joins two sets of settings. Later values win, and permissions merge one by one.
export function mergeEmulation(base: Emulation, change: Emulation): Emulation {
  const out: Emulation = { ...base };
  for (const [key, value] of Object.entries(change)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (change.permissions) out.permissions = { ...base.permissions, ...change.permissions };
  return out;
}

const PERMISSION_STATE = { grant: 'granted', deny: 'denied', prompt: 'prompt' } as const;
const PERMISSION_NAMES: Record<string, string[]> = {
  geolocation: ['geolocation'],
  notifications: ['notifications'],
  clipboard: ['clipboard-read', 'clipboard-write'],
};

// Chrome permissions for the settings. A place also needs the location permission.
export function permissionEntries(
  change: Emulation,
): { permission: { name: string }; state: 'granted' | 'denied' | 'prompt' }[] {
  const wanted: Record<string, PermissionChoice> = {};
  if (change.geolocation !== undefined)
    wanted.geolocation = change.geolocation === 'off' ? 'deny' : 'grant';
  Object.assign(wanted, change.permissions);
  return Object.entries(wanted).flatMap(([name, choice]) =>
    (PERMISSION_NAMES[name] ?? []).map((permission) => ({
      permission: { name: permission },
      state: PERMISSION_STATE[choice],
    })),
  );
}
