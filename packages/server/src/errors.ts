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
