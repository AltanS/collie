// The sign-in field of `/login` (profile.ts `FrameLayout.secret`): the profile grammar, the check of a
// masked or scrolled field, the Surface the fold reads off the lab captures of 2026-11-15, and the two
// cards the field's screens lift into (harness/sign-in-card.ts, harness/claude/login-methods.ts).
// Captured on Claude Code 2.1.325, pi 1.3.0 and omp 18.6.1 with empty config folders; every `state`
// and `code_challenge` value in the fixtures is `X`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentOf, idleFor, readScreen, rowsOf } from "../../test/surface-corpus";
import { lineText } from "../blocks";
import { buildBlocks } from "../harness";
import { adapterFor } from "../harness/registry";
import { detectSignInCard } from "../harness/sign-in-card";
import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
import { paneSurface, unreachable } from "../send-slot";
import { foldSurface, type SurfaceInput } from "./fold";
import { askOf } from "./surface";
import { parseProfile, ProfileError } from "./profile";
import { fieldShows, maskedText } from "./secret-field";

const PANES = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const PROFILES = join(import.meta.dirname, "profiles");

function screen(name: string) {
  const harness = name.split("--")[0]!;
  const rows = rowsOf(readFileSync(join(PANES, name), "utf8"));
  return { harness, rows, read: readScreen(rows, agentOf(harness), idleFor(harness)) };
}

function raw(harness: string): JsonObject {
  return parseJsonObject(readFileSync(join(PROFILES, `${harness}.json`), "utf8"))!;
}

function change(node: JsonObject, path: readonly (string | number)[], value: JsonValue | undefined): JsonObject {
  const copy: JsonObject = JSON.parse(JSON.stringify(node));
  let at: JsonValue | undefined = copy;
  for (const key of path.slice(0, -1)) at = Array.isArray(at) ? at[Number(key)] : asJsonObject(at)?.[String(key)];
  const last = path.at(-1)!;
  if (Array.isArray(at)) at[Number(last)] = value ?? null;
  else if (value === undefined) delete asJsonObject(at)![String(last)];
  else asJsonObject(at)![String(last)] = value;
  return copy;
}

function failure(node: JsonValue): ProfileError {
  try {
    parseProfile(node);
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("parseProfile accepted a bad profile");
}

const SECRET = ["idle", "frameAlternates", 0, "secret"] as const;

describe("the profile grammar of a sign-in field", () => {
  it("reads the three profiles' sign-in layouts", () => {
    for (const harness of ["claude", "pi", "omp"]) {
      const layout = parseProfile(raw(harness)).idle.frameAlternates?.[0];
      expect(layout?.secret, harness).toBeDefined();
      expect(layout?.answers, harness).toBe(true);
      expect(layout?.newlineSubmits, harness).toBe(true);
    }
    expect(parseProfile(raw("claude")).idle.frameAlternates?.[0]?.secret?.mask).toEqual({ glyph: "*", clear: 6, cut: "…" });
  });

  it("refuses a sign-in field that does not answer, or that a line break would not submit", () => {
    expect(failure(change(raw("claude"), ["idle", "frameAlternates", 0, "answers"], undefined)).message).toMatch(/answers and newlineSubmits/u);
    expect(failure(change(raw("claude"), ["idle", "frameAlternates", 0, "newlineSubmits"], undefined)).message).toMatch(/answers and newlineSubmits/u);
  });

  it("refuses a mask glyph or cut of more than one character, a bad lead and a tail that is not true", () => {
    expect(failure(change(raw("claude"), [...SECRET, "mask", "glyph"], "**")).message).toMatch(/one character/u);
    expect(failure(change(raw("claude"), [...SECRET, "mask", "cut"], "...")).message).toMatch(/one character/u);
    expect(failure(change(raw("claude"), [...SECRET, "mask", "clear"], -1)).path).toMatch(/clear/u);
    expect(failure(change(raw("pi"), [...SECRET, "lead"], "[unclosed")).path).toMatch(/lead/u);
    expect(failure(change(raw("pi"), [...SECRET, "tail"], false)).path).toMatch(/tail/u);
  });

  it("keeps `precedes` to the alternates", () => {
    expect(failure(change(raw("pi"), ["idle", "frame", "precedes"], true)).message).toMatch(/frameAlternates/u);
  });
});

describe("whether a field shows the typed text", () => {
  const claude = { mask: { glyph: "*", clear: 6, cut: "…" } } as const;
  it("draws a mask as the glyph for each hidden character and the last ones as typed", () => {
    expect(maskedText("abcdefghij", claude.mask)).toBe("****efghij");
    expect(maskedText("abc", claude.mask)).toBe("abc");
  });

  it("takes a masked field by its length and its clear tail, never by a guess at the hidden part", () => {
    expect(fieldShows("****efghij", "abcdefghij", claude)).toBe(true);
    expect(fieldShows("***defghij", "abcdefghij", claude)).toBe(false);
    expect(fieldShows("****efghiX", "abcdefghij", claude)).toBe(false);
    expect(fieldShows("", "abcdefghij", claude)).toBe(false);
  });

  it("takes a cut row only when it is all mask and shorter than the text", () => {
    const long = "x".repeat(80);
    expect(fieldShows(`${"*".repeat(27)}…`, long, claude)).toBe(true);
    expect(fieldShows(`${"*".repeat(26)}x…`, long, claude)).toBe(false);
    expect(fieldShows(`${"*".repeat(80)}…`, long, claude)).toBe(false);
  });

  it("takes a scrolled field by the end of the text, and only a long enough end", () => {
    const pi = { tail: true } as const;
    const text = "http://localhost:53692/callback?code=abcdefghijklmnopqrstuvwxyz0123456789";
    expect(fieldShows(text.slice(-40), text, pi)).toBe(true);
    expect(fieldShows(text.slice(-8), text, pi)).toBe(false);
    expect(fieldShows("not the end of it at all, no", text, pi)).toBe(false);
    expect(fieldShows("short", "short", pi)).toBe(true);
  });
});

describe("the Surface of a sign-in screen", () => {
  for (const name of [
    "claude--v2325-login-url--w61.txt",
    "claude--v2325-login-console-url--w61.txt",
    "pi--v130-login-browser-url--w61.txt",
    "pi--v130-login-headless-url--w61.txt",
    "pi--v130-login-api-key--w61.txt",
    "omp--v18-6-1-login-url--w61.txt",
  ]) {
    it(`${name}: a free field, named as a sign-in field`, () => {
      expect(screen(name).read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
    });
  }

  for (const [name, text] of [
    ["claude--v2325-login-url-typed--w61.txt", "***************ESTATE"],
    ["pi--v130-login-headless-pasted-long--w61.txt", "abcdefghij-_FAKE#FAKEstateAbCdEfGhIjKlMnOpQrStUvWxYz012345"],
  ] as const) {
    it(`${name}: the field's own text is the draft, not the panel above it`, () => {
      const { read } = screen(name);
      expect(read.surface).toMatchObject({ composer: "draft", field: "secret" });
      expect(read.frame?.interior.text).toBe(text);
    });
  }

  it("pi's editor after a failed sign-in is the editor again, with no field", () => {
    const { read } = screen("pi--v130-login-bad-code--w61.txt");
    expect(read.surface.field).toBeUndefined();
    expect(read.surface.composer).toBe("empty");
  });
});

describe("the sign-in card", () => {
  for (const name of [
    "claude--v2325-login-url--w61.txt",
    "claude--v2325-login-url-typed--w120.txt",
    "claude--v2325-login-console-url--w61.txt",
    "pi--v130-login-browser-url--w61.txt",
    "pi--v130-login-headless-url--w61.txt",
    "omp--v18-6-1-login-url--w61.txt",
  ]) {
    it(`${name}: the sign-in address is one link, whole, first`, () => {
      const { harness, rows } = screen(name);
      const card = detectSignInCard(rows, idleFor(harness)!);
      expect(card).not.toBeNull();
      const links = card!.model.text.flat().filter((run) => run.kind === "link");
      // omp adds its local shortcut (`http://localhost:…/launch`) as a second link.
      expect(links.length).toBeGreaterThanOrEqual(1);
      const href = links[0]!.kind === "link" ? links[0]!.href : "";
      expect(href).toMatch(/^https:\/\/[a-z.]+\/(?:cai\/)?oauth\/authorize\?/u);
      expect(href).toContain("code_challenge_method=S256&state=XXXX");
      expect(href).not.toMatch(/\s/u);
    });
  }

  it("names the panel: Claude's title row, pi's title row, omp's box label", () => {
    const title = (name: string) => {
      const { harness, rows } = screen(name);
      return detectSignInCard(rows, idleFor(harness)!)?.model.title;
    };
    expect(title("claude--v2325-login-url--w61.txt")).toBe("Login");
    expect(title("pi--v130-login-browser-url--w61.txt")).toBe("Login to Anthropic");
    expect(title("omp--v18-6-1-login-url--w61.txt")).toBe("Login to Anthropic (Claude Pro/Max)");
  });

  it("never holds what was typed: the field row is the composer's", () => {
    const { harness, rows } = screen("pi--v130-login-headless-pasted-long--w61.txt");
    const card = detectSignInCard(rows, idleFor(harness)!);
    const words = card!.model.text.flat().map((run) => run.text).join(" ");
    expect(words).not.toContain("FAKE");
    expect(words).toContain("Paste the code Anthropic shows after you sign in:");
  });

  it("is a box-text block on each adapter, and stays off every screen with no field", () => {
    for (const name of ["claude--v2325-login-url--w61.txt", "pi--v130-login-browser-url--w61.txt", "omp--v18-6-1-login-url--w61.txt"]) {
      const { harness, rows } = screen(name);
      expect(adapterFor(agentOf(harness))!.buildBlocks(rows).map((block) => block.kind), name).toEqual(["raw", "box-text"]);
    }
    for (const name of ["pi--v130-login-bad-code--w61.txt", "claude--v2325-login-bad-code--w61.txt", "pi--v110-idle.txt"]) {
      const { harness, rows } = screen(name);
      expect(adapterFor(agentOf(harness))!.buildBlocks(rows).some((block) => block.kind === "box-text"), name).toBe(false);
    }
  });
});

describe("Claude Code 2.1.325's sign-in method picker", () => {
  const card = (name: string) => {
    const { harness, rows } = screen(name);
    const block = adapterFor(agentOf(harness))!.buildBlocks(rows).find((b) => b.kind === "prompt-select");
    return block?.kind === "prompt-select" ? block.prompt : null;
  };

  it("lifts the first list as a choice card whose buttons press the option's digit", () => {
    const prompt = card("claude--v2325-login-methods--w61.txt");
    expect(prompt?.question).toBe("Select login method:");
    expect(prompt?.caption).toBe("Login");
    expect(prompt?.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(prompt?.options[0]?.label).toBe("Claude account with subscription · Individual, Team, or Enterprise");
  });

  it("lifts the Console list the same way, Go back included", () => {
    const prompt = card("claude--v2325-login-console-methods--w61.txt");
    expect(prompt?.question).toBe("How do you want to sign in?");
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Sign in with your Console account (recommended)",
      "Create an API key (legacy) · adds a key to your Console workspace",
      "Go back",
    ]);
  });
});

// ── The first run (an empty config folder) ─────────────────────────────────────────────────────────
// Claude Code 2.1.325 started with an empty `CLAUDE_CONFIG_DIR` shows its onboarding, not the `/login`
// modal: the theme step, then the same method lists and the same sign-in field, with no rule, no
// `Login` title and no `Esc to cancel` (Esc does nothing there). Lab 2026-11-15 at 40, 61 and 120
// columns (claude--v2325-first-run-*). The same three things read as the same cards, and the field
// keeps the same secret rules. A long code wraps under the field's label instead of being cut.

/** The rows of a fixture as plain text, for building a screen around them. */
function textsOf(name: string): string[] {
  return screen(name).rows.map(lineText);
}

function readTexts(harness: string, texts: readonly string[]) {
  return readScreen(rowsOf(texts.join("\n")), agentOf(harness), idleFor(harness));
}

describe("the first run's sign-in field", () => {
  const wrapping = { mask: { glyph: "*", clear: 6 }, wrap: true } as const;

  it("reads `wrap` and `signInRows` in the profile grammar, and refuses bad ones", () => {
    const claude = parseProfile(raw("claude"));
    expect(claude.idle.frameAlternates?.[1]?.secret).toEqual({ mask: { glyph: "*", clear: 6 }, wrap: true });
    expect(claude.idle.signInRows).toEqual(["^Paste code here if prompted >"]);
    expect(failure(change(raw("claude"), ["idle", "frameAlternates", 1, "secret", "wrap"], false)).path).toBe("idle.frameAlternates[1].secret.wrap");
    expect(failure(change(raw("claude"), ["idle", "signInRows"], ["^\\s*$"])).path).toBe("idle.signInRows[0]");
  });

  it("takes wrapped rows by their length and their clear tail, the tail no longer than the last row", () => {
    // 21 characters at 40 columns: `********`, `********`, `STATE` (lab): the last row holds five.
    expect(fieldShows("******** ******** STATE", "FAKECODEFORTESTESTATE", wrapping)).toBe(true);
    expect(fieldShows("***************ESTATE", "FAKECODEFORTESTESTATE", wrapping)).toBe(true);
    expect(fieldShows("******** ******** STATE", "FAKECODEFORTESTXSTATE", wrapping)).toBe(true);
    expect(fieldShows("******** ******** STATX", "FAKECODEFORTESTESTATE", wrapping)).toBe(false);
    expect(fieldShows("******** ******** TATE", "FAKECODEFORTESTESTATE", wrapping)).toBe(false);
    expect(fieldShows("******** *******A STATE", "FAKECODEFORTESTESTATE", wrapping)).toBe(false);
    expect(fieldShows("******** ****** ESTATE", "FAKECODEFORTESTESTATE", { mask: { glyph: "*", clear: 6 } })).toBe(false);
  });

  for (const name of [
    "claude--v2325-first-run-url--w40.txt",
    "claude--v2325-first-run-url--w61.txt",
    "claude--v2325-first-run-url--w120.txt",
    "claude--v2325-first-run-console-url--w61.txt",
  ]) {
    it(`${name}: a free field, named as a sign-in field, under the same link card`, () => {
      const { harness, rows, read } = screen(name);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
      expect(read.frame?.secret).toEqual({ mask: { glyph: "*", clear: 6 }, wrap: true });
      const card = detectSignInCard(rows, idleFor(harness)!);
      const links = card!.model.text.flat().filter((run) => run.kind === "link");
      expect(links).toHaveLength(1);
      const href = links[0]!.kind === "link" ? links[0]!.href : "";
      expect(href).toMatch(/^https:\/\/[a-z.]+\/(?:cai\/)?oauth\/authorize\?code=true&client_id=/u);
      expect(href).toMatch(/code_challenge_method=S256&state=X{43}$/u);
      expect(card!.model.title.startsWith("Browser didn't open? Use the")).toBe(true);
      expect(adapterFor(agentOf(harness))!.buildBlocks(rows).map((block) => block.kind).at(-1)).toBe("box-text");
    });
  }

  for (const [name, text] of [
    ["claude--v2325-first-run-url-typed--w61.txt", "***************ESTATE"],
    ["claude--v2325-first-run-url-typed--w40.txt", "******** ******** STATE"],
    ["claude--v2325-first-run-url-pasted--w61.txt", `${"*".repeat(29)} ${"*".repeat(29)} ${"*".repeat(29)} ******ateEND`],
  ] as const) {
    it(`${name}: the field's rows are the draft, and the card never shows them`, () => {
      const { harness, rows, read } = screen(name);
      expect(read.surface).toMatchObject({ composer: "draft", field: "secret" });
      expect(read.frame?.interior.text).toBe(text);
      const words = detectSignInCard(rows, idleFor(harness)!)!.model.text.flat().map((run) => run.text).join(" ");
      expect(words).not.toContain("***");
      expect(words).not.toContain("Paste code here");
    });
  }

  // An account folder the bridge makes (`shared`, links to the default folder's settings) with
  // `tui: "fullscreen"`: a hint row (`Hold Shift … native copy`, one row or two) stands between the
  // address and the field. Lab 2026-11-16, M102 spec 09; the address's query masked as `X`.
  for (const width of [61, 80, 120, 200, 219]) {
    const name = `claude--v2325-first-run-url-fullscreen--w${width}.txt`;
    it(`${name}: the hint row over the field leaves the field a free secret field`, () => {
      const { harness, rows, read } = screen(name);
      expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
      expect(read.frame?.secret).toEqual({ mask: { glyph: "*", clear: 6 }, wrap: true });
      const card = detectSignInCard(rows, idleFor(harness)!);
      expect(card!.model.title.startsWith("Browser didn't open? Use the")).toBe(true);
    });
  }

  it("a row under the field that is not its own wrapped text leaves no field", () => {
    const texts = textsOf("claude--v2325-first-run-url-typed--w61.txt");
    const at = texts.findIndex((text) => text.startsWith(" Paste code here"));
    const under = [...texts.slice(0, at + 1), "  one more status row"];
    expect(readTexts("claude", under).frame).toBeNull();
  });
});

describe("fail closed: a sign-in prompt no layout reads still names the field", () => {
  it("the first-run field with its anchor rows scrolled away: no box, but the field is named", () => {
    const texts = textsOf("claude--v2325-first-run-url-typed--w61.txt");
    const at = texts.findIndex((text) => text.startsWith(" Paste code here"));
    const read = readTexts("claude", texts.slice(at - 4));
    expect(read.frame).toBeNull();
    expect(read.surface.composer).toBe("unknown");
    expect(read.surface.field).toBe("secret");
  });

  it("a field drawn at another indent: no layout, the field named all the same", () => {
    const texts = textsOf("claude--v2325-first-run-url--w61.txt").map((text) => (text.startsWith(" Paste code here") ? `   ${text.trimStart()}` : text));
    const read = readTexts("claude", texts);
    expect(read.frame).toBeNull();
    expect(read.surface.field).toBe("secret");
  });

  it("an ordinary chat line that holds the words over a live input box names nothing", () => {
    const name = "claude-lab--idle-after-turn--w200.txt";
    const texts = textsOf(name);
    const base = readTexts("claude", texts);
    expect(base.frame).not.toBeNull();
    const top = base.frame!.top;
    const quoted = [...texts.slice(0, top), "  Paste code here if prompted > is what the login screen says", "", ...texts.slice(top)];
    const read = readTexts("claude", quoted);
    expect(read.frame).not.toBeNull();
    expect(read.frame?.secret).toBeUndefined();
    expect(read.surface.field).toBeUndefined();
    expect(read.surface.composer).toBe("empty");
  });

  it("the theme step, the method lists and the `/login` lists name no field", () => {
    for (const name of [
      "claude--v2325-first-run-theme--w61.txt",
      "claude--v2325-first-run-methods--w61.txt",
      "claude--v2325-first-run-console-methods--w61.txt",
      "claude--v2325-login-methods--w61.txt",
      "claude--v2325-login-bad-code--w61.txt",
    ]) {
      expect(screen(name).read.surface.field, name).toBeUndefined();
    }
  });
});

describe("the first run's sign-in method lists", () => {
  const card = (name: string) => {
    const { harness, rows } = screen(name);
    const block = adapterFor(agentOf(harness))!.buildBlocks(rows).find((b) => b.kind === "prompt-select");
    return block?.kind === "prompt-select" ? block.prompt : null;
  };
  const FIRST = ["Claude account with subscription · Individual, Team, or Enterprise", "Anthropic Console account · API usage billing", "3rd-party platform · Bedrock, Microsoft Foundry, Google Vertex AI"];

  for (const name of [
    "claude--v2325-first-run-methods--w40.txt",
    "claude--v2325-first-run-methods--w61.txt",
    "claude--v2325-first-run-methods--w120.txt",
    "claude--v2325-first-run-methods-moved2--w61.txt",
    "claude--v2325-first-run-methods-moved3--w61.txt",
  ]) {
    it(`${name}: the same choice card, a digit per option, wrapped labels joined`, () => {
      const prompt = card(name);
      expect(prompt?.question).toBe("Select login method:");
      expect(prompt?.caption).toBeUndefined();
      expect(prompt?.options.map((option) => option.label)).toEqual(FIRST);
      expect(prompt?.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"]]);
    });
  }

  it("the Console list after `2`, Go back included", () => {
    expect(card("claude--v2325-first-run-console-methods--w61.txt")?.options.map((option) => option.label)).toEqual([
      "Sign in with your Console account (recommended)",
      "Create an API key (legacy) · adds a key to your Console workspace",
      "Go back",
    ]);
  });

  it("not the third-party list (no question, a row under it), the theme step is its own card, and `/login` keeps its caption", () => {
    expect(card("claude--v2325-first-run-thirdparty-methods--w61.txt")).toBeNull();
    expect(card("claude--v2325-first-run-theme--w61.txt")?.question).toBe("Choose the text style that looks best with your terminal");
    expect(card("claude--v2325-login-methods--w61.txt")?.caption).toBe("Login");
  });

  it("not a numbered list at the end of a screen with no welcome row over it", () => {
    const texts = textsOf("claude--v2325-first-run-methods--w61.txt");
    const at = texts.findIndex((text) => text.includes("Claude Code can be used"));
    expect(card("claude--v2325-first-run-methods--w61.txt")).not.toBeNull();
    const rows = rowsOf(texts.slice(at).join("\n"));
    expect(adapterFor(agentOf("claude"))!.buildBlocks(rows).some((block) => block.kind === "prompt-select")).toBe(false);
  });
});

// The first run's theme step names no key and has no footer. It lifts as a pointed list
// (harness/claude/first-run-theme.ts): a tap walks the pointer and sends Enter, measured live, and no
// unread-dialog card with its Esc (which does nothing there) is shown. The Claude profile's
// `idle.dialogRows` still names its words, so the composer never types into it. `/theme` in a session
// showed the unread-dialog card before and still does.
describe("the first run's theme step is a choice card", () => {
  const THEMES = [
    "Auto (match terminal)",
    "Dark mode",
    "Light mode",
    "Dark mode (colorblind-friendly)",
    "Light mode (colorblind-friendly)",
    "Dark mode (ANSI colors only)",
    "Light mode (ANSI colors only)",
  ];
  const kinds = (name: string) => buildBlocks(screen(name).rows, { agent: "claude" }).map((block) => block.kind);

  for (const name of [
    "claude--v2325-first-run-theme--w40.txt",
    "claude--v2325-first-run-theme--w61.txt",
    "claude--v2325-first-run-theme-moved--w61.txt",
  ]) {
    it(`${name}: the modal is read, and the choice card shows with no Esc`, () => {
      const { surface } = screen(name).read;
      const options = THEMES.map((label, at) => ({ id: String(at + 1), label }));
      expect(surface).toMatchObject({ composer: "unknown", modal: { ask: { kind: "question", channel: "keys", options } } });
      expect(surface.reason).toBeUndefined();
      expect(kinds(name)).toEqual(["raw", "prompt-select"]);
      const block = buildBlocks(screen(name).rows, { agent: "claude" }).find((b) => b.kind === "prompt-select");
      const keys = block?.kind === "prompt-select" ? block.prompt.options.flatMap((option) => option.keys) : [];
      expect(keys).not.toContain("Escape");
    });
  }

  for (const name of ["claude--v2325-theme-command--w40.txt", "claude--v2325-theme-command--w61.txt"]) {
    it(`${name}: \`/theme\` in a session reads as before, with no help from \`dialogRows\``, () => {
      const texts = textsOf(name);
      expect(texts.some((text) => text.includes("Let's get started"))).toBe(false);
      expect(screen(name).read.surface).toMatchObject({ turn: "unknown", modal: "unreadable", composer: "unknown" });
      expect(kinds(name)).toEqual(["unread-dialog"]);
    });
  }

  it("the same words in the chat over a live box name no dialog", () => {
    const texts = textsOf("claude-lab--idle-after-turn--w200.txt");
    const base = readTexts("claude", texts);
    const top = base.frame!.top;
    const read = readTexts("claude", [...texts.slice(0, top), "Let's get started.", "", ...texts.slice(top)]);
    expect(read.frame).not.toBeNull();
    expect(read.surface.modal).toBe(base.surface.modal);
    expect(read.surface.modal).toBe("none");
  });

  it("the theme step without its words reads as it did: no card", () => {
    const texts = textsOf("claude--v2325-first-run-theme--w61.txt").filter((text) => !text.includes("Let's get started"));
    expect(readTexts("claude", texts).surface.modal).toBe("unknown");
    expect(buildBlocks(rowsOf(texts.join("\n")), { agent: "claude" }).map((block) => block.kind)).toEqual(["raw"]);
  });

  it("the profile grammar refuses a dialog row that matches a blank row", () => {
    expect(failure(change(raw("claude"), ["idle", "dialogRows"], ["^\\s*$"])).message).toMatch(/idle\.dialogRows\[0\]/u);
    expect(failure(change(raw("claude"), ["idle", "dialogRows"], "Let's")).message).toMatch(/idle\.dialogRows/u);
  });
});

// A stale read never downgrades a sign-in field (M102 spec 09): the phone's picture of the screen may be
// a moment old (a slow poll, a hook edge newer than the read), and a code typed then must still keep no
// draft and no line. Turn, modal and composer go unknown as for any stale read; the field stays. A
// stale read never adds the field, and the first fresh read without it drops it at once.
describe("a stale read keeps the sign-in field, and only the sign-in field", () => {
  const CODE_SCREEN = screen("claude--v2325-first-run-url-fullscreen--w219.txt").rows;
  const IDLE_BOX = screen("claude-lab--idle-after-turn--w200.txt").rows;
  const context = { idle: idleFor("claude"), pollMs: 1000 };
  const read = (seq: number, at: number, rows: typeof CODE_SCREEN): SurfaceInput => ({ seq, source: "screen", at, revision: seq, rows, ask: null });
  const STALE_SECRET = { revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale", field: "secret" };

  it("a code screen read that went stale on the clock keeps `field: secret`", () => {
    expect(foldSurface([read(1, 0, CODE_SCREEN)], context).surface).toMatchObject({ composer: "empty", field: "secret" });
    expect(foldSurface([read(1, 0, CODE_SCREEN), { seq: 2, source: "tick", at: 2001 }], context).surface).toEqual(STALE_SECRET);
  });

  it("a code screen read made stale by a hook edge keeps `field: secret`", () => {
    expect(foldSurface([read(1, 0, CODE_SCREEN), { seq: 2, source: "edge", at: 5000, kind: "reread" }], context).surface).toEqual(STALE_SECRET);
  });

  it("a stale read of an ordinary box adds no field", () => {
    const surface = foldSurface([read(1, 0, IDLE_BOX), { seq: 2, source: "tick", at: 2001 }], context).surface;
    expect(surface).toMatchObject({ composer: "unknown", reason: "stale" });
    expect(surface.field).toBeUndefined();
  });

  it("the first fresh read after the code screen is gone drops the field at once", () => {
    const log: SurfaceInput[] = [read(1, 0, CODE_SCREEN), { seq: 2, source: "tick", at: 2001 }, read(3, 2100, IDLE_BOX)];
    const surface = foldSurface(log, context).surface;
    expect(surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(surface.field).toBeUndefined();
  });

  it("a box the phone cannot reach (a host refusal, sending off) keeps the field it was read with, and adds none", () => {
    const secret = { revision: 4, turn: "idle", modal: "none", composer: "empty", field: "secret" } as const;
    expect(unreachable(secret)).toEqual({ revision: 4, turn: "unknown", modal: "unknown", composer: "unreachable", field: "secret" });
    expect(paneSurface(secret, true, "the host is away").surface.field).toBe("secret");
    expect(paneSurface(secret, false, undefined).surface.field).toBe("secret");
    expect(unreachable({ revision: 4, turn: "idle", modal: "none", composer: "empty" }).field).toBeUndefined();
  });
});

// `/login` opened INSIDE a running conversation, in a wide pane (field case 2026-11-16: the lead pane on
// Herdr, Claude Code 2.1.325). The panel stands under the transcript: the conversation's rows, the echoed
// `❯ /login`, then the rule, `Login`, the address wrapped at the pane's edge, the field and `Esc to cancel`.
// Captured at 220 columns in a scratch session (claude--v2325-login-url-in-session--w220.txt, the address's
// client_id, code_challenge and state masked); the other widths are the same rows wrapped as Claude draws
// them, under a wide transcript with or without a spinner row above the panel.
describe("the sign-in field opened by /login inside a running conversation", () => {
  const IN_SESSION = "claude--v2325-login-url-in-session--w220.txt";
  const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "gu");
  const plain = (name: string): string[] => readFileSync(join(PANES, name), "utf8").replace(SGR_RE, "").split("\n");
  /** The masked address, joined from the capture's wrapped rows. */
  const address = (): string => {
    const rows = plain(IN_SESSION);
    const from = rows.findIndex((row) => row.startsWith("https://claude.com/"));
    let to = from;
    while (to < rows.length && rows[to]!.trim() !== "") to++;
    return rows.slice(from, to).join("");
  };
  /** A wide conversation's rows (the lab's idle pane at 200 columns), its box and footer left out. */
  const transcript = (): string[] => plain("claude-lab--idle-after-turn--w200.txt").slice(0, 12);
  /** The panel as Claude draws it at `width` columns, the field holding `typed`. */
  const panel = (width: number, typed = ""): string[] => {
    const url = address();
    const wrapped: string[] = [];
    for (let at = 0; at < url.length; at += width) wrapped.push(url.slice(at, at + width));
    const notice = "  Browser didn't open? Use the url below to sign in (c to copy)";
    const noticeRows = notice.length <= width ? [notice] : [notice.slice(0, width), `  ${notice.slice(width).trimStart()}`];
    return ["─".repeat(width), "  Login", "", ...noticeRows, "", ...wrapped, "", "", `  Paste code here if prompted >${typed === "" ? "" : ` ${typed}`}`, "", "  Esc to cancel", "", "", ""];
  };
  const read = (rows: readonly string[]) => readScreen(rowsOf(rows.join("\n")), "claude", idleFor("claude"));

  it("the capture: a free sign-in field under the transcript, and the sign-in card", () => {
    const { rows, read: got } = screen(IN_SESSION);
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
    expect(detectSignInCard(rows, idleFor("claude")!)?.model.title).toBe("Login");
  });

  for (const width of [61, 120, 160, 219]) {
    it(`${String(width)} columns under a wide transcript: the sign-in field, empty and typed`, () => {
      expect(read([...transcript(), "", "❯ /login", "", ...panel(width)]).surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
      const typed = read([...transcript(), "", "❯ /login", "", ...panel(width, "***************ESTATE")]);
      expect(typed.surface).toMatchObject({ composer: "draft", field: "secret" });
      expect(typed.frame?.interior.text).toBe("***************ESTATE");
    });

    it(`${String(width)} columns with a spinner or a background task row above the panel: still the sign-in field`, () => {
      expect(read([...transcript(), "", "✻ Zigzagging… (3m 21s · ↓ 11.6k tokens)", "", ...panel(width)]).surface.field).toBe("secret");
      expect(read([...transcript(), "", "● Bash(sleep 600) running in background", "", ...panel(width)]).surface).toMatchObject({ modal: "none", field: "secret" });
    });

    it(`${String(width)} columns: the method list before it is still a card to tap`, () => {
      const methods = plain("claude--v2325-login-methods--w61.txt");
      const rule = methods.findIndex((row) => /^─+$/u.test(row));
      const got = read([...transcript(), "", "❯ /login", "", "─".repeat(width), ...methods.slice(rule + 1)]);
      expect(got.surface.field).toBeUndefined();
      const ask = askOf(got.surface.modal);
      expect(ask?.options.map((option) => option.id)).toEqual(["1", "2", "3"]);
    });
  }

  // A wrong `secret` read on an ordinary box would stop its drafts and receipts: only the real panel counts.
  for (const width of [61, 120, 219]) {
    it(`${String(width)} columns: a transcript that quotes the panel's words, over an ordinary box, is no sign-in field`, () => {
      const box = ["─".repeat(width), "❯ ", "─".repeat(width), "  ⏵⏵ auto mode on (shift+tab to cycle)"];
      const quoted = ["● The panel showed:", "", "─".repeat(width), "  Login", "", "  Paste code here if prompted >", "", "  Esc to cancel", "", "● Done."];
      expect(read([...transcript(), "", ...quoted, "", ...box]).surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      expect(read([...transcript(), "", ...quoted, "", ...box]).surface.field).toBeUndefined();
      expect(read([...transcript(), "", "  Paste code here if prompted >", "", ...box]).surface.field).toBeUndefined();
      const draft = read([...transcript(), "", "─".repeat(width), "❯ it said Paste code here if prompted >", "─".repeat(width), "  ⏵⏵ auto mode on (shift+tab to cycle)"]);
      expect(draft.surface).toMatchObject({ composer: "draft" });
      expect(draft.surface.field).toBeUndefined();
    });
  }

  for (const name of ["claude-lab--idle-after-turn--w200.txt", "claude--v2303-titled-edge-idle--w160.txt", "claude--v2303-permission-bash-bg-agent-rm--w160.txt"]) {
    it(`${name}: an ordinary box or a permission dialog is no sign-in field`, () => {
      expect(screen(name).read.surface.field).toBeUndefined();
    });
  }
});
