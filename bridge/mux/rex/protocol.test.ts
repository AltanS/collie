import { describe, expect, test } from "bun:test";

import {
  untestedRevisionNote,
  isDefaultWindowLabel,
  keepSgrOnly,
  parseClientCount,
  parseCreated,
  parseEvent,
  parseProcess,
  parseApiRevision,
  parseProgramStatus,
  parseSessions,
  parseView,
  primaryListener,
  saysNotFound,
  saysUnreachable,
  stripEscapes,
} from "./protocol.ts";

// Every sample below is what rex 0.0.1795019727 printed on 2026-11-19 (MUX_CONTRACT.md, source RX),
// trimmed to the fields that matter and with ids kept in their real shape.

const ESC = "\u001b";
const SESSION = "session:01a1f140-f804-7d10-b29f-4148f728927e";
const WINDOW = "window:01a1f140-f81b-7d32-b514-96b36173a993";
const BLOCK = "block:01a1f140-f806-773b-9076-0595c30b1120";

describe("the VT capture becomes grid text", () => {
  test("a run of blank cells written as cursor-forward becomes that many spaces", () => {
    // A row of Claude Code's trust dialog, as captured.
    const row = `${ESC}[1C${ESC}[0m${ESC}[38;2;153;153;153m${ESC}]8;id=zaxmda;https://code.claude.com/docs/en/security${ESC}\\Security guide${ESC}[0m\r\n`;
    expect(keepSgrOnly(row)).toBe(` ${ESC}[0m${ESC}[38;2;153;153;153mSecurity guide${ESC}[0m\n`);
    expect(keepSgrOnly(`take${ESC}[1Ca${ESC}[3Cmoment`)).toBe("take a   moment");
    expect(keepSgrOnly(`a${ESC}[Cb`)).toBe("a b");
  });

  test("rows end in \\n alone: the capture's \\r\\n loses its \\r", () => {
    expect(keepSgrOnly("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  test("colour survives, links and every other escape do not", () => {
    const text = `${ESC}[31mred${ESC}[0m ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}[2J${ESC}[H${ESC}(Bend${ESC}]0;title\u0007`;
    expect(keepSgrOnly(text)).toBe(`${ESC}[31mred${ESC}[0m link end`);
  });

  test("strip leaves the words and nothing else", () => {
    expect(stripEscapes(keepSgrOnly(`${ESC}[1;32mok${ESC}[0m${ESC}[2Cdone`))).toBe("ok  done");
  });

  test("a huge cursor-forward count is bounded", () => {
    expect(keepSgrOnly(`${ESC}[9999C`).length).toBe(1000);
  });
});

describe("listings", () => {
  test("sessions", () => {
    expect(parseSessions(JSON.stringify({ sessions: [{ session_id: SESSION, label: "collie-probe" }, { label: "no id" }] }))).toEqual([
      { sessionId: SESSION, label: "collie-probe" },
    ]);
    expect(() => parseSessions("{}")).toThrow();
  });

  test("a session's view: windows, blocks across layers, focus", () => {
    const view = parseView(
      JSON.stringify({
        revision: 1,
        session_id: SESSION,
        label: "collie-probe",
        active_window_id: WINDOW,
        windows: [
          {
            window_id: WINDOW,
            label: "main",
            focused_block_id: BLOCK,
            layers: [
              { layer_id: "layer:f", kind: "floating", blocks: [{ block_id: "block:float", label: "f", creator_name: "com.superlogical.terminal" }] },
              {
                layer_id: "layer:t",
                kind: "tiled",
                bounds: [0, 0, 1, 1],
                blocks: [{ block_id: BLOCK, label: "shell", creator_name: "com.superlogical.terminal", flavor: "com.superlogical.terminal.shell" }],
              },
            ],
          },
        ],
      }),
    );
    expect(view.activeWindowId).toBe(WINDOW);
    expect(view.windows[0]?.focusedBlockId).toBe(BLOCK);
    // The tiled layer's blocks come first.
    expect(view.windows[0]?.blocks.map((b) => b.blockId)).toEqual([BLOCK, "block:float"]);
  });

  test("attached clients", () => {
    expect(parseClientCount(JSON.stringify({ clients: [] }))).toBe(0);
    expect(parseClientCount(JSON.stringify({ clients: [{ client_id: "client:1" }, { client_id: "client:2" }] }))).toBe(2);
  });

  test("a command-line client is not a person looking at the session", () => {
    const cli = { client_id: "client:3", info: { kind: "cli", platform: "linux", name: "rex" } };
    expect(parseClientCount(JSON.stringify({ clients: [cli] }))).toBe(0);
    expect(parseClientCount(JSON.stringify({ clients: [cli, { client_id: "client:4", info: { kind: "app" } }] }))).toBe(1);
  });

  test("a running block and an exited --keep-open one", () => {
    const running = {
      last_exit: null,
      child: { pid: 1, name: "zsh", cwd: "/tmp" },
      foreground: { pid: 2, name: "claude", cwd: "/home/diego/project" },
      home: "/home/diego",
    };
    expect(parseProcess(JSON.stringify(running))).toEqual({ foreground: "claude", cwd: "/home/diego/project", alive: true, loginShellPid: null });
    expect(parseProcess(JSON.stringify({ last_exit: { exit_code: 0 }, home: "/home/diego" }))).toEqual({ foreground: null, cwd: "", alive: false, loginShellPid: null });
  });

  test("program status: Claude Code at its trust dialog, and a block with none", () => {
    const records = parseProgramStatus(
      JSON.stringify({
        records: [{ state: "blocked", kind: "permission", app: "claude-code", effective_app: "claude-code", msg: "trust this folder", owner: { pid: 3, name: "2.1.327" } }],
      }),
    );
    expect(records).toEqual([{ state: "blocked", app: "claude-code", id: "", ownerPid: 3 }]);
    expect(parseProgramStatus(JSON.stringify({ records: [] }))).toEqual([]);
  });

  test("what a create names", () => {
    const session = parseCreated(JSON.stringify({ session_id: SESSION, initial_windows: [{ window_id: WINDOW, block_ids: [BLOCK], revision: 1 }] }));
    expect(session).toEqual({ sessionId: SESSION, windowId: WINDOW, blockId: BLOCK });
    expect(parseCreated(JSON.stringify({ window_id: WINDOW, block_ids: [BLOCK], revision: 5 }))).toEqual({ sessionId: null, windowId: WINDOW, blockId: BLOCK });
  });

  test("the server's primary listener", () => {
    const status = {
      listeners: [
        { endpoint: "unix:///run/user/1000/rex/server.sock", transport: "unix", primary: true },
        { endpoint: "login-server:///run/user/1000/rex/login-server.sock", transport: "unix" },
      ],
    };
    expect(primaryListener(JSON.stringify(status))).toBe("unix:///run/user/1000/rex/server.sock");
    expect(primaryListener("not json")).toBeNull();
  });
});

describe("window labels", () => {
  test("rex's own default reads as unnamed; a given name does not", () => {
    expect(isDefaultWindowLabel("window:01a1f14e-18de-7216-be9c-aeac30aea103", "Window 30aea103")).toBe(true);
    expect(isDefaultWindowLabel("window:01a1f14e-18de-7216-be9c-aeac30aea103", "docs")).toBe(false);
    expect(isDefaultWindowLabel("window:01a1f14e-18de-7216-be9c-aeac30aea103", "Window 12345678")).toBe(false);
  });
});

describe("the event stream", () => {
  /** One wrapped event body: its `type`, and the payload shape that type decides. */
  interface SessionEventBody {
    readonly type: string;
    readonly payload: {
      readonly block_id?: string;
      readonly creator_name?: string;
      readonly name?: string;
      readonly payload?: unknown;
      readonly client_id?: string;
    };
  }
  const wrap = (event: SessionEventBody): string => JSON.stringify({ type: "session_event", payload: { session_id: SESSION, event } });

  test("sessions appearing and going are topology", () => {
    expect(parseEvent(JSON.stringify({ type: "session_created", payload: { session: { session_id: SESSION, label: "x" } } }))).toEqual({ kind: "topology" });
    expect(parseEvent(JSON.stringify({ type: "session_destroyed", payload: { session_id: SESSION } }))).toEqual({ kind: "topology" });
  });

  test("window and block lifecycle and labels are topology", () => {
    for (const type of ["window_created", "window_closed", "window_label_changed", "block_closed", "active_window_changed", "session_label_changed"]) {
      expect(parseEvent(wrap({ type, payload: {} }))).toEqual({ kind: "topology" });
    }
  });

  test("a block's status and title are a pane change", () => {
    const status = wrap({
      type: "block_event",
      payload: { block_id: BLOCK, creator_name: "com.superlogical.terminal", name: "program_status_changed", payload: { state: "working" } },
    });
    expect(parseEvent(status)).toEqual({ kind: "pane", blockId: BLOCK });
    const removed = wrap({ type: "block_event", payload: { block_id: BLOCK, name: "program_status_removed", payload: { ids: [""], reason: "clear" } } });
    expect(parseEvent(removed)).toEqual({ kind: "pane", blockId: BLOCK });
  });

  test("CLI connections, a bell and noise are ignored", () => {
    expect(parseEvent(wrap({ type: "client_connected", payload: { client_id: "client:1" } }))).toEqual({ kind: "ignored" });
    expect(parseEvent(JSON.stringify({ type: "client_joined", payload: {} }))).toEqual({ kind: "ignored" });
    expect(parseEvent(wrap({ type: "block_event", payload: { block_id: BLOCK, name: "bell", payload: {} } }))).toEqual({ kind: "ignored" });
    expect(parseEvent("Error: interrupted")).toBeNull();
  });
});

describe("refusals", () => {
  test("a target that is not there", () => {
    expect(saysNotFound(3, `Error: block target "${BLOCK}" not found`)).toBe(true);
    expect(saysNotFound(1, 'Error: session target "nosuch" not found')).toBe(true);
    expect(saysNotFound(1, "Error: something else")).toBe(false);
  });

  test("no server, no binary, a hang", () => {
    expect(saysUnreachable(4, "Error: no Rex server is running at /tmp/x.sock, and autostart is disabled")).toBe(true);
    expect(saysUnreachable(127, "")).toBe(true);
    expect(saysUnreachable(143, "")).toBe(true);
    expect(saysUnreachable(3, `Error: block target "${BLOCK}" not found`)).toBe(false);
  });
});

describe("keepSgrOnly lets no control byte through", () => {
  const c = (code: number): string => String.fromCodePoint(code);

  test("a huge cursor-forward count allocates nothing, and a large one stops at 1000 spaces", () => {
    expect(keepSgrOnly(`a${ESC}[99999999Cb`)).toBe("ab");
    expect(keepSgrOnly(`a${ESC}[9999Cb`)).toBe(`a${" ".repeat(1000)}b`);
  });

  test("an 8-bit CSI or OSC is dropped whole, its parameters with it", () => {
    expect(keepSgrOnly(`a${c(0x9b)}2Jb`)).toBe("ab");
    expect(keepSgrOnly(`a${c(0x9b)}31mb`)).toBe("ab");
    expect(keepSgrOnly(`a${c(0x9d)}0;title${c(0x9c)}b`)).toBe("ab");
  });

  test("an unterminated or overlong escape leaves no ESC behind", () => {
    expect(keepSgrOnly(`ab${ESC}[`)).toBe("ab");
    expect(keepSgrOnly(`ab${ESC}`)).toBe("ab");
    expect(keepSgrOnly(`a${ESC}[${"1;".repeat(3000)}mb`)).toBe("ab");
    expect(keepSgrOnly(`a${ESC}]0;${"t".repeat(5000)}`).includes(ESC)).toBe(false);
  });

  test("C0 controls but tab and newline, DEL and C1 are dropped; SGR stays", () => {
    const out = keepSgrOnly(`a${c(7)}${c(8)}${c(0)}${c(0x7f)}${c(0x85)}\tb\n${ESC}[1mbold${ESC}[0m`);
    expect(out).toBe(`a\tb\n${ESC}[1mbold${ESC}[0m`);
  });
});

describe("a status record's fields are bounded before use", () => {
  const status = (record: Record<string, string>) => JSON.stringify({ records: [record] });

  test("a record with an overlong app, state or id is not read", () => {
    expect(parseProgramStatus(status({ state: "blocked", app: "claude-code".repeat(10) }))).toEqual([]);
    expect(parseProgramStatus(status({ state: "x".repeat(17), app: "claude-code" }))).toEqual([]);
    expect(parseProgramStatus(status({ state: "working", app: "codex", id: "i".repeat(65) }))).toEqual([]);
  });

  test("an ordinary record is read, and kind and msg are never carried", () => {
    const [record] = parseProgramStatus(status({ state: "blocked", kind: "permission", msg: "Run rm -rf?", app: "claude-code" }));
    expect(record).toEqual({ state: "blocked", app: "claude-code", id: "", ownerPid: null });
  });
});

describe("the block's own login shell", () => {
  test("a child started as a login shell names its pid; any other program does not", () => {
    const shell = { last_exit: null, child: { pid: 7, name: "bash", argv0: "-bash" }, foreground: { pid: 7, name: "bash" } };
    const program = { last_exit: null, child: { pid: 8, name: "claude", argv0: "claude" }, foreground: { pid: 8, name: "claude" } };
    expect(parseProcess(JSON.stringify(shell)).loginShellPid).toBe(7);
    expect(parseProcess(JSON.stringify(program)).loginShellPid).toBeNull();
    expect(parseProcess(JSON.stringify({ last_exit: { exit_code: 0 } })).loginShellPid).toBeNull();
  });
});

describe("the API revision", () => {
  test("server.status names it, and a bad answer names none", () => {
    expect(parseApiRevision(JSON.stringify({ api_revision: 19, listeners: [] }))).toBe(19);
    expect(parseApiRevision(JSON.stringify({ listeners: [] }))).toBeNull();
    expect(parseApiRevision(JSON.stringify({ api_revision: "19" }))).toBeNull();
    expect(parseApiRevision("not json")).toBeNull();
  });

  test("only an untested revision has a note", () => {
    expect(untestedRevisionNote(18)).toBeNull();
    expect(untestedRevisionNote(19)).toBeNull();
    expect(untestedRevisionNote(11)).toBe("Rex API revision 11 was not tested with Collie (tested: 18, 19)");
  });
});
