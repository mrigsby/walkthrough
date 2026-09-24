import { MASK } from '../guards/secrets.js';

// Query keys that often hold tokens or passwords.
const SENSITIVE_KEYS =
  /^(token|access_token|id_token|refresh_token|auth|authorization|key|api_key|apikey|secret|client_secret|password|pass|pwd|session|sessionid|sid|code|signature|sig|jwt)$/i;

// Hides the values of sensitive query keys in a URL.
export function scrubUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_KEYS.test(key)) {
      parsed.searchParams.set(key, MASK);
      changed = true;
    }
  }
  return changed ? parsed.href.replace(/%2A%2A%2A%2A/g, MASK) : url;
}

// Hides things that look like tokens in any text.
export function scrubText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>)]+/g, (url) => scrubUrl(url))
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g, MASK)
    .replace(/\b(Bearer|Basic)\s+[\w\-.=+/]{8,}/gi, `$1 ${MASK}`)
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${MASK}`);
}
