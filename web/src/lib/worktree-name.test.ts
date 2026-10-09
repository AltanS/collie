import { BRANCH_ADJECTIVES, BRANCH_NOUNS, branchOffName, mintRequestId } from "./worktree-name";

// The prefilled branch of "New agent in a worktree" (ADR 0089). The bridge refuses a name that would
// read as a flag or that Git refuses (bridge/worktree-branch.ts), so every name minted here must be
// one it accepts: lowercase words, one slash, dashes, hex.

const MINTED_BRANCH = /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/u;

describe("branchOffName", () => {
  it("is worktree/<adjective>-<noun>-<4 hex>", () => {
    for (let i = 0; i < 200; i++) expect(branchOffName()).toMatch(MINTED_BRANCH);
  });

  it("draws its words from Collie's two lists", () => {
    const name = branchOffName();
    const [adjective, noun] = name.slice("worktree/".length).split("-");
    expect(BRANCH_ADJECTIVES).toContain(adjective);
    expect(BRANCH_NOUNS).toContain(noun);
  });

  it("is pinned by the random source, at both ends of its range", () => {
    expect(branchOffName(() => 0)).toBe(`worktree/${BRANCH_ADJECTIVES[0]}-${BRANCH_NOUNS[0]}-0000`);
    expect(branchOffName(() => 0.999_999_9)).toBe(
      `worktree/${BRANCH_ADJECTIVES.at(-1)}-${BRANCH_NOUNS.at(-1)}-ffff`,
    );
  });

  it("keeps two lists of about two dozen short, plain words", () => {
    for (const list of [BRANCH_ADJECTIVES, BRANCH_NOUNS]) {
      expect(list.length).toBeGreaterThanOrEqual(20);
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z]{3,8}$/u);
    }
  });
});

describe("mintRequestId", () => {
  it("is a version-4 UUID, fresh each time", () => {
    const a = mintRequestId();
    const b = mintRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(a).not.toBe(b);
  });
});
