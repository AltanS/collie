// The sign-in address check (Change login, M101): only an `https:` address on a host the adapter lists,
// with no credentials, no port and no space, under the length cap, opens; anything else is text to copy.
// The address comes whole from the wrapped captures of Claude Code 2.1.325 (every `state` and
// `code_challenge` value in them is `X`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentOf, rowsOf } from "../test/surface-corpus";
import type { BoxTextModel } from "./harness/box-text-model";
import { adapterFor } from "./harness/registry";
import { addressOfCard, MAX_ADDRESS_CHARS, openableAddress, signInAddress } from "./sign-in-address";

const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const CLAUDE_HOSTS = ["claude.com", "platform.claude.com"];

function cardOf(name: string): BoxTextModel {
  const harness = name.split("--")[0]!;
  const blocks = adapterFor(agentOf(harness))!.buildBlocks(rowsOf(readFileSync(join(PANES, name), "utf8")));
  const card = blocks.find((block) => block.kind === "box-text");
  if (card?.kind !== "box-text") throw new Error(`no sign-in card on ${name}`);
  return card.boxText;
}

describe("openableAddress", () => {
  it("opens an https address on a listed host", () => {
    expect(openableAddress("https://claude.com/cai/oauth/authorize?code=true", CLAUDE_HOSTS)).toBe("https://claude.com/cai/oauth/authorize?code=true");
    expect(openableAddress("https://platform.claude.com/oauth/authorize?x=1", CLAUDE_HOSTS)).toBe("https://platform.claude.com/oauth/authorize?x=1");
  });

  it("matches the host exactly, in any case, and never a neighbour or a sub-host", () => {
    expect(openableAddress("https://CLAUDE.com/a", CLAUDE_HOSTS)).toBe("https://claude.com/a");
    for (const text of ["https://evil.claude.com/a", "https://claude.com.evil.dev/a", "https://claudexcom/a", "https://example.com/?r=https://claude.com/"]) {
      expect(openableAddress(text, CLAUDE_HOSTS), text).toBeNull();
    }
  });

  it("refuses http, other schemes, credentials and a port", () => {
    for (const text of [
      "http://claude.com/a",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user@claude.com/a",
      "https://user:pass@claude.com/a",
      "https://claude.com:8443/a",
      "//claude.com/a",
    ]) {
      expect(openableAddress(text, CLAUDE_HOSTS), text).toBeNull();
    }
  });

  it("refuses a space, a control or a bidi character, an empty text and one over the cap", () => {
    expect(openableAddress("https://claude.com/a b", CLAUDE_HOSTS)).toBeNull();
    expect(openableAddress("https://claude.com/a\u0007", CLAUDE_HOSTS)).toBeNull();
    expect(openableAddress("https://claude.com/‮a", CLAUDE_HOSTS)).toBeNull();
    expect(openableAddress("", CLAUDE_HOSTS)).toBeNull();
    const long = `https://claude.com/${"a".repeat(MAX_ADDRESS_CHARS)}`;
    expect(openableAddress(long, CLAUDE_HOSTS)).toBeNull();
    expect(openableAddress(long.slice(0, MAX_ADDRESS_CHARS), CLAUDE_HOSTS)).not.toBeNull();
  });

  it("opens nothing with no hosts listed", () => {
    expect(openableAddress("https://claude.com/a", [])).toBeNull();
  });
});

describe("the address of a wrapped sign-in card", () => {
  it.each([
    ["claude--v2325-login-url--w61.txt", "https://claude.com/cai/oauth/authorize?code=true&client_id="],
    ["claude--v2325-login-url-typed--w120.txt", "https://claude.com/cai/oauth/authorize?code=true&client_id="],
    ["claude--v2325-login-console-url--w61.txt", "https://platform.claude.com/oauth/authorize?code=true&client_"],
  ])("%s: the rows the agent wrapped come back as one address that opens", (name, head) => {
    const card = cardOf(name);
    const text = addressOfCard(card);
    expect(text).not.toBeNull();
    expect(text!.startsWith(head)).toBe(true);
    // Whole: the last parameter of the address, after every wrapped row, is in it.
    expect(text).toMatch(/&state=X+$/u);
    expect(signInAddress(card, CLAUDE_HOSTS)).toEqual({ kind: "open", href: new URL(text!).href, text });
  });

  it("an address on a host the adapter does not list is text to copy", () => {
    const card = cardOf("claude--v2325-login-url--w61.txt");
    expect(signInAddress(card, ["platform.claude.com"])).toEqual({ kind: "copy", text: addressOfCard(card) });
  });

  it("a card with no link has no address", () => {
    expect(signInAddress({ title: "Login", phase: "filled", text: [[{ kind: "plain", text: "Paste code here" }]] }, CLAUDE_HOSTS)).toBeNull();
  });
});
