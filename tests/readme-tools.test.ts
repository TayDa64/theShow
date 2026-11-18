import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../mcp/server.ts', import.meta.url), 'utf8');

describe('README tool table', () => {
  it('lists the same tools mcp/server.ts registers, in the same order', () => {
    const registered = [...serverSource.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((match) => match[1]);
    const section = readme.split('## MCP tools')[1]?.split('\n## ')[0] ?? '';
    const listed = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(registered).toHaveLength(18);
    expect(listed).toEqual(registered);
  });
});
