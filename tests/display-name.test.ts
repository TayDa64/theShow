import { describe, expect, it } from 'vitest';
import { displayFirstName, displayName } from '../src/lib/displayName';

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
});
