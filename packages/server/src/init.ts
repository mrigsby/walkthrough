import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolError } from './errors.js';
import { planJsonSchema } from './run/plan-schema.js';

// The first settings file for a project. Comments explain each setting.
function configTemplate(baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  return `# Walkthrough settings for this project. Commit this file.

# The page that browser_open and test runs start at.
baseUrl: ${baseUrl}

# Sites that Walkthrough may open. Anything else is blocked.
# Use "*" for any port or subdomain, like http://localhost:* or https://*.staging.example.com
allowedOrigins:
  - ${origin}

# How to answer confirm and prompt dialogs: ask (default), accept, or dismiss.
dialogs: ask

# Show the Pass, Bug, Skip, and Stop panel in the browser.
panel: true

# Show a box on each element for this many milliseconds before the agent uses it.
highlightMs: 600

# How long ask_developer waits for an answer before it tells the agent to wait again.
# askTimeoutSec: 300

# Browser options.
browser:
  # Set to true to hide the browser window.
  headless: false
  # Wait this many milliseconds between browser steps, so you can watch each step.
  slowMo: 0

# Accessibility checks and reports. See docs/accessibility.md.
# accessibility:
#   standard: wcag22aa
#   checks: { keyboard: true, darkMode: true, reflow: true, frames: true, screenshots: true }

# Videos and GIFs.
# video:
#   runFormat: mp4        # mp4, webm, or gif, for whole runs and replays
#   bugFormat: gif        # for the short clips saved with bugs
#   gifWidth: 800
#   replaySeconds: 15     # how much a bug clip shows. 0 turns bug clips off.

# Lighthouse reports.
# lighthouse:
#   device: desktop       # desktop or mobile
#   categories: [performance, best-practices, seo]

# Put personal settings in config.local.yaml. Git does not track that file.
# Only that file can turn on the evaluate tool (allowEvaluate: true),
# change the upload folder (uploadsRoot), let screenshots and videos go to
# folders outside the project (screenshotRoots), show cookie and header
# values in replies (allowSecretValues: true), or set the ffmpeg program
# (ffmpegPath).
`;
}

const SAMPLE_PLAN = `# yaml-language-server: $schema=../plan.schema.json
name: Smoke test
description: A first plan. Change the steps to match your app.
mode: interactive
steps:
  - id: open-start-page
    do: Open the start page
    action: { navigate: / }
    expect: The start page shows, with no error messages.
`;

const ENV_EXAMPLE = `# Secrets for test plans. Copy this file to .env in the same folder. Then add your values.
# Git does not track .env. The agent never sees the values.
# A plan uses a secret like this: {{secret:APP_PASSWORD}}
# APP_PASSWORD=
`;

const GITIGNORE = `# Created by Walkthrough. These files stay on this computer.
.env
.env.*
!.env.example
sessions/
runs/
config.local.yaml
`;

export interface InitResult {
  created: string[];
  kept: string[];
}

// Makes the .walkthrough folder. It never replaces a file that exists,
// except plan.schema.json, which is always made new.
export function initProject(projectDir: string, baseUrl = 'http://localhost:3000'): InitResult {
  if (!/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl)) {
    throw new ToolError(
      `"${baseUrl}" is not a web address. Use a full URL, like http://localhost:3000.`,
      'bad_input',
    );
  }
  const files: Array<[string, string, boolean]> = [
    ['config.yaml', configTemplate(baseUrl), false],
    ['plans/smoke.yaml', SAMPLE_PLAN, false],
    ['plan.schema.json', `${JSON.stringify(planJsonSchema(), null, 2)}\n`, true],
    ['.env.example', ENV_EXAMPLE, false],
    ['.gitignore', GITIGNORE, false],
  ];
  const result: InitResult = { created: [], kept: [] };
  for (const [name, content, replace] of files) {
    const file = join(projectDir, '.walkthrough', name);
    const shown = `.walkthrough/${name}`;
    if (existsSync(file) && !replace) {
      result.kept.push(shown);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    result.created.push(shown);
  }
  return result;
}
