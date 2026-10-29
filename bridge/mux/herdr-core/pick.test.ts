import { describe, expect, test } from "bun:test";
import { declinedLine, drivesHerdrCore, herdrCoreInPlaceOfTui, lookForHerdrCore, resolveMux, type PickHost } from "./pick.ts";

const HOME = "/home/dev";
const TUI = "/home/dev/.config/herdr/herdr.sock";
const ENV = { XDG_RUNTIME_DIR: "/run/user/7" };
const CORE = "/run/user/7/herdr-core/default.sock";
const TUI_CONFIG = "/home/dev/.config/herdr/config.toml";
const PLUGINS = "/home/dev/.config/herdr/plugins/config";

/** A host where exactly `files` exist, and `dirs` list the names given. */
function host(files: readonly string[], dirs: Readonly<Record<string, readonly string[]>> = {}): PickHost {
  return { home: HOME, exists: (path) => files.includes(path), list: (dir) => dirs[dir] ?? [] };
}

describe("herdr-core in place of the Herdr TUI", () => {
  test("only the core socket and no Herdr TUI at all: herdr-core, with both paths in the reason", () => {
    const pick = herdrCoreInPlaceOfTui(TUI, ENV, host([CORE]));
    expect(pick?.mux).toBe("herdr-core");
    expect(pick?.socket).toBe(CORE);
    expect(pick?.evidence).toBe(`a herdr-core socket at ${CORE}, and no Herdr socket at ${TUI}`);
  });

  test("both sockets: the default stands, and the reason names the Herdr socket", () => {
    const look = lookForHerdrCore(TUI, ENV, host([CORE, TUI]));
    expect(look).toEqual({ kind: "declined", socket: CORE, reason: `a Herdr socket at ${TUI}` });
    expect(herdrCoreInPlaceOfTui(TUI, ENV, host([CORE, TUI]))).toBeNull();
  });

  test("TUI socket absent but Herdr's config.toml present: the default stands, said once", () => {
    const look = lookForHerdrCore(TUI, ENV, host([CORE, TUI_CONFIG]));
    expect(look).toEqual({ kind: "declined", socket: CORE, reason: `this host has a Herdr TUI install (${TUI_CONFIG})` });
    expect(declinedLine(look)).toBe(
      `a herdr-core socket at ${CORE}, not picked: this host has a Herdr TUI install (${TUI_CONFIG}); set COLLIE_MUX=herdr-core to drive it`,
    );
  });

  test("TUI socket absent but a Collie plugin config dir under Herdr's: the default stands", () => {
    for (const name of ["herdr.collie", "herdr.collie-next"]) {
      const look = lookForHerdrCore(TUI, ENV, host([CORE], { [PLUGINS]: ["herdr.pouch", name] }));
      expect(look.kind).toBe("declined");
      if (look.kind === "declined") expect(look.reason).toContain(`${PLUGINS}/${name}`);
    }
    // Another plugin's dir is not a Collie TUI install.
    expect(lookForHerdrCore(TUI, ENV, host([CORE], { [PLUGINS]: ["herdr.pouch", "herdr.collieish"] })).kind).toBe("picked");
  });

  test("a stale core socket on a host with no Herdr TUI is still picked; it then reads as unreachable", () => {
    // Nothing is dialled: the file is the evidence, live or not. Accepted, and documented in pick.ts.
    expect(herdrCoreInPlaceOfTui(TUI, ENV, host([CORE]))?.socket).toBe(CORE);
  });

  test("no core socket: nothing to pick and nothing to say, whatever else is here", () => {
    expect(lookForHerdrCore(TUI, ENV, host([]))).toEqual({ kind: "absent" });
    expect(lookForHerdrCore(TUI, ENV, host([TUI, TUI_CONFIG]))).toEqual({ kind: "absent" });
    expect(declinedLine({ kind: "absent" })).toBeNull();
  });

  test("HC_SESSION and the endpoint variable name the socket that counts", () => {
    const session = { ...ENV, HC_SESSION: "lab" };
    expect(herdrCoreInPlaceOfTui(TUI, session, host(["/run/user/7/herdr-core/lab.sock"]))?.socket).toBe("/run/user/7/herdr-core/lab.sock");
    const named = { ...ENV, COLLIE_MUX_ENDPOINT_HERDR_CORE: "/srv/core.sock" };
    expect(herdrCoreInPlaceOfTui(TUI, named, host(["/srv/core.sock"]))?.socket).toBe("/srv/core.sock");
    expect(herdrCoreInPlaceOfTui(TUI, named, host([CORE]))).toBeNull();
  });
});

describe("resolveMux, the bridge's and `collie status`'s answer", () => {
  test("named wins, and says nothing", () => {
    expect(resolveMux(TUI, { ...ENV, COLLIE_MUX: "tmux" }, host([CORE]), "linux")).toEqual({
      mux: "tmux",
      pickedBecause: "",
      pickedSocket: "",
      notPickedBecause: "",
    });
  });

  test("picked, with the socket and the reason", () => {
    const r = resolveMux(TUI, ENV, host([CORE]), "linux");
    expect(r.mux).toBe("herdr-core");
    expect(r.pickedSocket).toBe(CORE);
    expect(r.pickedBecause).toContain(CORE);
  });

  test("declined: the default, with the line that says why", () => {
    const r = resolveMux(TUI, ENV, host([CORE, TUI_CONFIG]), "linux");
    expect(r.mux).toBe("herdr");
    expect(r.notPickedBecause).toContain("Herdr TUI install");
  });

  test("Windows keeps the default without a look", () => {
    expect(resolveMux(TUI, ENV, host([CORE]), "win32").mux).toBe("herdr");
  });
});

describe("does this environment drive herdr-core", () => {
  test("a COLLIE_MUX that names it, whatever sockets exist", () => {
    expect(drivesHerdrCore(TUI, { ...ENV, COLLIE_MUX: "herdr-core" }, host([CORE, TUI, TUI_CONFIG]))).toBe(true);
  });

  test("a COLLIE_MUX that names another multiplexer, even where only the core is", () => {
    expect(drivesHerdrCore(TUI, { ...ENV, COLLIE_MUX: "tmux" }, host([CORE]))).toBe(false);
    expect(drivesHerdrCore(TUI, { ...ENV, COLLIE_MUX: "herdr" }, host([CORE]))).toBe(false);
  });

  test("no name: a Herdr TUI install keeps its herdr steps while its socket is briefly gone", () => {
    expect(drivesHerdrCore(TUI, ENV, host([CORE, TUI_CONFIG]))).toBe(false);
    expect(drivesHerdrCore(TUI, ENV, host([CORE], { [PLUGINS]: ["herdr.collie"] }))).toBe(false);
  });

  test("no name and no Herdr TUI: the sockets decide", () => {
    expect(drivesHerdrCore(TUI, ENV, host([CORE]))).toBe(true);
    expect(drivesHerdrCore(TUI, ENV, host([CORE, TUI]))).toBe(false);
    expect(drivesHerdrCore(TUI, ENV, host([]))).toBe(false);
  });
});
