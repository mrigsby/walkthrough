import { z } from 'zod';

// One mock rule, for the intercept tool and for plan steps.
export const mockRuleSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The address to match. "/api/stock" matches the path on any site. A full URL or a pattern with * matches the whole address.',
      ),
    urlRegex: z.string().min(1).optional().describe('A regular expression for the whole address.'),
    method: z.string().optional().describe('Only this method, like "POST".'),
    type: z
      .string()
      .optional()
      .describe('Only this resource type, like "fetch", "xhr", "document", "image", or "script".'),
    tab: z.string().optional().describe('Only this tab, by name or id. Default: every tab.'),
    status: z.number().int().min(100).max(599).optional().describe('The status to answer with.'),
    json: z.unknown().optional().describe('A JSON body to answer with.'),
    body: z.string().optional().describe('A text body to answer with.'),
    headers: z.record(z.string(), z.string()).optional().describe('Headers to answer with.'),
    contentType: z.string().optional().describe('The content type. Default: from json or text.'),
    delayMs: z.number().int().min(0).max(60_000).optional().describe('Wait this long first.'),
    block: z.boolean().optional().describe('Fail the request, as if the network blocked it.'),
    times: z.number().int().min(1).optional().describe('Use the rule this many times, then stop.'),
  })
  .strict();

export type MockRuleInput = z.infer<typeof mockRuleSchema>;

export interface MockRule extends MockRuleInput {
  id: string;
  hits: number;
}

// Turns a glob with * into a regular expression.
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// Checks that a rule can match something and do something.
export function checkRule(rule: MockRuleInput): string | undefined {
  if (!rule.url && !rule.urlRegex) return 'Give "url" or "urlRegex".';
  if (rule.urlRegex) {
    try {
      new RegExp(rule.urlRegex);
    } catch (error) {
      return `"urlRegex" is not a valid regular expression: ${(error as Error).message}`;
    }
  }
  if (rule.json !== undefined && rule.body !== undefined) return 'Give "json" or "body", not both.';
  const answers =
    rule.status !== undefined ||
    rule.json !== undefined ||
    rule.body !== undefined ||
    rule.headers !== undefined;
  if (rule.block && answers) return 'A rule cannot both block and answer.';
  if (!rule.block && !answers && rule.delayMs === undefined)
    return 'Say what to do: "block", a "status" or body to answer with, or "delayMs".';
  return undefined;
}

export interface RequestInfo {
  url: string;
  method: string;
  type: string;
}

// True when the rule is for this request. "/path" rules match the path on any site.
export function ruleMatches(rule: MockRuleInput, request: RequestInfo): boolean {
  if (rule.method && rule.method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (rule.type && rule.type.toLowerCase() !== request.type.toLowerCase()) return false;
  if (rule.urlRegex) return new RegExp(rule.urlRegex).test(request.url);
  const pattern = rule.url ?? '';
  if (pattern.startsWith('/')) {
    let target = request.url;
    try {
      const parsed = new URL(request.url);
      target = pattern.includes('?') ? parsed.pathname + parsed.search : parsed.pathname;
    } catch {}
    return globToRegex(pattern).test(target);
  }
  return globToRegex(pattern).test(request.url);
}

// What a rule did to one request, for the step evidence.
export function hitText(rule: MockRule, method: string, url: string): string {
  const what = rule.block
    ? 'blocked'
    : rule.status !== undefined ||
        rule.json !== undefined ||
        rule.body !== undefined ||
        rule.headers
      ? String(rule.status ?? 200)
      : 'sent on';
  return `${method} ${url} -> ${what}${rule.delayMs ? ` after ${rule.delayMs} ms` : ''} (mock ${rule.id})`;
}

// Plain words for a rule, like: GET /api/stock -> 200 JSON (all tabs).
export function describeRule(rule: MockRuleInput): string {
  const what = rule.block
    ? 'blocked'
    : rule.status !== undefined ||
        rule.json !== undefined ||
        rule.body !== undefined ||
        rule.headers
      ? `${rule.status ?? 200}${rule.json !== undefined ? ' JSON' : rule.body !== undefined ? ' text' : ''}`
      : 'continue';
  const parts = [
    `${rule.method?.toUpperCase() ?? 'any method'} ${rule.url ?? `/${rule.urlRegex}/`}`,
    rule.type ? `(${rule.type})` : '',
    `-> ${what}`,
    rule.delayMs ? `after ${rule.delayMs} ms` : '',
    rule.times ? `, ${rule.times} time(s)` : '',
    rule.tab ? `, tab ${rule.tab}` : ', all tabs',
  ];
  return parts.filter(Boolean).join(' ').replace(/ ,/g, ',');
}
