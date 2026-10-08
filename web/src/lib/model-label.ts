// The pane's model, as the small label above the belt says it.
//
// The bridge sends the model in the harness's own words (`PaneWire.model`): an id such as
// `claude-opus-5-5`, a `provider:model` pair from opencode and pi (`openrouter:openai/gpt-5.6-sol`),
// or the display name a Claude `/model` printed ("Fable 5.1", "Opus 5 (1M context)"). The label has
// room for one short word and a number, so this keeps the model's own name and drops the rest: the
// provider and gateway prefixes, a `[1m]` tag, a parenthesis, Claude's date suffix. Claude's ids are
// the one family rewritten into the words Claude Code itself shows ("Opus 5.5"); every other name is
// printed as the harness wrote it, because a guess at a vendor's casing is a wrong label.
//
// TEXT ONLY. The name comes out of a transcript on disk, so control characters are removed and the
// result is capped; React renders it as a text node and nothing ever parses it.

/** Longest label drawn. The element truncates too; this bounds what a strange file can put there. */
const MAX = 32;

const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i;

/** The short label for a pane's model, or null when there is nothing to show. */
export function modelLabel(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let name = raw
    // ANSI sequences first, whole, then any control character left over.
    // oxlint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  // `provider:model` and `gateway/vendor/model` both end in the model's own name.
  name = name.slice(Math.max(name.lastIndexOf(":"), name.lastIndexOf("/")) + 1).trim();
  if (name === "" || name === "<synthetic>") return null;
  const claude = CLAUDE_ID.exec(name);
  if (claude !== null) {
    const family = claude[1] ?? "";
    const word = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
    name = claude[3] === undefined ? `${word} ${claude[2] ?? ""}` : `${word} ${claude[2] ?? ""}.${claude[3]}`;
  }
  return name.length > MAX ? `${name.slice(0, MAX - 1)}…` : name;
}
