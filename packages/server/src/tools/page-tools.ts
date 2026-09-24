import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { elementRect, withCleanPage } from '../evidence/annotate.js';
import { takeScreenshot } from '../evidence/screenshot.js';
import { untrusted } from '../guards/untrusted.js';
import { ACTIONS, act, resolveTarget } from '../page/actions.js';
import { formatState, readElement } from '../page/read.js';
import { buildSnapshot } from '../page/snapshot.js';
import { waitFor } from '../page/wait.js';
import { adhocEvidenceDir } from '../project-files.js';
import { runTool, textResult } from './util.js';

const refField = z.string().optional().describe('Element ref from the last snapshot, like "e12".');
const selectorField = z
  .string()
  .optional()
  .describe('CSS or Puppeteer selector. Use a ref when you can. Refs are more reliable.');

export function registerPageTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'snapshot',
    {
      title: 'Snapshot',
      description:
        'Get a text outline of the active tab: headings, links, buttons, fields, and text, each with a ref like "e12". Use the refs with act, read, and screenshot. Take a new snapshot after the page changes.',
      inputSchema: {
        ref: refField.describe('Only outline this part of the page.'),
      },
    },
    ({ ref }) =>
      runTool(ctx, 'snapshot', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const root = ref ? (await driver.refs.resolve(ref, tab.id, tab.nav)).handle : undefined;
        const title = await tab.page.title().catch(() => '');
        const outline = await buildSnapshot(tab, driver.refs, root);
        return [
          `Snapshot of tab ${tab.id}:`,
          untrusted(`Title: ${title || '(no title)'}\nURL: ${tab.page.url()}\n\n${outline}`),
          'Use a ref (like e5) with act, read, or screenshot. Refs stop working when the page changes.',
        ].join('\n');
      }),
  );

  server.registerTool(
    'act',
    {
      title: 'Act on the page',
      description: [
        'Do one action in the active tab, on an element from the last snapshot (ref) or a selector.',
        'Actions: click, dblclick, hover, fill (value), select (value is the option text or value), check, uncheck, press (value is a key like "Enter" or "Control+A", and the element is optional), scroll (element, or value "up", "down", or pixels), upload (files).',
        'For passwords and other secrets, write the value as {{secret:NAME}}. Walkthrough puts the real value from .walkthrough/.env into the field. You never see it.',
      ].join(' '),
      inputSchema: {
        action: z.enum(ACTIONS),
        ref: refField,
        selector: selectorField,
        value: z
          .string()
          .optional()
          .describe('Text to fill, option to select, key to press, or scroll amount.'),
        files: z
          .array(z.string())
          .optional()
          .describe('Files to upload, relative to the project folder.'),
      },
    },
    (input) =>
      runTool(ctx, 'act', async () => {
        const driver = ctx.requireDriver();
        return act(
          {
            driver,
            config: await ctx.config(),
            guard: await ctx.guard(),
            secrets: await ctx.secrets(),
            log: ctx.actionLog,
          },
          input,
        );
      }),
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Wait for',
      description:
        'Wait for one thing in the active tab: some text to show, some text to disappear, a selector to be visible, the URL to contain a value, the network to be quiet, or a set time.',
      inputSchema: {
        text: z.string().optional(),
        textGone: z.string().optional(),
        selector: z.string().optional(),
        url: z.string().optional().describe('Part of the URL to wait for.'),
        networkIdle: z.boolean().optional(),
        ms: z.number().int().optional().describe('Time to wait, up to 30000 ms.'),
        timeoutMs: z.number().int().min(100).max(60_000).optional().describe('Default 10000.'),
      },
    },
    (input) =>
      runTool(ctx, 'wait_for', async () => {
        const tab = ctx.requireDriver().activeTab();
        return waitFor(tab, input);
      }),
  );

  server.registerTool(
    'read',
    {
      title: 'Read element',
      description:
        'Read one element: its text, value, and whether it is visible, enabled, or checked. Use it to check an expected result.',
      inputSchema: { ref: refField, selector: selectorField },
    },
    ({ ref, selector }) =>
      runTool(ctx, 'read', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const target = await resolveTarget(driver, tab, { ref, selector });
        if (!target) throw new ToolError('Give a ref or a selector.', 'bad_input');
        const state = await readElement(target.handle);
        return `${target.label}:\n${untrusted(formatState(state))}`;
      }),
  );

  server.registerTool(
    'evaluate',
    {
      title: 'Run page JavaScript',
      description:
        'Run a JavaScript expression in the page and return the result. This tool is off unless the developer sets allowEvaluate: true in .walkthrough/config.local.yaml. Prefer read and snapshot.',
      inputSchema: {
        script: z.string().describe('A JavaScript expression, like "document.title".'),
      },
    },
    ({ script }) =>
      runTool(ctx, 'evaluate', async () => {
        const config = await ctx.config();
        if (!config.allowEvaluate) {
          throw new ToolError(
            'The evaluate tool is off for safety. Use read or snapshot instead. To turn it on, the developer adds "allowEvaluate: true" to .walkthrough/config.local.yaml.',
            'evaluate_disabled',
          );
        }
        const tab = ctx.requireDriver().activeTab();
        const value = await tab.page.evaluate(script);
        return `Result:\n${untrusted(JSON.stringify(value, null, 2) ?? 'undefined')}`;
      }),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Save a screenshot of the active tab, the full page, or one element. Walkthrough saves the full-size PNG in the project and returns a small preview.',
      inputSchema: {
        ref: refField,
        selector: selectorField,
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole page, not only the visible part.'),
        label: z.string().optional().describe('Short name for the file, like "cart-total".'),
        annotate: z
          .boolean()
          .optional()
          .describe(
            'With a ref or selector: capture the page and draw a red box around the element.',
          ),
      },
    },
    ({ ref, selector, fullPage, label, annotate }) =>
      runTool(ctx, 'screenshot', async () => {
        const driver = ctx.requireDriver();
        const tab = driver.activeTab();
        const config = await ctx.config();
        const target = await resolveTarget(driver, tab, { ref, selector });
        const dir = adhocEvidenceDir(config.projectDir);
        // With annotate, the whole view is saved, with a red box on the element.
        const rect = annotate && target ? await elementRect(target.handle) : undefined;
        const shot = await withCleanPage(driver, tab, { annotate: rect }, () =>
          takeScreenshot(tab, dir, config.projectDir, {
            handle: rect ? undefined : target?.handle,
            fullPage,
            label,
          }),
        );
        const page = fullPage ? 'the full page' : 'the visible page';
        const what =
          target && !rect ? target.label : rect ? `${page}, with ${target?.label} marked` : page;
        const note =
          fullPage && !(target && !rect) ? ' The preview shows only the visible part.' : '';
        return textResult(`Saved a screenshot of ${what}: ${shot.relativePath}${note}`, [
          { type: 'image', data: shot.preview, mimeType: 'image/jpeg' },
        ]);
      }),
  );
}
