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
    screenshot: z.boolean().optional().describe('Save a screenshot after this step.'),
    visual: z
      .boolean()
      .optional()
      .describe('Compare a screenshot with the saved baseline (Phase 5).'),
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
    device: z.string().optional().describe('Screen preset, like "mobile" (Phase 5).'),
    colorScheme: z.enum(['light', 'dark']).optional().describe('Light or dark mode (Phase 5).'),
    network: z
      .enum(['normal', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g', 'offline'])
      .optional()
      .describe('Network speed (Phase 5).'),
    session: z.string().optional().describe('A saved login to use (Phase 5).'),
    steps: z.array(stepSchema).min(1, 'A plan needs at least one step.'),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof stepSchema>;

// Keys that a later phase makes work. Until then, a run stops with a clear message.
export const LATER_KEYS: Record<string, string> = {
  device: 'Phase 5',
  colorScheme: 'Phase 5',
  network: 'Phase 5',
  session: 'Phase 5',
};
export const LATER_STEP_KEYS: Record<string, string> = { visual: 'Phase 5' };

// JSON Schema for editors, from the same rules.
export function planJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(planSchema, { target: 'draft-7' }) as Record<string, unknown>),
    title: 'Walkthrough test plan',
  };
}
