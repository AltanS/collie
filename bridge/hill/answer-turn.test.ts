import { describe, expect, test as it } from "bun:test";

import { answeredDecisionId } from "../../web/src/lib/hill/answer-turn.ts";
import { answerMessage, messageTitle, readItLine, withCrewLine } from "./service.ts";

// The phone reads the first line of Collie's own answer message (web/src/lib/hill/answer-turn.ts). Every case here builds the
// text with the writer, `answerMessage` in bridge/hill/service.ts, so a change to that line breaks this file.

const ID = "dc_5k9vtcwnrp3z";
const TITLE = 'Use the new version of "hadoken"?';

describe("answeredDecisionId reads what answerMessage writes", () => {
  it.each([
    ["an option", answerMessage({ id: ID, title: "Use the new version of hadoken?" }, "on", "Use the new version", null)],
    ["the decline", answerMessage({ id: ID, title: "Switch on the trick hadoken?" }, "later", "Not now", null)],
    ["a dismiss", answerMessage({ id: ID, title: "Switch on the trick hadoken?" }, "dismiss", null, null)],
    ["a title with quote marks", answerMessage({ id: ID, title: TITLE }, "on", "Use the new version", null)],
    ["a title cut at its limit", answerMessage({ id: ID, title: "x".repeat(200) }, "on", "Yes", null)],
    ["the crew line after it", withCrewLine(answerMessage({ id: ID, title: "T?" }, "on", "Yes", null), "away")],
    ["the line of what Collie did", `${answerMessage({ id: ID, title: "T?" }, "on", "Yes", null)}\nhadoken is switched on.`],
  ])("%s", (_, message) => {
    expect(answeredDecisionId(message)).toBe(ID);
  });

  it("reads the title through messageTitle's cut", () => {
    const first = answerMessage({ id: ID, title: "y".repeat(200) }, "on", "Yes", null).split("\n")[0]!;
    expect(first).toBe(`Answer to ${ID} "${messageTitle("y".repeat(200))}"`);
  });

  it("does not read the form for another session (no title), which a trick card never uses", () => {
    const other = answerMessage({ id: ID, title: "T?" }, "on", "Yes", null, false);
    expect(other).toContain(readItLine(ID));
    expect(answeredDecisionId(other)).toBeNull();
  });
});

describe("answeredDecisionId is exact", () => {
  it.each([
    ["no id", 'Answer to "T?"'],
    ["a short id", 'Answer to dc_abc "T?"'],
    ["a long id", 'Answer to dc_5k9vtcwnrp3zz "T?"'],
    ["an upper case id", 'Answer to dc_5K9VTCWNRP3Z "T?"'],
    ["the line is not first", `Stop.\nAnswer to ${ID} "T?"`],
    ["a word before it", `Re: Answer to ${ID} "T?"`],
    ["words after the title", `Answer to ${ID} "T?" and more`],
    ["no quotes", `Answer to ${ID} T?`],
    ["a plain message", "Stop and report what you changed."],
    ["an empty body", ""],
  ])("%s", (_, body) => {
    expect(answeredDecisionId(body)).toBeNull();
  });
});
