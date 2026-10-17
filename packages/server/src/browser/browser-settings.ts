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

// The browser block of a plan. It wins over the block in config.yaml.
export const planBrowserSchema = z
  .object({
    window: windowSchema.optional(),
  })
  .strict();

export type PlanBrowser = z.infer<typeof planBrowserSchema>;
