// Minimal excerpt of a real Herdr recent/ANSI capture, 2026-09-20. The prompt has
// a full-width background-only row above AND below it; text-only fixtures hide it.
export const codexPaddingScreen = [
  '• Verification complete. Keep this transcript.',
  '',
  '\x1b[48;2;65;69;76m' + ' '.repeat(104) + '\x1b[0m',
  '\x1b[48;2;65;69;76m› \x1b[2mAsk Codex to do anything\x1b[0m',
  '\x1b[48;2;65;69;76m' + ' '.repeat(104) + '\x1b[0m',
  '  gpt-6-astra medium · ~/Project/chat · Context 42% used',
].join('\r\n');
