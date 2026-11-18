import { describe, expect, it } from 'vitest';
import { displayFirstName, displayName, nameHasHiddenCharacters } from '../src/lib/displayName';

describe('displayName', () => {
  it('shows the trimmed stored name', () => {
    expect(displayName({ name: '  Ada Lovelace  ', email: 'ada@example.com' })).toBe('Ada Lovelace');
    expect(displayFirstName({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBe('Ada');
  });

  it('falls back to Director when the name is empty', () => {
    expect(displayName({ name: '   ', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ email: 'ada@example.com' })).toBe('Director');
    expect(displayName(null)).toBe('Director');
  });

  it('falls back to Director when the name equals the email local part', () => {
    expect(displayName({ name: 'ada', email: 'ada@example.com' })).toBe('Director');
    expect(displayFirstName({ name: 'ada', email: 'ada@example.com' })).toBe('Director');
  });

  it('falls back to Director when the name contains @', () => {
    expect(displayName({ name: 'ada@example.com', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: 'not-an-email@host', email: 'other@example.com' })).toBe('Director');
  });

  it('falls back to Director when only invisible characters remain', () => {
    expect(displayName({ name: '\u0000', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u001B', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u0085', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u202E', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u2066', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u200B\u200C\u200D', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u2060', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\uFEFF', email: 'ada@example.com' })).toBe('Director');
  });

  it('drops invisible characters before showing a name', () => {
    expect(displayName({ name: 'Ada\u200B Lovelace', email: 'ada@example.com' })).toBe('Ada Lovelace');
  });

  it('accepts a joiner that sits between two visible characters', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    const hindiZwj = '\u0915\u094D\u200D\u0937';
    const hindiZwnj = '\u0915\u094D\u200C\u0937';
    expect(nameHasHiddenCharacters(family)).toBe(false);
    expect(nameHasHiddenCharacters(persian)).toBe(false);
    expect(nameHasHiddenCharacters(hindiZwj)).toBe(false);
    expect(nameHasHiddenCharacters(hindiZwnj)).toBe(false);
    expect(displayName({ name: family, email: 'ada@example.com' })).toBe(family);
    expect(displayName({ name: persian, email: 'ada@example.com' })).toBe(persian);
    expect(displayName({ name: hindiZwj, email: 'ada@example.com' })).toBe(hindiZwj);
  });

  it('rejects a joiner at the edge, alone, in a run, or beside whitespace', () => {
    expect(nameHasHiddenCharacters('\u200DAda')).toBe(true);
    expect(nameHasHiddenCharacters('Ada\u200C')).toBe(true);
    expect(nameHasHiddenCharacters('\u200D')).toBe(true);
    expect(nameHasHiddenCharacters('Ada\u200D\u200DLovelace')).toBe(true);
    expect(nameHasHiddenCharacters('Ada \u200DLovelace')).toBe(true);
    expect(displayName({ name: '\u200D', email: 'ada@example.com' })).toBe('Director');
    expect(displayName({ name: '\u200C', email: 'ada@example.com' })).toBe('Director');
  });
});
