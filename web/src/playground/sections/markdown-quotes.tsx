// Blockquotes section of the states playground (PR 684): agent prose with a quote in it, drawn by the
// real `MarkdownText`, one sample per card. The fix under review makes a quote's body render as
// blocks (a list, a code block, a table, an inner quote) instead of one run-on italic line, so each
// card names the one thing to look at. The section uses only `MarkdownText` and the card helpers, so
// the same file compiles on the branch and on main, and the two can be put side by side on a phone.

import { MarkdownText } from "@/components/markdown-text";

import { Card, Group, Section, type SectionDef } from "../layout";
import { PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "markdown-quotes",
  title: "Blockquotes",
  intent:
    "Agent prose with a quote in it, as Chat draws it. Before the fix a quote's whole body ran " +
    "together as one italic line: the bullets, the code and the table lost their shape. Now the body " +
    "is drawn as blocks, so a list stays a list, code stays upright and a table stays a table. A " +
    "one-line quote is the control and must look the same as before.",
};

// Written as lines and joined, not as template literals, because two samples hold a code fence and a
// backtick would end a template literal early. One line is one source line, so a sample reads as the
// agent printed it.
const lines = (...rows: readonly string[]): string => rows.join("\n");

const FIXTURES = {
  prBody: lines(
    "I opened the pull request. This is the body I sent:",
    "",
    "> **Fix the retry loop in sync.ts**",
    ">",
    "> - The last error is now rethrown after the final attempt",
    "> - The empty list test reaches the loader",
    "> - The changelog has its line",
    "",
    "The checks are running now. I will report when they finish.",
  ),
  code: lines(
    "The build failed, and the log says why:",
    "",
    "> The web bundle needs a rebuild before the service sees the change. Run these two commands:",
    ">",
    "> ```bash",
    "> cd collie && bun run build",
    "> systemctl --user restart collie-next",
    "> ```",
    ">",
    "> Then reload the page on the phone.",
    "",
    "I did not run them, because the service is live.",
  ),
  nested: lines(
    "The reviewer and the author disagree. Here is the thread:",
    "",
    "> The reviewer says the retry should stop after three attempts.",
    ">",
    "> > The author says five attempts match the old behaviour.",
    ">",
    "> The reviewer asks for a test that proves it either way.",
    "",
    "I will add the test and keep five.",
  ),
  oneLine: lines(
    "The issue reporter wrote one line:",
    "",
    "> The send button does nothing after I rotate the phone.",
    "",
    "I could not repeat this on the dev lane.",
  ),
  table: lines(
    "The two builds differ in size. This is the report I got:",
    "",
    "> | Build | Size |",
    "> | --- | --- |",
    "> | stable | 57 MB |",
    "> | edge | 58 MB |",
    "",
    "The edge build is 1 MB larger.",
  ),
} as const;

/** One sample in a phone-width box with a little room, as a Chat bubble gives agent prose. */
function Sample({ text }: { text: string }) {
  return (
    <PhoneMock>
      <div className="p-3 text-sm">
        <MarkdownText text={text} />
      </div>
    </PhoneMock>
  );
}

export function MarkdownQuotesSection() {
  return (
    <Section def={DEF}>
      <Group title="Quotes">
        <Card
          state="quote-with-bullets"
          label="A quoted PR body with bullets: the bold line, a gap, then three bullets, all inside the quote"
          reach="ask an agent to open a pull request and show the body it sent"
        >
          <Sample text={FIXTURES.prBody} />
        </Card>

        <Card
          state="quote-with-code"
          label="A quote with a code block: the two commands sit upright, not in italics"
          reach="ask an agent to quote a log or a note that holds a shell snippet"
        >
          <Sample text={FIXTURES.code} />
        </Card>

        <Card
          state="quote-nested"
          label="A nested quote: the inner quote sits one step in, the last sentence is back at the outer level"
          reach="ask an agent to quote a review thread that answers an earlier comment"
        >
          <Sample text={FIXTURES.nested} />
        </Card>

        <Card
          state="quote-one-line-control"
          label="A one-line quote (control, must look as before)"
          reach="ask an agent to quote one line of an issue"
        >
          <Sample text={FIXTURES.oneLine} />
        </Card>

        <Card
          state="quote-with-table"
          label="A quote with a table: two columns and two rows, still a table"
          reach="ask an agent to quote a report that holds a table"
        >
          <Sample text={FIXTURES.table} />
        </Card>
      </Group>
    </Section>
  );
}
