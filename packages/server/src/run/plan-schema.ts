import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

// How the agent checks each step.
export const MODES = ['interactive', 'checkpoints', 'autonomous'] as const;
export type Mode = (typeof MODES)[number];

// The element an exact action hint points at.
const target = z
  .object({
    role: z.string().optional().describe('ARIA role, like "button" or "textbox".'),
    name: z.string().optional().describe('The name the user sees, like "Checkout".'),
    selector: z.string().optional().describe('A CSS or Puppeteer selector.'),
    value: z.string().optional().describe('Text to type, option to choose, or key to press.'),
    files: z.array(z.string()).optional().describe('Files to upload, from the project folder.'),
  })
  .strict();

// An optional exact hint for a step. Use one key, like { click: { role: button, name: Checkout } }.
const action = z
  .object({
    navigate: z.string().optional().describe('A URL or a path like "/cart".'),
    click: target.optional(),
    dblclick: target.optional(),
    hover: target.optional(),
    fill: target.optional(),
    select: target.optional(),
    check: target.optional(),
    uncheck: target.optional(),
    press: target.optional(),
    scroll: target.optional(),
    upload: target.optional(),
    wait: z.string().optional().describe('Text to wait for on the page.'),
  })
  .strict()
  .refine((value) => Object.keys(value).length === 1, {
    message: 'Use exactly one action, like "click" or "fill".',
  })
  .describe('An exact action for this step. The agent uses it instead of guessing.');

// Image types that a screenshot file can have. The extension sets the type.
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

const imagePath = z
  .string()
  .min(1)
  .regex(/\.(png|jpe?g|webp)$/i, 'End the path with .png, .jpg, .jpeg, or .webp.')
  .describe('Where to save the file, from the project folder or from screenshotDir.');

const screenshot = z
  .union(
    [
      z.boolean(),
      imagePath,
      z
        .object({
          path: imagePath,
          selector: z.string().optional().describe('Capture only this element.'),
          fullPage: z
            .boolean()
            .optional()
            .describe('Capture the whole page, not only the visible part.'),
        })
        .strict(),
    ],
    {
      error: 'Use true, a file path like "docs/images/cart.png", or { path, selector, fullPage }.',
    },
  )
  .describe(
    'Save a screenshot after this step. true saves it with the run. A path saves it to that exact file, and replaces the file if it exists.',
  );

export const stepSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'Use lowercase letters, numbers, and dashes, like "open-cart".',
      )
      .optional()
      .describe('A short id for the step. Reports and scripts use it.'),
    do: z.string().min(1).describe('What to do, in plain words.'),
    expect: z
      .string()
      .optional()
      .describe('What the developer should see after the step. Make it specific.'),
    checkpoint: z
      .boolean()
      .optional()
      .describe('In checkpoints mode, ask the developer to confirm this step.'),
    action: action.optional(),
    screenshot: screenshot.optional(),
    visual: z
      .boolean()
      .optional()
      .describe('Compare a screenshot with the saved baseline after this step.'),
  })
  .strict();

export const planSchema = z
  .object({
    name: z.string().min(1).describe('The name of the test.'),
    description: z.string().optional(),
    baseUrl: z.url().optional().describe('The start page. Overrides baseUrl in config.yaml.'),
    mode: z
      .enum(MODES)
      .optional()
      .describe(
        'interactive: confirm every step. checkpoints: confirm marked steps. autonomous: the agent checks each step.',
      ),
    device: z
      .string()
      .optional()
      .describe('Screen preset: desktop, laptop, tablet, mobile, or a Puppeteer device name.'),
    colorScheme: z.enum(['light', 'dark']).optional().describe('Light or dark mode.'),
    network: z
      .enum(['normal', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g', 'offline'])
      .optional()
      .describe('Network speed.'),
    session: z
      .string()
      .optional()
      .describe('A saved login to use. Save one with the session tool.'),
    screenshotDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The folder for step screenshot paths, from the project folder, like "docs/images/help".',
      ),
    steps: z.array(stepSchema).min(1, 'A plan needs at least one step.'),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof stepSchema>;

// A screenshot saved to an exact file.
export interface Capture {
  path: string;
  selector?: string;
  fullPage?: boolean;
}

// The exact-file screenshot of a step, with screenshotDir applied. Undefined for true or none.
export function stepCapture(
  plan: Pick<Plan, 'screenshotDir'>,
  step: PlanStep,
): Capture | undefined {
  const shot = step.screenshot;
  if (shot === undefined || typeof shot === 'boolean') return undefined;
  const capture = typeof shot === 'string' ? { path: shot } : { ...shot };
  // An absolute path ignores screenshotDir.
  if (plan.screenshotDir && !isAbsolute(capture.path)) {
    capture.path = join(plan.screenshotDir, capture.path);
  }
  return capture;
}

// Keys that a later phase makes work. Until then, a run stops with a clear message.
// Empty now. A future version can list new keys here before they work.
export const LATER_KEYS: Record<string, string> = {};
export const LATER_STEP_KEYS: Record<string, string> = {};

// JSON Schema for editors, from the same rules.
export function planJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(planSchema, { target: 'draft-7' }) as Record<string, unknown>),
    title: 'Walkthrough test plan',
  };
}
