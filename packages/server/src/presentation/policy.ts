import { ToolError } from '../errors.js';

// What the tools need to know about a presentation that is going.
export interface LivePresentation {
  readonly active: boolean;
}

// The tools that work while a presentation is going. They only read, so they cannot
// change what the audience sees. The agent uses them to answer questions.
const ALLOWED = new Set([
  'present',
  'snapshot',
  'read',
  'screenshot',
  'logs',
  'network',
  'runs',
  'plan',
  'issue_draft',
  'export_script',
  'environment',
]);

// Throws when a tool would change the page or the session during a presentation.
export function checkPresentationPolicy(
  presentation: LivePresentation | undefined,
  tool: string,
  action?: string,
): void {
  if (!presentation?.active) return;
  // A switch would move the audience's tabs to another environment.
  if (ALLOWED.has(tool) && !(tool === 'environment' && action === 'use')) return;
  throw new ToolError(
    `A presentation is going, so Walkthrough does not run ${tool}${action ? ` with action "${action}"` : ''} now. Tools that only read the page still work, such as snapshot and read. Call present with action "stop" to end the presentation.`,
    'presentation_active',
  );
}
