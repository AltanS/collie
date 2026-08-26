import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import {
  locateSlashPalette,
  slashComposerReady,
  slashInputDraft,
  slashPromptRegion,
} from "./slash";

const BG = "\x1b[48;2;61;64;64m";
const RESET = "\x1b[0m";
const SELECTED = "\x1b[1m\x1b[38;5;6m";

function palette(
  command = "/status",
  options: ReadonlyArray<readonly [string, string]> = [
    ["/status", "show current session configuration and token usage"],
    ["/statusline", "configure which items appear in the status line"],
  ],
): string {
  return [
    "some output",
    `${BG}                                                            ${RESET}`,
    `${BG}\x1b[1m›${RESET}${BG} ${command}                                             ${RESET}`,
    `${BG}                                                            ${RESET}`,
    ...options.map(([name, description], index) =>
      index === 0
        ? `  ${SELECTED}${name}  ${description}${RESET}`
        : `  /\x1b[1m${name!.slice(1, command.length)}${RESET}${name!.slice(command.length)}  \x1b[2m${description}${RESET}`,
    ),
  ].join("\n");
}

describe("Codex exact slash palette", () => {
  it.each([
    [
      "/status",
      [
        ["/status", "show current session configuration and token usage"],
        ["/statusline", "configure which items appear in the status line"],
      ],
    ],
    ["/fast", [["/fast", "1.5x speed, increased usage"]]],
    ["/model", [["/model", "choose a model and reasoning effort"]]],
    ["/compact", [["/compact", "summarize the conversation"]]],
    ["/new", [["/new", "start a new conversation"]]],
    ["/help", [["/help", "show available commands"]]],
  ] as const)("recognizes and binds %s", (command, options) => {
    const lines = splitLines(parseAnsi(palette(command, options)));
    expect(locateSlashPalette(lines)).toMatchObject({ command });
    expect(slashComposerReady(lines)).toBe(true);
    expect(slashInputDraft(lines)).toBe(command);
    expect(slashPromptRegion(lines)).toContain(`› ${command}\n`);
    expect(slashPromptRegion(lines)?.trimEnd().endsWith(options.at(-1)![1])).toBe(true);
  });

  it("rejects a partial filter even when its first result is selected", () => {
    const lines = splitLines(parseAnsi(palette("/sta")));
    expect(locateSlashPalette(lines)).toBeNull();
  });

  it("rejects prompt prose without the renderer signature or exact selected option", () => {
    const plain = splitLines(
      parseAnsi(["› /status", "", "  /status  show current status"].join("\n")),
    );
    expect(locateSlashPalette(plain)).toBeNull();

    const wrong = splitLines(
      parseAnsi(palette("/status", [["/statusline", "configure the status line"]])),
    );
    expect(locateSlashPalette(wrong)).toBeNull();
  });

  it("rejects missing renderer rows, unbounded options, and output below the palette", () => {
    const valid = palette("/fast", [["/fast", "1.5x speed, increased usage"]]);
    expect(
      locateSlashPalette(
        splitLines(
          parseAnsi(valid.replace(`${BG}                                                            ${RESET}\n`, "")),
        ),
      ),
    ).toBeNull();
    expect(
      locateSlashPalette(
        splitLines(
          parseAnsi(
            palette(
              "/fast",
              Array.from({ length: 13 }, (_, index) => [
                index === 0 ? "/fast" : `/fast-${index}`,
                `option ${index}`,
              ]),
            ),
          ),
        ),
      ),
    ).toBeNull();
    expect(locateSlashPalette(splitLines(parseAnsi(`${valid}\nordinary output`)))).toBeNull();
  });
});
