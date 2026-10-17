import { z } from 'zod';

// Panel settings for a plan, a step, or one ask_developer call. See docs/plan-format.md.

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, 'Use a hex color, like "#15803d".');

const label = (what: string) =>
  z.string().max(40).optional().describe(`The label above ${what}. "" shows no label.`);

const button = z
  .object({
    label: z.string().min(1).max(24).optional().describe('The text on the button.'),
    color: hexColor
      .optional()
      .describe('The button color. Walkthrough picks a text color that is easy to read on it.'),
  })
  .strict();

// A button that a plan can also hide.
const optionalButton = button
  .extend({ show: z.boolean().optional().describe('false hides the button.') })
  .strict();

const panelLayer = {
  labels: z
    .object({
      did: label('what the agent did. The default is "What I did"'),
      expect: label('what the developer should see. The default is "What you should see"'),
      next: label(`what comes next. The default is "What's next"`),
    })
    .strict()
    .optional()
    .describe('Labels of the parts of the panel.'),
  buttons: z
    .object({
      pass: button.optional(),
      bug: optionalButton.optional(),
      skip: optionalButton.optional(),
      stop: button.optional(),
    })
    .strict()
    .optional()
    .describe('Text and colors of the answer buttons, like { pass: { label: Done } }.'),
};

// For one step, or one ask_developer call.
export const stepPanelSchema = z
  .object({
    ...panelLayer,
    next: z
      .object({
        collapsed: z.boolean().optional().describe('Start with "What\'s next" closed.'),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CORNERS = ['bottom-right', 'bottom-left', 'top-left', 'top-right'] as const;

// For the whole plan.
export const planPanelSchema = z
  .object({
    ...panelLayer,
    next: z
      .object({
        collapsed: z
          .boolean()
          .optional()
          .describe('Start with "What\'s next" closed. Default: true.'),
        auto: z
          .boolean()
          .optional()
          .describe('A step without "next" shows the "do" of the next step.'),
      })
      .strict()
      .optional(),
    corner: z.enum(CORNERS).optional().describe('Where the panel starts. Default: bottom-right.'),
  })
  .strict();

export type StepPanel = z.infer<typeof stepPanelSchema>;
export type PlanPanel = z.infer<typeof planPanelSchema>;
