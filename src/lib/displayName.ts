export type DisplayNameUser = {
  name?: string | null;
  email?: string | null;
};

const ZWNJ = '\u200C';
const ZWJ = '\u200D';

/**
 * C0/C1 controls, bidi overrides and isolates, and marks that are never part of
 * a name. ZWJ and ZWNJ are handled separately so a joiner between two visible
 * characters can stay.
 */
function isAlwaysHidden(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || (code >= 0x80 && code <= 0x9f)) return true;
  if (code === 0x200b || code === 0x2060 || code === 0xfeff) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

function isJoiner(char: string): boolean {
  return char === ZWNJ || char === ZWJ;
}

/** A joiner is allowed only with a visible character on both sides. */
function isVisibleCharacter(char: string | undefined): boolean {
  if (!char || isJoiner(char) || isAlwaysHidden(char)) return false;
  return !/^\s$/u.test(char);
}

function joinerIsAllowed(chars: string[], index: number): boolean {
  return isVisibleCharacter(chars[index - 1]) && isVisibleCharacter(chars[index + 1]);
}

export const HIDDEN_DISPLAY_NAME_ERROR = 'Name cannot include hidden or control characters.';

export function nameHasHiddenCharacters(value: string): boolean {
  const chars = Array.from(value);
  return chars.some((char, index) => {
    if (isJoiner(char)) return !joinerIsAllowed(chars, index);
    return isAlwaysHidden(char);
  });
}

function withoutHiddenCharacters(value: string): string {
  const chars = Array.from(value);
  return chars.filter((char, index) => {
    if (isJoiner(char)) return joinerIsAllowed(chars, index);
    return !isAlwaysHidden(char);
  }).join('');
}

function trimmedName(name: string | null | undefined): string {
  const raw = typeof name === 'string' ? name : '';
  return withoutHiddenCharacters(raw).trim();
}

function emailLocalPart(email: string | null | undefined): string {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return '';
  return trimmed.slice(0, at);
}

/**
 * Name shown outside a credential screen.
 * Empty, equal to the email's local part, or containing `@` becomes "Director".
 */
export function displayName(user: DisplayNameUser | null | undefined): string {
  const name = trimmedName(user?.name);
  const localPart = emailLocalPart(user?.email);
  if (!name || name.includes('@') || (localPart !== '' && name === localPart)) {
    return 'Director';
  }
  return name;
}

/** First token of {@link displayName}. The header control shows this. */
export function displayFirstName(user: DisplayNameUser | null | undefined): string {
  const shown = displayName(user);
  const first = shown.split(' ')[0]?.trim() ?? '';
  return first || 'Director';
}
