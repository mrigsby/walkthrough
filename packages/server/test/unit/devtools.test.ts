import type { Cookie, Protocol } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { describeIssue } from '../../src/devtools/issues.js';
import { checkCookies, maskValue } from '../../src/devtools/storage.js';
import { LogBook } from '../../src/evidence/logs.js';

const cookie = (over: Partial<Cookie>): Cookie =>
  ({
    name: 'session',
    value: 'abc123secret',
    domain: 'localhost',
    path: '/',
    expires: -1,
    size: 19,
    httpOnly: true,
    secure: false,
    session: true,
    sameSite: 'Lax',
    ...over,
  }) as Cookie;

describe('maskValue', () => {
  it('shows a fingerprint, or the value when allowed', () => {
    expect(maskValue('abc123secret', false)).toMatch(
      /^\*\*\*\* \(12 characters, id [0-9a-f]{4}\)$/,
    );
    expect(maskValue('abc123secret', false)).toBe(maskValue('abc123secret', false));
    expect(maskValue('abc123secres', false)).not.toBe(maskValue('abc123secret', false));
    expect(maskValue('abc123secret', true)).toBe('"abc123secret"');
    expect(maskValue('', false)).toBe('(empty)');
  });
});

describe('checkCookies', () => {
  const same = (text: string) => text;

  it('passes and fails checks, and never prints a value', () => {
    const result = checkCookies(
      [cookie({})],
      [
        { name: 'session', httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'session', value: 'wrong' },
        { name: 'session', value: 'abc123secret', contains: '123' },
        { name: 'theme' },
        { name: 'theme', exists: false },
      ],
      same,
    );
    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([
      'fail: "session" is set, HttpOnly is true, Secure is false, not true, SameSite is Lax.',
      'fail: "session" is set, the value does not match (it has 12 characters).',
      'pass: "session" is set, the value matches, the value has the text.',
      'fail: "theme" is not set',
      'pass: "theme" is not set',
    ]);
    expect(result.lines.join('\n')).not.toContain('abc123secret');
  });

  it('explains a cookie with no SameSite', () => {
    const result = checkCookies(
      [cookie({ sameSite: undefined })],
      [{ name: 'session', sameSite: 'Lax' }],
      same,
    );
    expect(result.lines[0]).toContain('SameSite is not set (Chrome then uses Lax), not Lax');
  });
});

describe('describeIssue', () => {
  const issue = (code: string, details: object) =>
    ({ code, details }) as unknown as Protocol.Audits.InspectorIssue;

  it('names blocked cookies, CSP, CORS, and form problems', () => {
    expect(
      describeIssue(
        issue('CookieIssue', {
          cookieIssueDetails: {
            cookie: { name: 'tracker', domain: 'x', path: '/' },
            cookieWarningReasons: ['WarnSameSiteNoneInsecure'],
            cookieExclusionReasons: ['ExcludeSameSiteNoneInsecure'],
            operation: 'SetCookie',
            cookieUrl: 'http://localhost/',
          },
        }),
      ),
    ).toEqual({
      level: 'error',
      text: 'Chrome blocked the cookie "tracker" when the page set it for http://localhost/: SameSite=None needs the Secure flag',
    });
    expect(
      describeIssue(
        issue('ContentSecurityPolicyIssue', {
          contentSecurityPolicyIssueDetails: {
            blockedURL: 'https://example.com/x.png',
            violatedDirective: 'img-src',
            isReportOnly: false,
            sourceCodeLocation: { url: 'http://localhost/', lineNumber: 3, columnNumber: 0 },
          },
        }),
      ),
    ).toEqual({
      level: 'error',
      text: 'The Content Security Policy (img-src) blocked https://example.com/x.png (http://localhost/:4)',
    });
    expect(
      describeIssue(
        issue('CorsIssue', {
          corsIssueDetails: {
            corsErrorStatus: { corsError: 'MissingAllowOriginHeader' },
            isWarning: false,
            request: { url: 'https://example.com/api' },
          },
        }),
      )?.text,
    ).toBe('CORS blocked the request to https://example.com/api: MissingAllowOriginHeader');
    expect(
      describeIssue(
        issue('GenericIssue', {
          genericIssueDetails: { errorType: 'FormLabelForMatchesNonExistingIdError' },
        }),
      ),
    ).toEqual({
      level: 'warning',
      text: 'A label "for" attribute points to an id that does not exist',
    });
    expect(
      describeIssue(
        issue('GenericIssue', {
          genericIssueDetails: { errorType: 'NavigationEntryMarkedSkippable' },
        }),
      )?.level,
    ).toBe('info');
    expect(describeIssue(issue('SomethingNewIssue', {}))?.text).toBe(
      'Chrome reports an issue: SomethingNewIssue',
    );
  });
});

describe('LogBook issues', () => {
  it('keeps one of each issue per step, and filters by kind', () => {
    const book = new LogBook();
    book.addIssue('t1', 'warning', 'A form field has no label');
    book.addIssue('t1', 'warning', 'A form field has no label');
    expect(book.currentStep()).toHaveLength(1);
    expect(book.currentStep(['error', 'warning'], ['console'])).toHaveLength(0);
    expect(book.currentStep(['error', 'warning'], ['issue'])).toHaveLength(1);
    book.endStep('step one');
    book.addIssue('t1', 'warning', 'A form field has no label');
    expect(book.currentStep()).toHaveLength(1);
  });
});
