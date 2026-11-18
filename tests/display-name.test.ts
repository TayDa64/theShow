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
});
