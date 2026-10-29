import { describe, expect, test } from "bun:test";
import { herdrCoreInPlaceOfTui } from "./pick.ts";

const TUI = "/home/dev/.config/herdr/herdr.sock";
const ENV = { XDG_RUNTIME_DIR: "/run/user/7" };
const CORE = "/run/user/7/herdr-core/default.sock";

describe("herdr-core in place of the Herdr TUI", () => {
  test("only the core socket: herdr-core, with both paths in the reason", () => {
    const pick = herdrCoreInPlaceOfTui(TUI, ENV, (path) => path === CORE);
    expect(pick?.mux).toBe("herdr-core");
    expect(pick?.socket).toBe(CORE);
    expect(pick?.evidence).toContain(CORE);
    expect(pick?.evidence).toContain(TUI);
  });

  test("the TUI socket is there: the default stands, even with a core beside it", () => {
    expect(herdrCoreInPlaceOfTui(TUI, ENV, () => true)).toBeNull();
  });

  test("neither socket: the default stands", () => {
    expect(herdrCoreInPlaceOfTui(TUI, ENV, () => false)).toBeNull();
  });

  test("HC_SESSION and the endpoint variable name the socket that counts", () => {
    const session = { ...ENV, HC_SESSION: "lab" };
    expect(herdrCoreInPlaceOfTui(TUI, session, (path) => path === "/run/user/7/herdr-core/lab.sock")?.socket).toBe("/run/user/7/herdr-core/lab.sock");
    const named = { ...ENV, COLLIE_MUX_ENDPOINT_HERDR_CORE: "/srv/core.sock" };
    expect(herdrCoreInPlaceOfTui(TUI, named, (path) => path === "/srv/core.sock")?.socket).toBe("/srv/core.sock");
    expect(herdrCoreInPlaceOfTui(TUI, named, (path) => path === CORE)).toBeNull();
  });
});
