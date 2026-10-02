// An error with a message that is safe and useful to show the agent.
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code = 'error',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// The message of a schema problem. A bad record key keeps its reason in a nested problem.
export function issueMessage(issue: {
  code?: string;
  message: string;
  issues?: Array<{ message: string }>;
}): string {
  const inner = issue.code === 'invalid_key' ? issue.issues?.[0]?.message : undefined;
  return inner ?? issue.message;
}
