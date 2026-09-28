import { describe, expect, it } from 'vitest';
import { checkRule, describeRule, hitText, ruleMatches } from '../../src/devtools/mock-schema.js';

const request = (url: string, method = 'GET', type = 'Fetch') => ({ url, method, type });

describe('mock rules', () => {
  it('matches a path on any site, a full address, or a regex', () => {
    expect(
      ruleMatches({ url: '/api/stock' }, request('http://localhost:4321/api/stock?id=mug')),
    ).toBe(true);
    expect(ruleMatches({ url: '/api/stock' }, request('http://localhost:4321/api/stocks'))).toBe(
      false,
    );
    expect(ruleMatches({ url: '/api/stock?id=cap' }, request('http://x/api/stock?id=mug'))).toBe(
      false,
    );
    expect(
      ruleMatches({ url: '*/images/*' }, request('http://x/images/mug.svg', 'GET', 'Image')),
    ).toBe(true);
    expect(ruleMatches({ url: 'http://x/a.js' }, request('http://x/a.js'))).toBe(true);
    expect(
      ruleMatches({ urlRegex: 'stock\\?id=(mug|cap)$' }, request('http://x/api/stock?id=cap')),
    ).toBe(true);
    expect(
      ruleMatches({ url: '/api/*', method: 'post' }, request('http://x/api/order', 'POST')),
    ).toBe(true);
    expect(
      ruleMatches({ url: '/api/*', method: 'POST' }, request('http://x/api/order', 'GET')),
    ).toBe(false);
    expect(ruleMatches({ url: '/api/*', type: 'xhr' }, request('http://x/api/order'))).toBe(false);
  });

  it('refuses rules that match nothing or do nothing', () => {
    expect(checkRule({ status: 500 })).toMatch(/url/);
    expect(checkRule({ url: '/a' })).toMatch(/Say what to do/);
    expect(checkRule({ url: '/a', block: true, status: 500 })).toMatch(/both block and answer/);
    expect(checkRule({ url: '/a', json: {}, body: 'x' })).toMatch(/not both/);
    expect(checkRule({ urlRegex: '(' })).toMatch(/not a valid regular expression/);
    expect(checkRule({ url: '/a', delayMs: 100 })).toBeUndefined();
  });

  it('describes rules and what they did', () => {
    expect(describeRule({ url: '/api/stock', method: 'get', status: 500, json: {} })).toBe(
      'GET /api/stock -> 500 JSON, all tabs',
    );
    expect(describeRule({ url: '*/images/*', block: true, tab: 'guest', times: 2 })).toBe(
      'any method */images/* -> blocked, 2 time(s), tab guest',
    );
    expect(hitText({ id: 'm1', hits: 1, url: '/x', delayMs: 300 }, 'GET', 'http://h/x')).toBe(
      'GET http://h/x -> sent on after 300 ms (mock m1)',
    );
  });
});
