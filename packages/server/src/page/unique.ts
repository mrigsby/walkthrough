import { randomBytes } from 'node:crypto';

// {{unique}} in a value becomes a short value that is the same for the whole run.
const TOKEN = /\{\{\s*unique\s*\}\}/g;
export const UNIQUE_TOKEN = '{{unique}}';

// Six lowercase letters and digits. A letter comes first, so it also works in names.
export function newUnique(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const all = `${letters}0123456789`;
  const bytes = randomBytes(6);
  let out = letters[(bytes[0] ?? 0) % letters.length] ?? 'a';
  for (let i = 1; i < 6; i++) out += all[(bytes[i] ?? 0) % all.length];
  return out;
}

export function hasUnique(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

export function withUnique(text: string, unique: string): string {
  return text.replace(TOKEN, unique);
}

// Puts the token back where the value shows, so a record can run again with a new value.
export function tokenizeUnique(text: string, unique: string): string {
  if (!unique) return text;
  return text
    .replace(/%7B%7B\s*unique\s*%7D%7D/gi, UNIQUE_TOKEN)
    .split(unique)
    .join(UNIQUE_TOKEN);
}
