import { describe, expect, test } from "bun:test";

import { encodeSessionId } from "../events/session-id.ts";
import { idOf, resolveSession, type PaneSighting, type SessionView } from "./ids.ts";

const MACHINE = "inst-test-a1";

/** A view over invented panes: `[muxSession, paneId, token | null]`. */
function view(panes: readonly (readonly [string, string, string | null])[], machine = MACHINE): SessionView {
  return {
    machine: () => machine,
    panes: (): PaneSighting[] => panes.map(([muxSession, paneId]) => ({ muxSession, paneId })),
    instanceOf: (muxSession, paneId) => panes.find(([s, p]) => s === muxSession && p === paneId)?.[2] ?? null,
  };
}

describe("resolveSession", () => {
  test("found: the pane whose pane id and token both match, in whichever mux session holds it", () => {
    const id = idOf(MACHINE, "w1:p2", "k3f9");
    const result = resolveSession(id, view([["main", "w1:p2", "zz00"], ["other", "w1:p2", "k3f9"], ["main", "w1:p3", "k3f9"]]));
    expect(result).toEqual({ ok: true, id, muxSession: "other", paneId: "w1:p2", instance: "k3f9" });
  });

  test("idOf is the bus's own id", () => {
    expect(idOf(MACHINE, "%7", "ab12")).toBe(encodeSessionId({ machine: MACHINE, paneId: "%7", instance: "ab12" }));
  });

  test("unknown: no pane with that pane id", () => {
    expect(resolveSession(idOf(MACHINE, "w9:p9", "k3f9"), view([["main", "w1:p2", "k3f9"]]))).toEqual({ ok: false, code: "api.session_unknown" });
  });

  test("unknown: another machine's id, even when a pane here has the same pane id and token", () => {
    expect(resolveSession(idOf("inst-test-b2", "w1:p2", "k3f9"), view([["main", "w1:p2", "k3f9"]]))).toEqual({ ok: false, code: "api.session_unknown" });
  });

  test("replaced: the pane id is held now by a pane with another token, or with none", () => {
    const id = idOf(MACHINE, "w1:p2", "k3f9");
    expect(resolveSession(id, view([["main", "w1:p2", "q7r1"]]))).toEqual({ ok: false, code: "api.session_replaced" });
    expect(resolveSession(id, view([["main", "w1:p2", null]]))).toEqual({ ok: false, code: "api.session_replaced" });
  });

  test("unknown: malformed text, a bare pane id, a WalkyTalky address, another spelling of an id", () => {
    const panes = view([["main", "w1:p2", "k3f9"]]);
    const good = idOf(MACHINE, "w1:p2", "k3f9");
    for (const text of ["", "w1:p2", "local/w1:p2#k3f9", "ses_", "ses_!!!", `${good}=`, good.toUpperCase(), `ses_${"A".repeat(600)}`]) {
      expect(resolveSession(text, panes)).toEqual({ ok: false, code: "api.session_unknown" });
    }
  });

  test("two panes with one pane id and one token (a broken invariant) resolve to nothing", () => {
    expect(resolveSession(idOf(MACHINE, "w1:p2", "k3f9"), view([["a", "w1:p2", "k3f9"], ["b", "w1:p2", "k3f9"]]))).toEqual({ ok: false, code: "api.session_unknown" });
  });
});
