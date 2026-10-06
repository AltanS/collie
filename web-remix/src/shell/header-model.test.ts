/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { HeaderModel, UNCLAIMED, type HeaderClaim } from "./header-model";

function counted(model: HeaderModel): () => number {
  let n = 0;
  model.addEventListener("change", () => n++);
  return () => n;
}

describe("HeaderModel", () => {
  test("starts unclaimed", () => {
    const model = new HeaderModel();
    expect(model.current).toBe(UNCLAIMED);
    expect(model.held).toBe(false);
  });

  test("last claim wins", () => {
    const model = new HeaderModel();
    const a = model.owner();
    const b = model.owner();
    a.claim({ wordmark: true, width: "column" });
    b.claim({ width: "wide" });
    expect(model.current.wordmark).toBe(false);
    expect(model.current.width).toBe("wide");
  });

  test("a stale release is a no-op, in either order of one navigation", () => {
    const model = new HeaderModel();
    const leaving = model.owner();
    leaving.claim({ wordmark: true });
    const arriving = model.owner();
    arriving.claim({ width: "wide" }); // the arriving claim lands first
    leaving.release(); // then the leaving teardown
    expect(model.current.width).toBe("wide");
    expect(model.held).toBe(true);
    arriving.release();
    expect(model.current).toBe(UNCLAIMED);
    expect(model.held).toBe(false);
  });

  test("the owner's signal releases it, and a claim after abort does nothing", () => {
    const model = new HeaderModel();
    const ctl = new AbortController();
    const owner = model.owner(ctl.signal);
    owner.claim({ wordmark: true });
    ctl.abort();
    expect(model.current).toBe(UNCLAIMED);
    owner.claim({ wordmark: true });
    expect(model.current).toBe(UNCLAIMED);
  });

  test("an aborted stale owner does not release the current one", () => {
    const model = new HeaderModel();
    const ctl = new AbortController();
    model.owner(ctl.signal).claim({ wordmark: true });
    model.owner().claim({ width: "wide" });
    ctl.abort();
    expect(model.current.width).toBe("wide");
  });

  test("an equal claim wakes nobody; a changed slot field does", () => {
    const model = new HeaderModel();
    const changes = counted(model);
    const owner = model.owner();
    const home = (): void => {};
    const claim = (name: string): HeaderClaim => ({
      center: { kind: "pane", name, workspace: "collie", status: "working", agent: "claude" },
      right: { kind: "menu", label: "Pane menu" },
      width: "wide",
      home,
    });
    owner.claim(claim("claude"));
    owner.claim(claim("claude"));
    owner.claim(claim("claude"));
    expect(changes()).toBe(1);
    owner.claim(claim("codex"));
    expect(changes()).toBe(2);
    expect(model.current.center).toMatchObject({ kind: "pane", name: "codex" });
  });

  test("a fresh callback is a change (claims carry callbacks made once in setup)", () => {
    const model = new HeaderModel();
    const changes = counted(model);
    const owner = model.owner();
    owner.claim({ home: () => {} });
    owner.claim({ home: () => {} });
    expect(changes()).toBe(2);
  });

  test("a release when nothing differs from unclaimed fires no change", () => {
    const model = new HeaderModel();
    const changes = counted(model);
    const owner = model.owner();
    owner.claim({});
    owner.release();
    expect(changes()).toBe(0);
  });
});
