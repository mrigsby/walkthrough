import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { untrusted } from '../guards/untrusted.js';
import { log } from '../log.js';

export type Content = CallToolResult['content'][number];

export function textResult(text: string, extra: Content[] = []): CallToolResult {
  return { content: [{ type: 'text', text }, ...extra] };
}

// Runs a tool: one at a time, with clear errors, and with secrets removed from the output.
export async function runTool(
  ctx: Context,
  name: string,
  fn: () => Promise<CallToolResult | string>,
): Promise<CallToolResult> {
  return ctx.lock.run(async () => {
    let result: CallToolResult;
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
