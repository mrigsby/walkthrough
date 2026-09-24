// The build sets this value. Tests use the fallback.
declare const __UIWALK_VERSION__: string | undefined;

export const VERSION = typeof __UIWALK_VERSION__ === 'string' ? __UIWALK_VERSION__ : '0.0.0-dev';

// Lowest Node version we support.
export const MIN_NODE = [22, 12] as const;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor, needMinor] = MIN_NODE;
  return major > needMajor || (major === needMajor && minor >= needMinor);
}
