/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { createIdentitySeed, identityOf } from "./identity-seed";

const ORIGIN = "http://collie.test";

describe("identityOf", () => {
  test("a pane is keyed by its id inside its scope", () => {
    expect(identityOf("/pane/w1%3Ap1", ORIGIN)).toBe(identityOf("/pane/w1:p1", ORIGIN));
    expect(identityOf("/pane/w1:p1", ORIGIN)).not.toBe(identityOf("/pane/w1:p2", ORIGIN));
    expect(identityOf("/pane/w1:p1", ORIGIN)).not.toBe(identityOf("/pane/w1:p1?h=minibuch", ORIGIN));
  });
  test("the dashboard is its own identity, per scope", () => {
    expect(identityOf("/", ORIGIN)).toBe(identityOf("/?all=1", ORIGIN)); // breadth is not identity
    expect(identityOf("/", ORIGIN)).not.toBe(identityOf("/?h=minibuch", ORIGIN));
    expect(identityOf("/", ORIGIN)).not.toBe(identityOf("/pane/w1:p1", ORIGIN));
  });
  test("a pane id with a slash-free odd shape still resolves", () => {
    expect(identityOf("/pane/a%2Fb", ORIGIN)).toBe(identityOf("/pane/a%2Fb?x=1", ORIGIN));
  });
});

describe("createIdentitySeed", () => {
  interface Props {
    path: string;
    note: string;
  }

  function rig() {
    const applied: string[] = [];
    const seed = createIdentitySeed<Props>((props) => void applied.push(props.note), ORIGIN);
    return { applied, seed };
  }

  test("seeds the first time", () => {
    const { applied, seed } = rig();
    expect(seed.held()).toBeNull();
    expect(seed.ensure({ path: "/pane/w1:p1", note: "a" })).toBe(true);
    expect(applied).toEqual(["a"]);
  });

  test("the same page again is not seeded: the polls have moved the stores on since", () => {
    const { applied, seed } = rig();
    seed.ensure({ path: "/pane/w1:p1", note: "a" });
    expect(seed.ensure({ path: "/pane/w1:p1", note: "b" })).toBe(false);
    expect(applied).toEqual(["a"]);
  });

  test("another pane under the same island re-seeds", () => {
    const { applied, seed } = rig();
    seed.ensure({ path: "/pane/w1:p1", note: "first" });
    expect(seed.ensure({ path: "/pane/w1:p2", note: "second" })).toBe(true);
    expect(applied).toEqual(["first", "second"]);
    expect(seed.held()).toBe(identityOf("/pane/w1:p2", ORIGIN));
  });

  test("going back to the first pane re-seeds it again", () => {
    const { applied, seed } = rig();
    seed.ensure({ path: "/pane/w1:p1", note: "one" });
    seed.ensure({ path: "/pane/w1:p2", note: "two" });
    expect(seed.ensure({ path: "/pane/w1:p1", note: "one again" })).toBe(true);
    expect(applied).toEqual(["one", "two", "one again"]);
  });

  test("the same pane in another scope re-seeds, and so does the dashboard to a pane", () => {
    const { applied, seed } = rig();
    seed.ensure({ path: "/", note: "home" });
    expect(seed.ensure({ path: "/pane/w1:p1", note: "pane" })).toBe(true);
    expect(seed.ensure({ path: "/pane/w1:p1?h=minibuch", note: "member pane" })).toBe(true);
    expect(applied).toEqual(["home", "pane", "member pane"]);
  });
});
