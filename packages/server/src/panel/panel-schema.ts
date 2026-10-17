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
      command: label('the terminal command of the step. The default is "Run this command"'),
    })
    .strict()
    .optional()
    .describe('Labels of the parts of the panel.'),
  buttons: z
    .object({
      pass: button.optional(),
      bug: optionalButton.optional(),
      skip: optionalButton.optional(),
      retry: optionalButton.optional(),
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
    progress: z
      .boolean()
      .optional()
      .describe(
        'A list of all steps and their results. A button in the panel header shows it. Default: true.',
      ),
    shortcuts: z
      .boolean()
      .optional()
      .describe('Answer with Alt+Shift+P, B, S, R, and X (Option+Shift on a Mac). Default: true.'),
  })
  .strict();

// Snippets that panel text shows with {{copy:name}}. The developer copies them with a button.
const SECRET = /\{\{\s*secret:/;
const noSecret = (text: string) => !SECRET.test(text);
const SECRET_MESSAGE = 'A snippet cannot hold a {{secret:NAME}}. Walkthrough never copies secrets.';

const snippetCode = z
  .string()
  .min(1)
  .max(4000)
  .refine(noSecret, SECRET_MESSAGE)
  .describe('The text to copy, like a terminal command.');

export const snippetSchema = z.union(
  [
    snippetCode,
    z
      .object({
        code: snippetCode,
        help: z
          .string()
          .max(4000)
          .refine(noSecret, SECRET_MESSAGE)
          .optional()
          .describe('More about the snippet. A "?" next to the copy button shows it.'),
      })
      .strict(),
  ],
  { error: 'A snippet is the text to copy, or { code, help }.' },
);

export const snippetsSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, "-", and "_" in a snippet name.'),
    snippetSchema,
  )
  .describe('Snippets for {{copy:name}} in panel text, like { seed: "npm run db:seed" }.');

export type Snippets = z.infer<typeof snippetsSchema>;

// A command that the developer runs in a terminal, or that the agent runs after the
// developer says yes. Walkthrough itself never runs it.
const COMMAND_SECRET = 'A command cannot hold a {{secret:NAME}}. Walkthrough never copies secrets.';
const commandText = z.string().min(1).max(2000).refine(noSecret, COMMAND_SECRET);

export const commandSchema = z.union(
  [
    commandText,
    z
      .object({
        run: commandText.describe('The command, like "npm run db:seed".'),
        help: z
          .string()
          .max(4000)
          .refine(noSecret, COMMAND_SECRET)
          .optional()
          .describe('What the command does. A "?" button shows it.'),
      })
      .strict(),
  ],
  { error: 'A command is the text to run, or { run, help }.' },
);
export type StepCommand = z.infer<typeof commandSchema>;

export type StepPanel = z.infer<typeof stepPanelSchema>;
export type PlanPanel = z.infer<typeof planPanelSchema>;
