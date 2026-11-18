export type DisplayNameUser = {
  name?: string | null;
  email?: string | null;
};

/** C0/C1 controls, bidi overrides and isolates, and zero-width or invisible marks. */
function hiddenNamePattern(): RegExp {
  return /[\u0000-\u001F\u0080-\u009F\u200B-\u200D\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
}

export const HIDDEN_DISPLAY_NAME_ERROR = 'Name cannot include hidden or control characters.';

export function nameHasHiddenCharacters(value: string): boolean {
  return hiddenNamePattern().test(value);
}

function withoutHiddenCharacters(value: string): string {
  return value.replace(hiddenNamePattern(), '');
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
