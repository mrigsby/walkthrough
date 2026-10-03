import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPrevious } from '../../src/audit/compare.js';
import { loadSession, sessionPath, sessionsDir } from '../../src/browser/sessions.js';
import { exportScript } from '../../src/export/puppeteer-script.js';
import { initProject } from '../../src/init.js';
import { draftIssue } from '../../src/issue/draft.js';
import { findPreviousLh } from '../../src/lighthouse/findings.js';
import { buildOps } from '../../src/replay/ops.js';
import { htmlReport } from '../../src/report/html.js';
import { markdownReport } from '../../src/report/markdown.js';
import type { Run } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

const staging = {
  name: 'staging',
  label: 'Staging',
  color: '#b45309',
  baseUrl: 'https://staging.example.com',
  protected: false,
};

function run(extra: Partial<Run> = {}): Run {
  return {
    version: 1,
    id: '2026-10-02_100000-000-login-staging-abcd',
    name: 'Log in',
    mode: 'autonomous',
    status: 'finished',
    startedAt: '2026-10-02T10:00:00.000Z',
    endedAt: '2026-10-02T10:01:00.000Z',
    baseUrl: 'https://staging.example.com/login',
    environment: staging,
    vars: { userName: 'Staging User' },
    steps: [
      {
        id: 'open',
        index: 1,
        title: 'Type the name',
        expect: 'The page says "Logged in as Staging User".',
        template: { expect: 'The page says "Logged in as {{var:userName}}".' },
        confirm: false,
        status: 'fail',
        actual: 'It says nothing.',
        screenshots: [],
        actions: [
          {
            action: 'fill',
            selector: 'input[name=user]',
            label: 'textbox "User"',
            value: '{{var:userName}}',
            url: 'https://staging.example.com/login',
          },
        ],
      },
    ],
    ...extra,
  };
}

describe('reports show the environment', () => {
  it('in Markdown and HTML, and in the repro steps', () => {
    const md = markdownReport(run());
    expect(md).toContain('- **Environment:** staging (https://staging.example.com)');
    expect(md).toContain('Open https://staging.example.com/login (the staging environment)');
    const html = htmlReport(run(), tempDir('env-report'));
    expect(html).toContain('<span>Environment</span>staging (https://staging.example.com)');
    expect(html).toContain('background:#b45309');
  });

  it('calls a run from before environments development', () => {
    const old = run({ environment: undefined, baseUrl: 'http://localhost:4321' });
    expect(markdownReport(old)).toContain('- **Environment:** development (http://localhost:4321)');
    expect(markdownReport(old)).toContain('Open http://localhost:4321\n');
  });

  it('in issue drafts', () => {
    const draft = draftIssue(run(), run().steps[0] as never, {
      reportPath: 'report.md',
      screenshots: [],
    });
    expect(draft.body).toContain('- Environment: staging (https://staging.example.com)');
  });
});

describe('earlier reports of the same environment', () => {
  function project() {
    const dir = tempDir('env-compare');
    const save = (id: string, file: string, env?: string) => {
      const folder = join(dir, '.walkthrough', 'runs', id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, file),
        JSON.stringify({
          version: 1,
          runId: id,
          createdAt: '2026-10-01T00:00:00Z',
          ...(env ? { environment: { name: env } } : {}),
          pages: [{ page: '/', url: 'x', scores: {} }],
          findings: [],
        }),
      );
    };
    save('2026-10-01_000001-a', 'accessibility.json', 'production');
    save('2026-10-01_000002-b', 'accessibility.json');
    save('2026-10-01_000003-c', 'accessibility.json', 'staging');
    save('2026-10-01_000001-a', 'lighthouse.json', 'production');
    save('2026-10-01_000002-b', 'lighthouse.json', 'staging');
    return dir;
  }

  it('compares only with the same environment, unless compareTo names another run', () => {
    const dir = project();
    const now = '2026-10-02_000000-z';
    expect(findPrevious(dir, now, ['/'], undefined, 'staging')?.runId).toBe('2026-10-01_000003-c');
    // Reports from before 0.4.0 count as development.
    expect(findPrevious(dir, now, ['/'], undefined, 'development')?.runId).toBe(
      '2026-10-01_000002-b',
    );
    expect(findPrevious(dir, now, ['/'], undefined, 'qa')).toBeUndefined();
    expect(findPrevious(dir, now, ['/'], '2026-10-01_000001-a', 'staging')?.runId).toBe(
      '2026-10-01_000001-a',
    );
    expect(findPreviousLh(dir, now, ['/'], undefined, undefined, 'production')?.runId).toBe(
      '2026-10-01_000001-a',
    );
    expect(findPreviousLh(dir, now, ['/'], undefined, undefined, 'development')).toBeUndefined();
  });
});

describe('saved logins of an environment', () => {
  it('keep development in sessions/ and others in a folder, and name the right one', () => {
    const dir = tempDir('env-sessions');
    expect(sessionsDir(dir)).toBe(join(dir, '.walkthrough', 'sessions'));
    expect(sessionsDir(dir, 'staging')).toBe(join(dir, '.walkthrough', 'sessions', 'staging'));
    expect(sessionPath('admin', 'staging')).toBe('.walkthrough/sessions/staging/admin.json');
    mkdirSync(sessionsDir(dir, 'staging'), { recursive: true });
    writeFileSync(join(sessionsDir(dir, 'staging'), 'admin.json'), '{"name":"admin"}');
    expect(loadSession(dir, 'admin', 'staging').name).toBe('admin');
    expect(() => loadSession(dir, 'admin')).toThrow(
      /no saved login "admin" for the "development" environment\. It is saved for: staging/,
    );
  });
});

describe('init with an older .gitignore', () => {
  it('adds the lines for environment secret files', () => {
    const dir = tempDir('env-init');
    mkdirSync(join(dir, '.walkthrough'));
    writeFileSync(join(dir, '.walkthrough', '.gitignore'), '.env\nsessions/\n');
    const result = initProject(dir, 'http://localhost:3000');
    expect(result.updated).toEqual(['.walkthrough/.gitignore (added .env.*, !.env.example)']);
    expect(readFileSync(join(dir, '.walkthrough', '.gitignore'), 'utf8')).toBe(
      '.env\nsessions/\n# Secret files of each environment.\n.env.*\n!.env.example\n',
    );
    // A second time changes nothing.
    expect(initProject(dir, 'http://localhost:3000').updated).toEqual([]);
  });
});

describe('replays and exports in another environment', () => {
  it('check the text with its tokens', () => {
    const ops = buildOps(run()).steps[0]?.ops ?? [];
    expect(ops).toContainEqual({ type: 'expect', text: 'Logged in as {{var:userName}}' });
  });

  it('write VARS and the environment into exported scripts', () => {
    const own = exportScript(run(), {
      environments: [
        { name: 'development', baseUrl: 'http://localhost:4321' },
        { name: 'staging', baseUrl: 'https://staging.example.com' },
      ],
    }).code;
    expect(own).toContain('// The run used the "staging" environment.');
    expect(own).toContain('set BASE_URL: development http://localhost:4321.');
    expect(own).toContain(
      'const BASE_URL = process.env.BASE_URL ?? "https://staging.example.com/login";',
    );
    expect(own).toContain('userName: process.env.VAR_USERNAME ?? "Staging User",');
    expect(own).toContain('"Logged in as " + VARS.userName');

    const prod = exportScript(run(), {
      target: {
        name: 'production',
        baseUrl: 'https://www.example.com',
        vars: { userName: 'Production User' },
      },
    }).code;
    expect(prod).toContain('This script tests "production" by default.');
    expect(prod).toContain('process.env.BASE_URL ?? "https://www.example.com/login"');
    expect(prod).toContain('?? "Production User",');
  });
});
