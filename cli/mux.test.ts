import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "./context.ts";
import { capture, context, CONFIG, fakeExec, fakeFiles, HOME, type Scripted } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { chooseMux, ensureMuxChosen, probeMuxes, type MuxSettleDeps } from "./mux.ts";

// The first-run multiplexer question (M14/03), driven against the same two fakes every verb suite
// uses. Two properties are worth stating before the cases:
//
//  • NOTHING HERE MAY START A MULTIPLEXER, and the fake `Exec` is how that is checked rather than
//    asserted: every argv the probe builds is recorded, and the cases below pin the two listings it
//    is allowed to run.
//  • The Herdr socket, the tmux binary and the zellij binary are all FILES to the probe, so a host
//    with one multiplexer, three, or none is a `fakeFiles` seed and not a mocked module.

const SOCKET = "/home/pat/.config/herdr/herdr.sock";
/** Where the tmux adapter's own candidate list looks first. */
const TMUX_BIN = "/usr/bin/tmux";
/** Where zellij's own installer puts it — the first candidate `zellijBinaryCandidates` probes. */
const ZELLIJ_BIN = `${HOME}/.local/bin/zellij`;

interface HostOptions {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  answers?: Scripted["answers"];
  interactive?: boolean;
  /** The operator's answers to the picker, in order. Absent = there is no prompt seam at all. */
  typed?: string[];
}

function host(over: HostOptions = {}) {
  const io = capture();
  const exec = fakeExec({ answers: over.answers });
  const files = fakeFiles(over.files);
  const typed = [...(over.typed ?? [])];
  const asked: string[] = [];
  const deps: MuxSettleDeps = {
    ctx: context(over.env ?? {}, { socket: SOCKET }),
    io,
    exec,
    files,
    interactive: over.interactive,
    prompt:
      over.typed === undefined
        ? undefined
        : (question) => {
            asked.push(question);
            return typed.shift() ?? null;
          },
  };
  return { deps, io, exec, files, asked, dotenv: () => files.read(`${CONFIG}/.env`) };
}

/** A tmux server that answers with two sessions on its own default server. */
const TMUX_RUNNING: Scripted["answers"] = [[`${TMUX_BIN} list-sessions`, { stdout: "work\nscratch\n" }]];
/** A tmux binary that is installed with no server behind it — `list-sessions` refuses. */
const TMUX_IDLE: Scripted["answers"] = [
  [`${TMUX_BIN} list-sessions`, { code: 1, stderr: "no server running on /tmp/tmux-1000/default" }],
];
const zellijRunning = (stdout: string): Scripted["answers"] => [[`${ZELLIJ_BIN} list-sessions`, { stdout }]];

describe("the probe", () => {
  test("Herdr is the socket file being there — the same read `doctor` makes, and no dial", () => {
    expect(probeMuxes(host({ files: { [SOCKET]: "" } }).deps)).toEqual([
      { mux: "herdr", endpoint: "", evidence: `a Herdr socket at ${SOCKET}` },
    ]);
    expect(probeMuxes(host().deps)).toEqual([]);
  });

  test("tmux is a running server, asked for with the one listing that never starts one", () => {
    const h = host({ files: { [TMUX_BIN]: "" }, answers: TMUX_RUNNING });
    expect(probeMuxes(h.deps)).toEqual([
      { mux: "tmux", endpoint: "", evidence: "a tmux server on tmux's own default server — 2 sessions" },
    ]);
    expect(h.exec.calls).toEqual([`${TMUX_BIN} list-sessions -F #{session_name}`]);
  });

  test("tmux with no binary is not probed at all, and a binary with no server is not a sighting", () => {
    const absent = host({ answers: TMUX_RUNNING });
    expect(probeMuxes(absent.deps)).toEqual([]);
    expect(absent.exec.calls).toEqual([]);
    expect(probeMuxes(host({ files: { [TMUX_BIN]: "" }, answers: TMUX_IDLE }).deps)).toEqual([]);
  });

  test("tmux carries the configured endpoint into its own server flags and its evidence", () => {
    const h = host({
      env: { COLLIE_MUX_ENDPOINT_TMUX: "/run/collie-tmux.sock" },
      files: { [TMUX_BIN]: "" },
      answers: [[`${TMUX_BIN} -S /run/collie-tmux.sock list-sessions`, { stdout: "work\n" }]],
    });
    expect(probeMuxes(h.deps)).toEqual([
      {
        mux: "tmux",
        endpoint: "/run/collie-tmux.sock",
        evidence: "a tmux server on socket /run/collie-tmux.sock — 1 session",
      },
    ]);
  });

  test("zellij is a RUNNING session, and the endpoint it settles is the adapter's own choice", () => {
    const h = host({ files: { [ZELLIJ_BIN]: "" }, answers: zellijRunning("work\n") });
    expect(probeMuxes(h.deps)).toEqual([
      { mux: "zellij", endpoint: "work", evidence: "1 running zellij session: work" },
    ]);
    expect(h.exec.calls).toEqual([`${ZELLIJ_BIN} list-sessions --no-formatting`]);
  });

  test("zellij with only exited sessions is not a sighting; two running leaves the endpoint open", () => {
    const exited = host({
      files: { [ZELLIJ_BIN]: "" },
      answers: zellijRunning("work (EXITED - attach to resurrect)\n"),
    });
    expect(probeMuxes(exited.deps)).toEqual([]);

    const both = host({ files: { [ZELLIJ_BIN]: "" }, answers: zellijRunning("work\nscratch\n") });
    expect(probeMuxes(both.deps)).toEqual([
      { mux: "zellij", endpoint: "", evidence: "2 running zellij sessions: work, scratch" },
    ]);
  });
});

describe("an explicit COLLIE_MUX", () => {
  test("wins outright, and the probe never runs", async () => {
    const h = host({ env: { COLLIE_MUX: "tmux" }, files: { [SOCKET]: "", [TMUX_BIN]: "" } });
    expect(await chooseMux(h.deps)).toEqual({ kind: "explicit", mux: "tmux" });
    expect(h.exec.calls).toEqual([]);
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    // Nothing was decided here, so nothing is written: the operator's own file stays theirs.
    expect(h.dotenv()).toBeNull();
  });
});

describe("with no terminal", () => {
  test("exactly one found is auto-selected, written down, and said out loud", async () => {
    const h = host({ files: { [SOCKET]: "" } });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("auto-selected herdr");
    expect(h.io.stdout.join("\n")).toContain(`a Herdr socket at ${SOCKET}`);
    expect(parseEnvFile(h.dotenv() ?? "")).toEqual({ COLLIE_MUX: "herdr" });
    // And the environment this run hands the bridge, which is the other half of "selected".
    expect(h.deps.ctx.env.COLLIE_MUX).toBe("herdr");
  });

  test("none found refuses, naming the variable and the line that answers it", async () => {
    const h = host();
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.FAIL);
    const said = h.io.stderr.join("\n");
    expect(said).toContain("no COLLIE_MUX is set");
    expect(said).toContain("no multiplexer is running here");
    // No hint is possible with nothing found, so the name is left as the choice it is.
    expect(said).toContain(`fix:  printf 'COLLIE_MUX=<herdr|tmux|zellij>\\n' >> ${CONFIG}/.env && collie start`);
    expect(h.dotenv()).toBeNull();
  });

  test("several found refuses and lists every one of them — a guess here mirrors the wrong terminals", async () => {
    const h = host({ files: { [SOCKET]: "", [TMUX_BIN]: "" }, answers: TMUX_RUNNING });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.FAIL);
    const said = h.io.stderr.join("\n");
    expect(said).toContain("no COLLIE_MUX is set, and 2 multiplexers are running here");
    expect(said).toContain(`  herdr    a Herdr socket at ${SOCKET}`);
    expect(said).toContain("  tmux     a tmux server on tmux's own default server — 2 sessions");
    // Nothing in this environment names one of them, so nothing is suggested.
    expect(said).not.toContain("hint:");
    expect(said).toContain(`fix:  printf 'COLLIE_MUX=<herdr|tmux|zellij>\\n' >> ${CONFIG}/.env && collie start`);
    expect(h.dotenv()).toBeNull();
  });

  test("the variable this instance already carries is named as the likely answer, and pasted into the fix", async () => {
    const h = host({
      env: { HERDR_SOCKET_PATH: SOCKET },
      files: { [SOCKET]: "", [TMUX_BIN]: "" },
      answers: TMUX_RUNNING,
    });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.FAIL);
    const said = h.io.stderr.join("\n");
    expect(said).toContain("hint: this instance already has HERDR_SOCKET_PATH set, so herdr is probably the one.");
    expect(said).toContain(`fix:  printf 'COLLIE_MUX=herdr\\n' >> ${CONFIG}/.env && collie start`);
    // A hint is a hint: nothing was selected and nothing was written.
    expect(h.dotenv()).toBeNull();
  });

  test("two variables naming two of the found multiplexers hint at neither", async () => {
    const h = host({
      env: { HERDR_SOCKET_PATH: SOCKET, COLLIE_MUX_ENDPOINT_TMUX: "/run/collie-tmux.sock" },
      files: { [SOCKET]: "", [TMUX_BIN]: "" },
      answers: [[`${TMUX_BIN} -S /run/collie-tmux.sock list-sessions`, { stdout: "work\n" }]],
    });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.FAIL);
    const said = h.io.stderr.join("\n");
    expect(said).not.toContain("hint:");
    expect(said).toContain(`fix:  printf 'COLLIE_MUX=<herdr|tmux|zellij>\\n' >> ${CONFIG}/.env && collie start`);
  });

  test("a prompt seam that is there is still never used without a terminal", async () => {
    const h = host({ files: { [SOCKET]: "", [TMUX_BIN]: "" }, answers: TMUX_RUNNING, typed: ["1"] });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.FAIL);
    expect(h.asked).toEqual([]);
  });
});

describe("the picker", () => {
  const twoUp = (typed: string[]): ReturnType<typeof host> =>
    host({
      files: { [SOCKET]: "", [TMUX_BIN]: "" },
      answers: TMUX_RUNNING,
      interactive: true,
      typed,
    });

  test("presents every sighting with its evidence and writes the one that was picked", async () => {
    const h = twoUp(["2"]);
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain(`1) herdr   a Herdr socket at ${SOCKET}`);
    expect(h.io.stdout.join("\n")).toContain("2) tmux    a tmux server on tmux's own default server");
    expect(parseEnvFile(h.dotenv() ?? "")).toEqual({ COLLIE_MUX: "tmux" });
    expect(h.deps.ctx.env.COLLIE_MUX).toBe("tmux");
  });

  test("takes the multiplexer's own name as readily as its row number", async () => {
    const h = twoUp(["herdr"]);
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    expect(parseEnvFile(h.dotenv() ?? "")).toEqual({ COLLIE_MUX: "herdr" });
  });

  test("forgives a typo, but a picker that is never answered refuses rather than defaulting", async () => {
    const typo = twoUp(["screen", "1"]);
    expect(await ensureMuxChosen(typo.deps)).toBe(EXIT.OK);
    expect(typo.asked).toHaveLength(2);
    expect(typo.io.stderr.join("\n")).toContain('"screen" is not one of them.');

    const never = twoUp(["", "", ""]);
    expect(await ensureMuxChosen(never.deps)).toBe(EXIT.FAIL);
    expect(never.dotenv()).toBeNull();
  });

  test("writes the adapter's endpoint var beside the name when the adapter needs one", async () => {
    const h = host({
      files: { [ZELLIJ_BIN]: "" },
      answers: zellijRunning("work\n"),
      interactive: true,
      typed: ["zellij"],
    });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    expect(parseEnvFile(h.dotenv() ?? "")).toEqual({
      COLLIE_MUX: "zellij",
      COLLIE_MUX_ENDPOINT_ZELLIJ: "work",
    });
  });

  test("says which question is still open when zellij has more than one running session", async () => {
    const h = host({
      files: { [ZELLIJ_BIN]: "" },
      answers: zellijRunning("work\nscratch\n"),
      interactive: true,
      typed: ["1"],
    });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    expect(parseEnvFile(h.dotenv() ?? "")).toEqual({ COLLIE_MUX: "zellij" });
    expect(h.io.stderr.join("\n")).toContain("COLLIE_MUX_ENDPOINT_ZELLIJ");
  });

  test("keeps everything else in a `.env` that is already there", async () => {
    const h = host({
      files: { [SOCKET]: "", [`${CONFIG}/.env`]: "# mine\nCOLLIE_PORT=8788\n" },
      interactive: true,
      typed: ["1"],
    });
    expect(await ensureMuxChosen(h.deps)).toBe(EXIT.OK);
    const written = h.dotenv() ?? "";
    expect(written).toContain("# mine");
    expect(parseEnvFile(written)).toEqual({ COLLIE_PORT: "8788", COLLIE_MUX: "herdr" });
  });
});
