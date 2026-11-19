// Shared by lifecycle.test.ts and lifecycle.slow.test.ts: the helpers both files need. Not a test file.

import { capture, context, type FakeExec, fakeExec, type FakeFiles, fakeFiles, ROOT, type Scripted } from "./fakes.ts";
import { hostFor, type Host } from "../bridge/host.ts";
import { EXIT, type Io } from "./io.ts";
import { collieBinary } from "./unit.ts";
import { type LifecycleDeps } from "./lifecycle.ts";

// The binary, spelled the way the code under test spells it. `collieBinary` joins with the host
// separator, so a POSIX literal like `/opt/collie/bin/collie` never matches on a Windows host, and it
// names `bin/collie.exe` for a `win32` platform. Everything here asks for the binary of the platform
// the harness injects (`deps.host`), never the host's: `BINARY` is the one every non-Windows
// harness platform shares, and `binaryOn` is the one for a platform a test pins.
export const binaryOn = (platform: NodeJS.Platform): string => collieBinary(ROOT, hostFor(platform));

export const BINARY = binaryOn("linux");

// The lifecycle, driven end to end against fakes for the two seams (cli/fakes.ts). The shell could
// only reach this coverage by `source`-ing itself and redefining functions in a heredoc; here
// `start` on all three supervision tiers, the launchd retry, the pidfile guard, `uninstall` and the
// banner are ordinary unit tests.

export interface Harness {
  deps: LifecycleDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
  /** Every `(port, host)` pair the banner's readiness probe was called with. */
  readyCalls: Array<{ port: number; host: string }>;
}

export type HarnessOptions = Partial<
  Scripted & {
    host: Host;
    ready: boolean;
    env: Record<string, string | undefined>;
    /** The `COLLIE_INSTANCE` suffix this Collie was resolved with. Absent = the solo instance. */
    instance: string | null;
    files: Record<string, string>;
    serve: (io?: Io) => Promise<number>;
  }
>;

export function harness(over: HarnessOptions = {}): Harness {
  const io = capture();
  const exec = fakeExec(over);
  // The binary exists unless a test deliberately removes it — every other test would otherwise be
  // asserting the "no binary" guard by accident.
  const files = fakeFiles({ [BINARY]: "", [collieBinary(ROOT, over.host ?? hostFor("linux"))]: "", ...over.files });
  const readyCalls: Array<{ port: number; host: string }> = [];
  const deps: LifecycleDeps = {
    // Every fixture here is a Collie that has already chosen its multiplexer, so `start`'s first-run
    // gate (`cli/mux.ts`) returns before it probes. A supervision test must not also be a test of
    // that question — `cli/mux.test.ts` owns it, and the one case where it stops `start` is pinned
    // below in "the first-run multiplexer gate".
    ctx: context(
      { COLLIE_MUX: "herdr", ...over.env },
      over.instance === undefined ? {} : { instance: over.instance },
    ),
    io,
    exec,
    files,
    ready: (port, host) => {
      readyCalls.push({ port, host });
      return Promise.resolve(over.ready ?? true);
    },
    sleep: () => Promise.resolve(),
    uid: () => 501,
    host: over.host ?? hostFor("linux"),
    serve: over.serve ?? (() => Promise.resolve(EXIT.OK)),
  };
  return { deps, io, exec, files, readyCalls };
}
