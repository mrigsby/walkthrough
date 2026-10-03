import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { CHECKS, checksSchema, STANDARDS } from '../audit/standards.js';
import { emulationSchema } from '../browser/emulation-schema.js';
import { cookieCheckSchema } from '../devtools/cookie-schema.js';
import { mockRuleSchema } from '../devtools/mock-schema.js';
import { envNameSchema, varsSchema } from '../environments.js';
import { LH_CATEGORIES, LH_DEVICES, LH_MODES } from '../lighthouse/categories.js';
import { VIDEO_FORMATS } from '../video/formats.js';

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

const tabName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers, and dashes, like "customer".');

// Opens a new tab. It becomes the active tab.
const newTab = z
  .object({
    url: z.string().optional().describe('The page to open. A full URL, or a path like "/login".'),
    name: tabName.optional().describe('A name for the tab. Later steps switch to it by name.'),
    isolated: z
      .union([z.literal(true), tabName])
      .optional()
      .describe('true for a new login of its own. A name for a login that tabs share.'),
    session: z.string().optional().describe('A saved login to load into the tab.'),
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
    newTab: newTab.optional(),
    switchTab: z
      .union([
        z.string().min(1),
        z
          .object({
            tab: z.string().min(1).describe('A tab name, an id, or "newest".'),
            name: tabName.optional().describe('A name to give the tab.'),
          })
          .strict(),
      ])
      .optional()
      .describe(
        'The tab to use now: a name, or "newest" for the tab that opened last. { tab: newest, name: help } also names it.',
      ),
    closeTab: z.string().min(1).optional().describe('The name or id of the tab to close.'),
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

// A time like "45s", "10m", or "1h30m".
const DURATION = /^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const duration = z.string().regex(DURATION, 'Use a time like "45s", "10m", or "1h30m".');

export function durationSeconds(text: string): number {
  const m = DURATION.exec(text);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, 'Use a hex color, like "#000000".');

// Images that a slide can show.
export const SLIDE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'] as const;

const imageSlide = z
  .object({
    image: z
      .string()
      .min(1)
      .describe('An image file from the project folder, like ".walkthrough/slides/title.png".'),
    fit: z
      .enum(['contain', 'cover'])
      .optional()
      .describe(
        'contain shows all of the image (default). cover fills the window and can cut the edges.',
      ),
    background: hexColor.optional().describe('The color around the image. The default is black.'),
  })
  .strict();

const textSlide = z
  .object({
    title: z.string().min(1).max(120).describe('Big text in the middle of the screen.'),
    text: z.string().max(1000).optional().describe('Smaller text under the title.'),
    background: hexColor.optional().describe('The color of the slide. The default is dark gray.'),
    color: hexColor.optional().describe('The color of the text. The default is white.'),
  })
  .strict();

export const slideSchema = z
  .union([imageSlide, textSlide], {
    error: 'A slide has an "image", or a "title" with an optional "text".',
  })
  .describe('A slide that fills the audience window: an image, or a title with text.');
export type Slide = z.infer<typeof slideSchema>;

// How a plan plays as a live presentation. See docs/presentations.md.
export const presentationSchema = z
  .object({
    title: slideSchema
      .optional()
      .describe(
        'A slide before the presentation starts. It shows until the presenter clicks Start.',
      ),
    end: slideSchema
      .optional()
      .describe(
        'The last screen. Without it, the end screen shows the plan name and "Questions?".',
      ),
    pause: z
      .enum(['before', 'none'])
      .optional()
      .describe(
        'before (default): wait for the presenter before each step. none: go on by itself.',
      ),
    pace: z
      .enum(['slow', 'normal', 'fast'])
      .optional()
      .describe('How fast the pointer moves and the text types. The default is normal.'),
    pointer: z
      .boolean()
      .optional()
      .describe('Show a pointer that moves to each element. Default: true.'),
    spotlight: z
      .boolean()
      .optional()
      .describe(
        'During a pause, dim the page except the element of the next action. Default: true.',
      ),
    captions: z
      .boolean()
      .optional()
      .describe(
        'Show the caption of each step at the bottom of the audience screen. Default: true.',
      ),
    window: z
      .object({
        width: z.number().int().min(640).max(3840),
        height: z.number().int().min(480).max(2160),
      })
      .strict()
      .optional()
      .describe('The size of the audience window, like { width: 1920, height: 1080 }.'),
    pageZoom: z
      .number()
      .min(0.5)
      .max(3)
      .optional()
      .describe('Make the page bigger, like 1.25, so people at the back of the room can read it.'),
    fullscreen: z.boolean().optional().describe('Start the audience window in fullscreen.'),
    device: z
      .boolean()
      .optional()
      .describe(
        'Use the device of the plan, like mobile, on the audience screen. Default: the page fills the window.',
      ),
    mirror: z
      .boolean()
      .optional()
      .describe(
        'Show a small live picture of the audience screen in the presenter window. Default: true.',
      ),
    timeBudget: duration
      .optional()
      .describe(
        'The time for the whole presentation, like "10m". The presenter window warns when it is over.',
      ),
    mask: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'CSS selectors of things to blur on the audience screen, like customer names. Secret fields are always blurred.',
      ),
    record: z
      .union([
        z.boolean(),
        z
          .object({
            format: z.enum(VIDEO_FORMATS).optional().describe('mp4, webm, or gif.'),
            path: z
              .string()
              .min(1)
              .regex(/\.(mp4|webm|gif)$/i, 'End the path with .mp4, .webm, or .gif.')
              .optional()
              .describe('Also save the video to this file, from the project folder.'),
          })
          .strict(),
      ])
      .optional()
      .describe('Record the audience screen as a video.'),
    kiosk: z
      .object({
        holdSeconds: z
          .number()
          .min(1)
          .max(600)
          .optional()
          .describe('How long each step and slide shows. The default is 6.'),
        loop: z.boolean().optional().describe('Start again at the title after the end screen.'),
        loops: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Stop after this many loops. The default is 100.'),
      })
      .strict()
      .optional()
      .describe('Run without a presenter, such as on a screen at a booth.'),
  })
  .strict()
  .refine((p) => !(p.kiosk && p.record), {
    message: 'A kiosk presentation cannot record a video. Remove "record" or "kiosk".',
    path: ['record'],
  });
export type PresentationSettings = z.infer<typeof presentationSchema>;

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
    emulate: emulationSchema
      .optional()
      .describe(
        'Settings for the tab of this step, like { device: mobile }. They apply before the step.',
      ),
    cookies: z
      .array(cookieCheckSchema)
      .min(1)
      .optional()
      .describe('Cookie checks after this step, like [{ name: session, httpOnly: true }].'),
    mock: z
      .union([z.literal('off'), z.array(mockRuleSchema).min(1)])
      .optional()
      .describe(
        'Mock rules to add before this step, like [{ url: /api/stock, status: 500 }]. They stay on for later steps. "off" removes all mocks.',
      ),
    a11y: z
      .union([
        z.literal(true),
        z
          .object({
            selector: z.string().min(1).optional().describe('Check only this part of the page.'),
            checks: z
              .array(z.enum(CHECKS))
              .optional()
              .describe('Extra checks for this step, like [keyboard, darkMode].'),
          })
          .strict(),
      ])
      .optional()
      .describe('Check accessibility after this step.'),
    caption: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('The text viewers see in a video of this step. Without it, videos show "do".'),
    lighthouse: z
      .enum(LH_MODES)
      .optional()
      .describe(
        'Measure this step with Lighthouse. navigation: Lighthouse loads the page of the navigate action. timespan: it measures what the step does. snapshot: it checks the page after the step.',
      ),
    notes: z
      .string()
      .max(4000)
      .optional()
      .describe('Notes for the presenter. Only the presenter window shows them.'),
    pause: z
      .boolean()
      .optional()
      .describe(
        'In a presentation, wait for the presenter before this step. false goes on by itself. The default comes from presentation.pause.',
      ),
    slide: slideSchema
      .optional()
      .describe(
        'A slide before the action of this step, or the whole step when it has no action. Test runs skip a step that is only a slide.',
      ),
    spotlight: z
      .boolean()
      .optional()
      .describe(
        'In a presentation, dim the page except the element of this step during the pause.',
      ),
    zoom: z
      .number()
      .min(1.25)
      .max(4)
      .optional()
      .describe(
        'In a presentation, show the area of the next action this many times bigger during the pause.',
      ),
    timeBudget: duration
      .optional()
      .describe('The time for this step in a presentation, like "45s".'),
  })
  .strict()
  .refine((step) => step.lighthouse !== 'navigation' || Boolean(step.action?.navigate), {
    message:
      'A navigation step needs a page to load, like action: { navigate: / }. For a page that opens after a click, use timespan.',
    path: ['lighthouse'],
  });

export const planSchema = z
  .object({
    name: z.string().min(1).describe('The name of the test.'),
    description: z.string().optional(),
    baseUrl: z
      .union([z.url(), z.string().regex(/^\/(?!\/)/)], {
        error: 'Use a full URL or a path that starts with "/".',
      })
      .optional()
      .describe(
        'The start page: a full URL, or a path like "/admin" on the site of the environment.',
      ),
    environment: envNameSchema
      .optional()
      .describe(
        'The environment to run in, like staging, when the tool call and the session do not choose one.',
      ),
    environments: z
      .array(envNameSchema)
      .min(1)
      .optional()
      .describe('The only environments this plan may run in, like [development, staging].'),
    vars: varsSchema
      .optional()
      .describe(
        'Values for {{var:NAME}} in this plan. An environment in config.yaml can change them.',
      ),
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
    emulate: emulationSchema
      .optional()
      .describe(
        'More settings for every tab, like { timezone: Europe/Berlin, cpu: 4 }. device, colorScheme, and network above win over the same keys here.',
      ),
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
    accessibility: z
      .object({
        report: z.boolean().optional().describe('Write an accessibility report when the run ends.'),
        standard: z.enum(STANDARDS).optional().describe('The standard to check against.'),
        checks: checksSchema.optional(),
      })
      .strict()
      .optional()
      .describe('Settings for accessibility checks in this plan.'),
    lighthouse: z
      .object({
        device: z
          .enum(LH_DEVICES)
          .optional()
          .describe('desktop or mobile scores. The default comes from config.yaml.'),
        categories: z
          .array(z.enum(LH_CATEGORIES))
          .min(1)
          .optional()
          .describe('The categories to check. The default comes from config.yaml.'),
        report: z.boolean().optional().describe('Write a Lighthouse report when the run ends.'),
      })
      .strict()
      .optional()
      .describe('Settings for the Lighthouse steps in this plan.'),
    video: z
      .union([
        z.boolean(),
        z
          .object({
            format: z.enum(VIDEO_FORMATS).optional().describe('mp4, webm, or gif.'),
            path: z
              .string()
              .min(1)
              .regex(/\.(mp4|webm|gif)$/i, 'End the path with .mp4, .webm, or .gif.')
              .optional()
              .describe('Also save the video to this file, from the project folder.'),
            showPanel: z.boolean().optional().describe('Show the Walkthrough panel in the video.'),
            captions: z.boolean().optional().describe('Show step captions at the bottom.'),
          })
          .strict(),
      ])
      .optional()
      .describe('Record the whole run as a video. The report shows it.'),
    presentation: presentationSchema
      .optional()
      .describe('Settings to play this plan as a live presentation. See docs/presentations.md.'),
    steps: z.array(stepSchema).min(1, 'A plan needs at least one step.'),
  })
  .strict()
  .refine(
    (plan) =>
      !plan.environment || !plan.environments || plan.environments.includes(plan.environment),
    {
      message: 'Put the plan environment in the "environments" list too.',
      path: ['environment'],
    },
  );

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

// Keys that a later update makes work. Until then, a run stops with a clear message.
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
