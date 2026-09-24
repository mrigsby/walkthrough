import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore } from '../../src/guards/secrets.js';
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
