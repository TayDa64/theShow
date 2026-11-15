import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('/theshow', () => {
  const command = read('commands/theshow.md');
  const film = read('commands/film.md');
  const skill = read('skills/theshow/SKILL.md');
  const exportView = read('src/components/ExportView.tsx');

  it('is the command the registry picks up, and it does not claim to open the form itself', () => {
    expect(command).toContain('configure_film');
    expect(command).toContain('board_film');
    expect(command).toContain('render_sequence');
    expect(command).toContain('/theshow');
    expect(command).toContain('does not open the form by itself');
    expect(film).toContain('same recipe');
    expect(skill).toContain('the show');
    expect(skill).not.toContain('Never show:');
  });

  it('keeps the storyboard render off the silent extend path', () => {
    const render = exportView.slice(
      exportView.indexOf('const renderStoryboardShot'),
      exportView.indexOf('const retryStoryboardShot'),
    );
    expect(render).toContain("'/api/generate-shot-video'");
    expect(render).toContain('confirm: true');
    expect(render).not.toContain("'/api/extend-clip'");
    expect(render).not.toContain("'/api/generate-shot-prompt'");
  });
});
