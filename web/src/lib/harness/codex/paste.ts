// Codex replaces a sufficiently large paste with one atomic token while keeping the full payload
// internally: `[Pasted Content N chars]` (optionally suffixed ` #2`, ` #3`, … when equal-sized
// placeholders coexist). This is public, documented Codex TUI behavior. The reply guard cannot find
// the original text on screen in that state, so the exact Unicode character count is supplemental
// evidence that THIS send reached the composer. It never accepts surrounding text or a mismatched
// count, and it only widens evidence after a real Codex composer has already been located.

const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const PASTED_CONTENT = /^\[Pasted Content ([1-9]\d*) chars\](?: #(?:[2-9]|[1-9]\d+))?$/;

// Herdr 0.8.0's pane.send_text path accepted only the first 1,024 bytes of one live-probed write.
// Stay below that boundary and below Codex's >1,000-character paste-placeholder threshold. Each
// chunk remains a complete Unicode scalar sequence, so no UTF-8 character is split across RPCs.
export const CODEX_INPUT_CHUNK_BYTES = 900;
export const CODEX_CHUNK_SETTLE_MS = 35;

function utf8Bytes(char: string): number {
  const codePoint = char.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function codexInputChunks(text: string): string[] {
  if (text === "") return [];
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (parts.length > 0 && bytes + size > CODEX_INPUT_CHUNK_BYTES) {
      chunks.push(parts.join(""));
      parts = [];
      bytes = 0;
    }
    parts.push(char);
    bytes += size;
  }
  if (parts.length > 0) chunks.push(parts.join(""));
  return chunks;
}

export function codexDraftCarriesSend(sent: string, draft: string): boolean {
  const match = PASTED_CONTENT.exec(draft.trim());
  if (match === null) return false;
  const count = Number(match[1]);
  return count > LARGE_PASTE_CHAR_THRESHOLD && count === [...sent].length;
}
