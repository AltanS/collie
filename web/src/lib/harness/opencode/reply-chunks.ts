import { graphemeSegmenter } from "../../env";

// opencode's editor is not known to collapse large pastes into an opaque chip in any captured state
// (the draft is always the user's words — see chrome.ts's draftIsOpaque). The chunking below is
// therefore the same conservative transport split omp's uses, minus omp's own quirks: keep each
// transport paste small enough that the literal echo stays on screen for the reply guard to verify,
// and never end a chunk where the next begins with a character that could read as an accidental
// command. If a capture ever shows opencode collapsing a paste, capture it and teach the adapter
// rather than raising these bounds.
const MAX_CHUNK_CHARS = 512;
const MAX_CHUNK_NEWLINES = 4;

export function opencodeReplyChunks(text: string): string[] {
  const segmenter = graphemeSegmenter();
  const characters = segmenter
    ? Array.from(segmenter.segment(text), (s) => s.segment)
    : Array.from(text);
  const chunks: string[] = [];
  let chunk = "";
  let newlines = 0;
  for (const character of characters) {
    const count = (character.match(/\n/g) ?? []).length;
    // Do not start a new chunk on a character that could read as a leading slash/tilde/dot token at
    // the boundary: the box renders the boundary invisibly, so the split must not manufacture text.
    if (
      chunk &&
      !/^[/~.]/.test(character) &&
      (chunk.length + character.length > MAX_CHUNK_CHARS || newlines + count > MAX_CHUNK_NEWLINES)
    ) {
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
