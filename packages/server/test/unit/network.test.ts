import { describe, expect, it } from 'vitest';
import { toHar } from '../../src/evidence/har.js';
import { isSecretKey, maskBody, type NetEntry, SECRET_HEADER } from '../../src/evidence/network.js';
import { SecretStore } from '../../src/guards/secrets.js';

const entry: NetEntry = {
  id: 'r3',
  seq: 3,
  tabId: 't1',
  method: 'POST',
  url: 'http://localhost:4321/api/login?token=abc&page=2',
  type: 'fetch',
  startedAt: Date.parse('2026-09-28T10:00:00.000Z'),
  endedAt: Date.parse('2026-09-28T10:00:00.120Z'),
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  size: 40,
  requestHeaders: {
    'content-type': 'application/json',
    cookie: 'session=abc123',
    authorization: 'Bearer xyz',
  },
  postData: '{"username":"demo","password":"hunter22"}',
  responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'session=abc123' },
  body: '{"name":"Demo User","token":"t0k3n"}',
};

describe('secret fields', () => {
  it('knows secret headers and body keys', () => {
    expect(SECRET_HEADER.test('Authorization')).toBe(true);
    expect(SECRET_HEADER.test('X-CSRF-Token')).toBe(true);
    expect(SECRET_HEADER.test('content-type')).toBe(false);
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('api_key')).toBe(true);
    expect(isSecretKey('card-number')).toBe(true);
    expect(isSecretKey('username')).toBe(false);
  });

  it('masks secret fields in JSON and form bodies', () => {
    expect(
      JSON.parse(
        maskBody('{"user":"a","password":"x","list":[{"token":"y"}]}', 'application/json'),
      ),
    ).toEqual({
      user: 'a',
      password: '****',
      list: [{ token: '****' }],
    });
    expect(maskBody('user=a&pwd=secret1', 'application/x-www-form-urlencoded')).toBe(
      'user=a&pwd=****',
    );
    expect(maskBody('plain text', 'text/plain')).toBe('plain text');
  });
});

describe('toHar', () => {
  it('writes HAR 1.2 without login headers, cookies, or secret fields', () => {
    type Header = { name: string; value: string };
    type HarEntry = {
      time: number;
      request: {
        url: string;
        queryString: Header[];
        headers: Header[];
        postData: { text: string };
      };
      response: { content: { text: string } };
    };
    const har = toHar([entry], new SecretStore('/no/such/.env', {})) as {
      log: { version: string; entries: HarEntry[] };
    };
    expect(har.log.version).toBe('1.2');
    const first = har.log.entries[0] as HarEntry;
    expect(first.request.url).toBe('http://localhost:4321/api/login?token=****&page=2');
    expect(first.request.queryString).toEqual([
      { name: 'token', value: '****' },
      { name: 'page', value: '2' },
    ]);
    const headers = Object.fromEntries(first.request.headers.map((h) => [h.name, h.value]));
    expect(headers.cookie).toBe('****');
    expect(headers.authorization).toBe('****');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(first.request.postData.text).password).toBe('****');
    expect(JSON.parse(first.response.content.text)).toEqual({ name: 'Demo User', token: '****' });
    expect(first.time).toBe(120);
    const text = JSON.stringify(har);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('hunter22');
    expect(text).not.toContain('xyz');
  });
});
