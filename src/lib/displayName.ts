export type DisplayNameUser = {
  name?: string | null;
  email?: string | null;
};

function trimmedName(name: string | null | undefined): string {
  return typeof name === 'string' ? name.trim() : '';
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
