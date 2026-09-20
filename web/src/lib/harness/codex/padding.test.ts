import { describe, expect, it } from 'vitest';
import { parseAnsi } from '../../ansi';
import { lineText, splitLines } from '../../blocks';
import { codexPaddingScreen } from '../../../test/codex-padding';
import { composerPrompt, composerReady, extractInputDraft, stripChrome } from './chrome';

const lines = (text: string) => splitLines(parseAnsi(text));
describe('Codex composer background padding', () => {
  it('removes the full captured band while retaining its transcript', () => {
    const frame = lines(codexPaddingScreen);
    const visible = stripChrome(frame);
    expect(visible.map(lineText).join('\n')).toBe('• Verification complete. Keep this transcript.');
    expect(visible.flatMap((line) => line.segments).some((s) => s.bg !== undefined)).toBe(false);
    expect(composerReady(frame)).toBe(true);
    expect(extractInputDraft(frame)).toBeNull();
    expect(composerPrompt(frame)).toBe('› Ask Codex to do anything');
  });
  it('preserves submitted text and interior spacing while trimming separator blanks', () => {
    const prefix = '› Keep my submitted message\n\n';
    const frame = lines(prefix + codexPaddingScreen.replace('\r\n\r\n', '\r\n \r\n\r\n'));
    expect(stripChrome(frame).map(lineText).join('\n')).toBe(prefix + '• Verification complete. Keep this transcript.');
  });
  it('does not strip a coloured transcript row without a live composer', () => {
    const frame = lines('answer\n\x1b[48;2;65;69;76m    \x1b[0m');
    expect(stripChrome(frame)).toBe(frame);
  });
});
