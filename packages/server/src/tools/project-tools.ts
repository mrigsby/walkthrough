import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { initProject } from '../init.js';
import { resultLine } from '../report/common.js';
import type { Run } from '../run/run-store.js';
import { runTool } from './util.js';

export function registerProjectTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'init_project',
    {
      title: 'Set up a project',
      description:
        'Make the .walkthrough folder in the project: config.yaml, a sample plan, the plan schema, .env.example, and .gitignore. It keeps files that exist, but it always updates plan.schema.json.',
      inputSchema: {
        baseUrl: z
          .string()
          .optional()
          .describe('The start page of the app, like http://localhost:3000.'),
        projectDir: z
          .string()
          .optional()
          .describe('Project folder. Leave empty to find it automatically.'),
      },
    },
    ({ baseUrl, projectDir }) =>
      runTool(ctx, 'init_project', async () => {
        const config = await ctx.refresh(projectDir);
        const result = initProject(config.projectDir, baseUrl);
        await ctx.refresh(projectDir);
        return [
          `Project folder: ${config.projectDir}`,
          result.created.length
            ? `Created:\n${result.created.map((f) => `- ${f}`).join('\n')}`
            : '',
          result.kept.length
            ? `Already there (not changed):\n${result.kept.map((f) => `- ${f}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
  );

  server.registerTool(
    'runs',
    {
      title: 'List test runs',
      description:
        'List recent test runs in .walkthrough/runs, newest first, with the result of each.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many runs to list. The default is 10.'),
      },
    },
    ({ limit }) =>
      runTool(ctx, 'runs', async () => {
        const { projectDir } = await ctx.config();
        const dir = join(projectDir, '.walkthrough', 'runs');
        if (!existsSync(dir)) return 'There are no runs yet.';
        const rows: string[] = [];
        for (const id of readdirSync(dir).sort().reverse()) {
          if (rows.length >= (limit ?? 10)) break;
          const file = join(dir, id, 'run.json');
          if (!existsSync(file)) continue;
          try {
            const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
            const report = existsSync(join(dir, id, 'report.html'))
              ? 'report written'
              : 'no report yet';
            rows.push(
              `- ${id}: "${run.name}", ${run.status}, ${resultLine(run) || 'no steps'} (${report})`,
            );
          } catch {
            rows.push(`- ${id}: run.json cannot be read`);
          }
        }
        return rows.length ? rows.join('\n') : 'There are no runs yet.';
      }),
  );
}
