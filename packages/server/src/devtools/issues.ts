import type { Protocol } from 'puppeteer-core';
import type { LogLevel } from '../evidence/logs.js';

// Chrome's Issues panel, in plain words. Anything that Chrome blocked is an error.

type Location = Protocol.Audits.SourceCodeLocation | undefined;

function where(location: Location): string {
  if (!location?.url) return '';
  return ` (${location.url}:${location.lineNumber + 1})`;
}

const COOKIE_REASONS: Record<string, string> = {
  ExcludeSameSiteNoneInsecure: 'SameSite=None needs the Secure flag',
  WarnSameSiteNoneInsecure: 'SameSite=None needs the Secure flag',
  ExcludeSameSiteLax: 'SameSite=Lax does not allow it here',
  ExcludeSameSiteStrict: 'SameSite=Strict does not allow it here',
  ExcludeSameSiteUnspecifiedTreatedAsLax: 'it has no SameSite, so Chrome treats it as Lax',
  WarnSameSiteUnspecifiedCrossSiteContext: 'it has no SameSite, and the request is cross-site',
  ExcludeThirdPartyPhaseout: 'Chrome blocks third-party cookies',
  WarnThirdPartyPhaseout: 'Chrome will block third-party cookies',
  ExcludeDomainNonASCII: 'the domain has characters that are not ASCII',
  ExcludeThirdPartyCookieBlockedInFirstPartySet: 'Chrome blocks this third-party cookie',
};

const FORM_PROBLEMS: Record<string, string> = {
  FormLabelForMatchesNonExistingIdError:
    'A label "for" attribute points to an id that does not exist',
  FormEmptyIdAndNameAttributesForInputError: 'A form field has no id and no name',
  FormInputWithNoLabelError: 'A form field has no label',
  FormAutocompleteAttributeEmptyError: 'A form field has an empty autocomplete attribute',
  FormDuplicateIdForInputError: 'Two form fields have the same id',
  FormInputAssignedAutocompleteValueToIdOrNameAttributeError:
    'A form field uses an autocomplete value as its id or name',
  FormInputHasWrongButWellIntendedAutocompleteValueError:
    'A form field has an autocomplete value that is almost right',
  FormAriaLabelledByToNonExistingId: 'aria-labelledby points to an id that does not exist',
  FormInputWithNoLabelErrorMultiple: 'Form fields have no label',
  FormLabelHasNeitherForNorNestedInput: 'A label has no "for" attribute and no field inside it',
  FormLabelForNameError: 'A label "for" attribute uses a field name, not an id',
};

// One Chrome issue as a log line. Returns undefined for issues that tell a tester nothing.
export function describeIssue(
  issue: Protocol.Audits.InspectorIssue,
): { level: LogLevel; text: string } | undefined {
  const d = issue.details;
  switch (issue.code) {
    case 'CookieIssue': {
      const c = d.cookieIssueDetails;
      if (!c) return undefined;
      const name = c.cookie?.name ?? c.rawCookieLine?.split('=')[0] ?? 'a cookie';
      const blocked = (c.cookieExclusionReasons ?? []).length > 0;
      const reasons = blocked ? c.cookieExclusionReasons : c.cookieWarningReasons;
      const why = [...new Set((reasons ?? []).map((r) => COOKIE_REASONS[r] ?? r))].join(', ');
      const url = c.cookieUrl ?? c.request?.url;
      return {
        level: blocked ? 'error' : 'warning',
        text: `Chrome ${blocked ? 'blocked' : 'warns about'} the cookie "${name}" when the page ${c.operation === 'SetCookie' ? 'set' : 'read'} it${url ? ` for ${url}` : ''}: ${why}`,
      };
    }
    case 'MixedContentIssue': {
      const m = d.mixedContentIssueDetails;
      if (!m) return undefined;
      const blocked = m.resolutionStatus === 'MixedContentBlocked';
      return {
        level: blocked ? 'error' : 'warning',
        text: `${blocked ? 'Chrome blocked' : 'Chrome warns about'} insecure content ${m.insecureURL} on the secure page ${m.mainResourceURL}`,
      };
    }
    case 'ContentSecurityPolicyIssue': {
      const p = d.contentSecurityPolicyIssueDetails;
      if (!p) return undefined;
      const what = p.blockedURL ?? 'an inline script or style';
      return p.isReportOnly
        ? {
            level: 'warning',
            text: `The Content Security Policy (${p.violatedDirective}) would block ${what}${where(p.sourceCodeLocation)}. The policy is in report-only mode, so it did not block it.`,
          }
        : {
            level: 'error',
            text: `The Content Security Policy (${p.violatedDirective}) blocked ${what}${where(p.sourceCodeLocation)}`,
          };
    }
    case 'CorsIssue': {
      const x = d.corsIssueDetails;
      if (!x) return undefined;
      return {
        level: x.isWarning ? 'warning' : 'error',
        text: `CORS ${x.isWarning ? 'warns about' : 'blocked'} the request to ${x.request.url}: ${x.corsErrorStatus.corsError}`,
      };
    }
    case 'DeprecationIssue': {
      const x = d.deprecationIssueDetails;
      if (!x) return undefined;
      return {
        level: 'warning',
        text: `The page uses a deprecated feature: ${x.type}${where(x.sourceCodeLocation)}`,
      };
    }
    case 'GenericIssue': {
      const g = d.genericIssueDetails;
      if (!g) return undefined;
      // Common in single-page apps. Useful to know, but not a problem on its own.
      if (g.errorType === 'NavigationEntryMarkedSkippable')
        return {
          level: 'info',
          text: 'The page added a history entry without a click or a key press, so the Back button can skip it',
        };
      const text = FORM_PROBLEMS[g.errorType] ?? `Chrome reports a page problem: ${g.errorType}`;
      return { level: 'warning', text };
    }
    case 'HeavyAdIssue':
      return {
        level: 'warning',
        text: 'Chrome removed an ad because it used too much CPU or network',
      };
    default:
      return { level: 'warning', text: `Chrome reports an issue: ${issue.code}` };
  }
}
