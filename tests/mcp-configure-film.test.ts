/**
 * Guards the shape of the configure_film form.
 *
 * These assertions exist because three specific things broke while building it
 * and each failure was silent rather than loud:
 *
 *  - format:'uri' on the reference image rejected a plain local path
 *  - the tool count in the docs drifted behind the registry
 *  - a declined form has to be distinguishable from an unanswered one, because
 *    the skill tells the model not to render on either
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(
  path.join(__dirname, '..', 'mcp', 'server.ts'),
  'utf8',
);

describe('configure_film', () => {
  it('does not constrain the reference image field to uri format', () => {
    // A chat attachment resolves to a path like /workspace/photo.png, which
    // fails a uri check with: must match format "uri".
    const formBlock = serverSource.slice(
      serverSource.indexOf('const FILM_FORM_SCHEMA'),
      serverSource.indexOf('server.registerTool(\n  "configure_film"'),
    );
    expect(formBlock).toContain('referenceImage');
    // Strip comments first: the source explains the format:"uri" bug in a note,
    // and the note must not count as the code doing it.
    const codeOnly = formBlock
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/format:\s*"uri"/);
  });

  it('asks for every field the skill promises to collect', () => {
    const formBlock = serverSource.slice(
      serverSource.indexOf('const FILM_FORM_SCHEMA'),
      serverSource.indexOf('server.registerTool(\n  "configure_film"'),
    );
    for (const field of [
      'scene',
      'characters',
      'style',
      'shotCount',
      'shotSeconds',
      'aspectRatio',
      'audio',
      'neverShow',
      'referenceImage',
    ]) {
      expect(formBlock).toContain(`${field}: {`);
    }
  });

  it('only requires the scene, so a user can accept the defaults', () => {
    expect(serverSource).toContain('required: ["scene"]');
  });

  it('labels the returned cost as an estimate', () => {
    expect(serverSource).toContain('isEstimate: true');
  });

  it('tells the caller not to render on a decline or cancel', () => {
    expect(serverSource).toContain('The user dismissed the form. Do not render.');
    expect(serverSource).toContain('The user cancelled. Do not render.');
  });

  it('falls back to text when the client has no elicitation capability', () => {
    expect(serverSource).toContain('getClientCapabilities');
    expect(serverSource).toContain('elicitationSupported: false');
  });
});

describe('skill and docs', () => {
  const skill = readFileSync(
    path.join(__dirname, '..', 'skills', 'theshow', 'SKILL.md'),
    'utf8',
  );

  it('has the skill call configure_film before spending anything', () => {
    expect(skill).toContain('configure_film');
    expect(skill).toContain('Step 0');
  });

  it('warns that the form takes a path, not a file upload', () => {
    expect(skill.toLowerCase()).toContain('no file');
  });
});
