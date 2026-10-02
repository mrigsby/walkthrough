import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import type { Environment } from '../environments.js';
import { ToolError } from '../errors.js';
import { runTool } from './util.js';

function envLine(env: Environment, current: string, confirmed: ReadonlySet<string>): string {
  const marks = [
    env.name === current ? 'current' : '',
    env.protected ? (confirmed.has(env.name) ? 'protected, confirmed' : 'protected') : '',
  ].filter(Boolean);
  return `- ${env.name}${marks.length ? ` (${marks.join(', ')})` : ''}: ${env.baseUrl ?? 'no baseUrl'}. Label "${env.label}". From ${env.source}.`;
}

export function registerEnvironmentTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'environment',
    {
      title: 'Environments',
      description: [
        'List the environments of the app, like development, staging, and production. Show the one that this session uses, or switch to another one.',
        'After a switch, tools and plans use the base URL, sites, values, and secrets of that environment. Open tabs move to the same page there.',
        'A protected environment, like production, needs the developer to confirm it in the browser first. Only switch when the developer asks for it.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['list', 'show', 'use']).default('list'),
        name: z.string().optional().describe('For use: the environment, like "staging".'),
        resume: z
          .boolean()
          .optional()
          .describe(
            'For use: keep waiting for the developer to confirm a protected environment, after a reply with status: waiting.',
          ),
        projectDir: z
          .string()
          .optional()
          .describe('Project folder. Leave empty to find it automatically.'),
      },
    },
    ({ action, name, resume, projectDir }, extra) =>
      runTool(ctx, 'environment', async () => {
        const confirmed = ctx.driver?.alive ? ctx.driver.confirmedEnvs : new Set<string>();
        if (action === 'list') {
          const config = await ctx.refresh(projectDir);
          const session = ctx.sessionEnv;
          return [
            `Environments (${Object.keys(config.environments).length}):`,
            ...Object.values(config.environments).map((e) =>
              envLine(e, config.environment.name, confirmed),
            ),
            `Default: ${config.defaultEnvironment}.`,
            session
              ? `This session uses "${session.name}" (chosen by ${session.source === 'tool' ? 'a tool call' : 'UIWALK_ENV'}).`
              : `This session uses "${config.environment.name}".`,
            'Plans can choose an environment with the "environment" key, and a tool call can choose one with its "environment" argument.',
          ].join('\n');
        }

        if (action === 'show') {
          const config = await ctx.refresh(projectDir);
          const env = config.environment;
          const secrets = await ctx.secrets();
          const vars = Object.entries(ctx.vars);
          return [
            `Environment: ${env.name} (${env.label})`,
            `Base URL: ${env.baseUrl ?? 'none'}`,
            `Protected: ${env.protected ? (confirmed.has(env.name) ? 'yes, confirmed for this browser' : 'yes, not confirmed yet') : 'no'}`,
            `Allowed sites: ${config.allowedOrigins.join(', ')}`,
            `Values for {{var:NAME}}: ${vars.length ? vars.map(([k, v]) => `${k} = "${v}"`).join(', ') : 'none'}`,
            `Secrets it can read: ${secrets.names.length ? secrets.names.join(', ') : 'none'} (from .walkthrough/.env.${env.name}${env.protected ? '' : ' and .walkthrough/.env'}, and the environment variables)`,
            ...(Object.keys(env.secrets).length
              ? [
                  `Secrets read under another name: ${Object.entries(env.secrets)
                    .map(([k, v]) => `${k} as ${v}`)
                    .join(', ')}`,
                ]
              : []),
            ...(Object.keys(env.headers).length
              ? [`Extra request headers: ${Object.keys(env.headers).join(', ')}`]
              : []),
            ...(env.httpCredentials ? [`Basic auth as "${env.httpCredentials.username}"`] : []),
            ...(env.ignoreHttpsErrors ? ['Ignores HTTPS certificate errors.'] : []),
            `Action time limit: ${config.actionTimeoutMs} ms`,
          ].join('\n');
        }

        if (!name)
          throw new ToolError('Give the name of the environment, like "staging".', 'bad_input');
        const lines = await ctx.useEnvironment(name, { source: 'tool', projectDir });
        const result = await ctx.confirmEnvironment({
          signal: extra.signal,
          requestId: extra.requestId,
          resume,
        });
        if (result.status === 'waiting')
          return ['status: waiting', ...lines, result.text].join('\n');
        if (result.status === 'canceled') {
          return ['status: canceled', result.text, ...(await ctx.finishSwitch(false))].join('\n');
        }
        lines.push(...(await ctx.finishSwitch(true)));
        if (lines.length === 0) lines.push(`The session already uses the "${name}" environment.`);
        return lines.join('\n');
      }),
  );
}
