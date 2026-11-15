// The sign-in field of `/login` (profile.ts `FrameLayout.secret`): the profile grammar, the check of a
// masked or scrolled field, the Surface the fold reads off the lab captures of 2026-11-15, and the two
// cards the field's screens lift into (harness/sign-in-card.ts, harness/claude/login-methods.ts).
// Captured on Claude Code 2.1.325, pi 1.3.0 and omp 18.6.1 with empty config folders; every `state`
// and `code_challenge` value in the fixtures is `X`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentOf, idleFor, readScreen, rowsOf } from "../../test/surface-corpus";
import { adapterFor } from "../harness/registry";
import { detectSignInCard } from "../harness/sign-in-card";
import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
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
