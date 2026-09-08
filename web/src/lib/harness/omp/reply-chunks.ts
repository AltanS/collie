import { graphemeSegmenter } from "../../env";

export function ompOpaqueDraft(draft: string): boolean {
  return /^(?:📄\s*#\d+|\[Paste #\d+(?:, (?:\+\d+ lines|\d+ chars))?\])$/.test(draft.trim());
}

// OMP's editor collapses large bracketed pastes into opaque numbered chips.
// The rendered chip has no length or content evidence, so never use it to
// authorise Enter. Keep each transport paste small, retaining the literal echo.
// OMP tui/editor.ts collapses >10 lines or >1000 UTF-16 units; leave headroom.
export function ompReplyChunks(text: string): string[] {
  const segmenter = graphemeSegmenter();
  const characters = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  const chunks: string[] = [];
  let chunk = "";
  let newlines = 0;
  for (const character of characters) {
    const count = (character.match(/\n/g) ?? []).length;
    // OMP may insert a space before a paste starting with /, ~ or . after a
    // word. Do not create such a prefix at an artificial transport boundary.
    // Pathological runs can exceed the target size; literal verification still
    // refuses a collapsed chip rather than changing the user's message.
    if (chunk && !/^[/~.]/.test(character) && (chunk.length + character.length > 512 || newlines + count > 4)) {
      chunks.push(chunk);
      chunk = "";
      newlines = 0;
    }
    chunk += character;
    newlines += count;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [text];
}
