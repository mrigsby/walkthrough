import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLighthouse } from '../../src/downloads/lighthouse.js';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Headers and basic auth go only to the site of the environment.
type Demo = Awaited<ReturnType<typeof startDemoServer>>;
let dev: Demo;
let staging: Demo;
let project: string;
const seen: Array<{ url: string; token: string | null; auth: string | null }> = [];
let third: ReturnType<typeof createServer>;
let thirdBase: string;
let mcp: Awaited<ReturnType<typeof startClient>>;

// A self-signed certificate, if openssl is there.
function selfSigned(dir: string): { key: string; cert: string } | undefined {
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0 || !existsSync(join(dir, 'cert.pem'))) return undefined;
  return {
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
  };
}

const certs = selfSigned(tempDir('certs'));
let secure: ReturnType<typeof createHttpsServer> | undefined;
let secureBase = 'https://localhost:1';

beforeAll(async () => {
  third = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      token: (req.headers['x-preview-token'] as string) ?? null,
      auth: req.headers.authorization ?? null,
    });
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
  await new Promise<void>((resolve) => third.listen(0, '127.0.0.1', resolve));
  thirdBase = `http://127.0.0.1:${(third.address() as AddressInfo).port}`;

  if (certs) {
    secure = createHttpsServer(certs, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Secure copy</h1>');
    });
    await new Promise<void>((resolve) => secure?.listen(0, resolve));
    secureBase = `https://localhost:${(secure.address() as AddressInfo).port}`;
  }

  // A copy of the demo site with a page that loads a picture from another site.
  const site = tempDir('net-site');
  cpSync(join(repoRoot, 'examples/demo-app/site'), site, { recursive: true });
  writeFileSync(
    join(site, 'third.html'),
    `<!doctype html><html><head><title>Third</title></head><body><h1>Third party</h1><img src="${thirdBase}/pic.svg" alt="x"><script>fetch('${thirdBase}/api', { mode: 'no-cors' })</script></body></html>`,
  );
  dev = await startDemoServer();
  staging = await startDemoServer(site, [
    '--host',
    'staging.localhost',
    '--env-name',
    'staging',
    '--password',
    'stage123',
    '--basic-auth',
    'team:pw-5678',
    '--require-header',
    'x-preview-token:tok-1234',
  ]);

  project = tempDir('net');
  const folder = join(project, '.walkthrough');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${dev.base}
allowedOrigins: [${dev.base}]
environments:
  staging:
    baseUrl: ${staging.base}
    headers: { x-preview-token: "{{secret:PREVIEW_TOKEN}}" }
    httpCredentials: { username: team, password: "{{secret:BASIC_PASSWORD}}" }
  bare:
    baseUrl: ${staging.base}
  secure:
    baseUrl: ${secureBase}
    ignoreHttpsErrors: true
  strict:
    baseUrl: ${secureBase}
`,
  );
  writeFileSync(
    join(folder, '.env.staging'),
    'PREVIEW_TOKEN=tok-1234\nBASIC_PASSWORD=pw-5678\nDEMO_PASSWORD=stage123\n',
  );
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('net-tmp') });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  for (const demo of [dev, staging]) demo?.stop();
  third?.close();
  secure?.close();
});

describe('request rules of an environment', () => {
  it('sends the header and the login to the site of the environment only', async () => {
    const open = await mcp.call('browser_open', { environment: 'staging', url: '/third.html' });
    expect(open.isError, open.text).toBe(false);
    expect(open.text).not.toContain('HTTP 40');
    expect((await mcp.call('wait_for', { text: 'Third party' })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.token, request.url).toBeNull();
      expect(request.auth, request.url).toBeNull();
    }
  });

  it('keeps the login cookie of the app', async () => {
    await mcp.call('navigate', { url: '/login' });
    for (const [selector, value] of [
      ['input[name=username]', 'demo'],
      ['input[name=password]', '{{secret:DEMO_PASSWORD}}'],
    ] as const) {
      expect((await mcp.call('act', { action: 'fill', selector, value })).isError).toBe(false);
    }
    await mcp.call('act', { action: 'click', selector: 'button[type=submit]' });
    const wait = await mcp.call('wait_for', { text: 'Logged in as Staging User' });
    expect(wait.isError, wait.text).toBe(false);
  });

  it('keeps the token and the password out of HAR files', async () => {
    const har = await mcp.call('network', { action: 'har', name: 'staging', since: 0 });
    expect(har.isError, har.text).toBe(false);
    const file = /(\.walkthrough\/\S+\.har)/.exec(har.text)?.[1];
    expect(file, har.text).toBeDefined();
    const text = readFileSync(join(project, file as string), 'utf8');
    expect(text).not.toContain('tok-1234');
    expect(text).not.toContain('pw-5678');
    expect(text).not.toContain(Buffer.from('team:pw-5678').toString('base64'));
  });

  it('does not send them for an environment without the rules', async () => {
    const use = await mcp.call('environment', { action: 'use', name: 'bare' });
    expect(use.isError, use.text).toBe(false);
    const go = await mcp.call('navigate', { url: '/login' });
    // Chrome keeps the basic auth login for the site, but the header is gone.
    expect(go.text).toContain('HTTP 403');
  });

  // A new hidden Chrome checks each page, so it must answer the login itself.
  it.skipIf(!findLighthouse())(
    'gives Lighthouse the same header and login',
    async () => {
      expect((await mcp.call('environment', { action: 'use', name: 'staging' })).isError).toBe(
        false,
      );
      const reply = await mcp.call('lighthouse', { urls: ['/help.html'] }, { timeoutMs: 120_000 });
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.text).toMatch(/- \/help\.html: Performance \d+/);
    },
    150_000,
  );

  it.skipIf(!certs)('ignores certificate errors only when the environment asks', async () => {
    await mcp.call('environment', { action: 'use', name: 'strict' });
    const strict = await mcp.call('navigate', { url: `${secureBase}/` });
    expect(strict.isError).toBe(true);
    expect(strict.text).toMatch(/CERT|certificate/i);
    await mcp.call('environment', { action: 'use', name: 'secure' });
    const go = await mcp.call('navigate', { url: `${secureBase}/` });
    expect(go.isError, go.text).toBe(false);
    expect((await mcp.call('wait_for', { text: 'Secure copy' })).isError).toBe(false);
  });
});
