import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { log } from '../log.js';
import { liveCaptures } from '../video/recording.js';

export type Content = CallToolResult['content'][number];

// Tools that change the page. While a video records, their time plays at normal speed.
const PAGE_TOOLS = new Set(['act', 'navigate', 'tabs', 'dialog', 'wait_for', 'emulate']);

export function textResult(text: string, extra: Content[] = []): CallToolResult {
  return { content: [{ type: 'text', text }, ...extra] };
}

// Switches to the environment of a tool's "environment" argument first, if it has one.
// The lines about the switch go at the top of the reply.
export async function withEnvironment(
  ctx: Context,
  environment: string | undefined,
  extra: { signal?: AbortSignal; requestId?: string | number },
  fn: () => Promise<CallToolResult | string>,
): Promise<CallToolResult | string> {
  const lines = environment ? await ctx.useEnvironmentForTool(environment, extra) : [];
  const out = await fn();
  if (lines.length === 0) return out;
  const head = lines.join('\n');
  if (typeof out === 'string') return `${head}\n${out}`;
  return { ...out, content: [{ type: 'text', text: head }, ...out.content] };
}

// Runs a tool: one at a time, with clear errors, and with secrets removed from the output.
export async function runTool(
  ctx: Context,
  name: string,
  fn: () => Promise<CallToolResult | string>,
): Promise<CallToolResult> {
  return ctx.lock.run(async () => {
    let result: CallToolResult;
    const began = Date.now();
    try {
      const out = await fn();
      result = typeof out === 'string' ? textResult(out) : out;
    } catch (error) {
      const message =
        error instanceof ToolError
          ? error.message
          : `The ${name} tool failed: ${(error as Error)?.message ?? String(error)}`;
      if (!(error instanceof ToolError)) log.error(`${name} failed`, error);
      result = { content: [{ type: 'text', text: message }], isError: true };
    }

    if (PAGE_TOOLS.has(name)) for (const capture of liveCaptures(ctx)) capture.activity(began);

    // Add things that happened in the browser, like dialogs and new tabs.
    const notes = ctx.driver?.drainNotes() ?? [];
    if (notes.length > 0) {
      result.content.push({
        type: 'text',
        text: `Browser events:\n${untrusted(notes.map((n) => `- ${n}`).join('\n'))}`,
      });
    }

    const secrets = await ctx.secrets().catch(() => undefined);
    if (secrets) {
      for (const part of result.content) {
        if (part.type === 'text') part.text = secrets.redact(part.text);
      }
    }
    return result;
  });
}
