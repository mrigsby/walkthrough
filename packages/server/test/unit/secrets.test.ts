import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SecretScope, SecretStore } from '../../src/guards/secrets.js';
import { tempDir } from '../helpers/temp.js';

function store(env = 'DEMO_PASSWORD=demo123\nAPI_KEY=abc def/+=\n', processEnv = {}) {
  const dir = tempDir('secrets');
  const file = join(dir, '.env');
  writeFileSync(file, env);
  return new SecretStore(file, processEnv);
}

describe('SecretStore', () => {
  it('fills in secret tokens', () => {
    expect(store().resolve('{{secret:DEMO_PASSWORD}}')).toBe('demo123');
    expect(store().resolve('user:{{ secret:DEMO_PASSWORD }}!')).toBe('user:demo123!');
  });

  it('falls back to the process environment', () => {
    expect(store('', { OTHER: 'from-env' }).resolve('{{secret:OTHER}}')).toBe('from-env');
  });

  it('explains a missing secret', () => {
    expect(() => store().resolve('{{secret:NOPE}}')).toThrow(
      /NOPE is not set.*\.walkthrough\/\.env/,
    );
  });

  it('removes secret values and their encoded forms', () => {
    const s = store();
    const text = [
      'typed demo123',
      `url ${encodeURIComponent('abc def/+=')}`,
      `basic ${Buffer.from('demo123').toString('base64')}`,
    ].join('\n');
    const out = s.redact(text);
    expect(out).not.toContain('demo123');
    expect(out).not.toContain(encodeURIComponent('abc def/+='));
    expect(out).not.toContain(Buffer.from('demo123').toString('base64'));
    expect(out.match(/\*\*\*\*/g)?.length).toBe(3);
  });

  it('hides process secrets only after they are used', () => {
    const s = store('', { TOKEN: 'secret-token' });
    expect(s.redact('secret-token')).toBe('secret-token');
    s.resolve('{{secret:TOKEN}}');
    expect(s.redact('secret-token')).toBe('****');
  });

  it('finds tokens', () => {
    expect(store().hasTokens('{{secret:A}}')).toBe(true);
    expect(store().hasTokens('plain')).toBe(false);
  });
});

describe('SecretStore for an environment', () => {
  function scoped(scope: SecretScope, processEnv: NodeJS.ProcessEnv = {}) {
    const dir = tempDir('secrets-env');
    writeFileSync(join(dir, '.env'), 'APP_PASSWORD=dev-pass\nSHARED=shared-value\n');
    writeFileSync(join(dir, '.env.staging'), 'APP_PASSWORD=stage-pass\nSTAGING_TOKEN=tok-9999\n');
    writeFileSync(join(dir, '.env.production'), 'APP_PASSWORD=prod-pass\n');
    writeFileSync(join(dir, '.env.example'), 'APP_PASSWORD=example-only\n');
    return new SecretStore(join(dir, '.env'), processEnv, scope);
  }
  const staging: SecretScope = { name: 'staging', protected: false, rename: {} };
  const production: SecretScope = { name: 'production', protected: true, rename: {} };

  it('reads the environment file first, then .env', () => {
    const s = scoped(staging);
    expect(s.resolve('{{secret:APP_PASSWORD}}')).toBe('stage-pass');
    expect(s.resolve('{{secret:SHARED}}')).toBe('shared-value');
  });

  it('never reads .env for a protected environment', () => {
    const s = scoped(production, { SHARED: 'from-process' });
    expect(s.resolve('{{secret:APP_PASSWORD}}')).toBe('prod-pass');
    // The process environment still works, for CI.
    expect(s.resolve('{{secret:SHARED}}')).toBe('from-process');
    expect(() => scoped(production).resolve('{{secret:SHARED}}')).toThrow(
      /SHARED is not set for the "production" environment.*\.env\.production\.$/,
    );
  });

  it('reads a secret under another name', () => {
    const s = scoped({ ...staging, rename: { APP_PASSWORD: 'STAGING_TOKEN' } });
    expect(s.resolve('{{secret:APP_PASSWORD}}')).toBe('tok-9999');
    expect(() =>
      scoped({ ...staging, rename: { APP_PASSWORD: 'NOPE_NAME' } }).resolve(
        '{{secret:APP_PASSWORD}}',
      ),
    ).toThrow(/reads it as NOPE_NAME.*add NOPE_NAME=\.\.\. to \.walkthrough\/\.env\.staging or/);
  });

  it('hides the values of every environment file, but not .env.example', () => {
    const s = scoped(staging);
    expect(s.redact('dev-pass stage-pass prod-pass tok-9999 example-only')).toBe(
      '**** **** **** **** example-only',
    );
  });
});
