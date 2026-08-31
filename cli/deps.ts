import { cmdRestart, type LifecycleDeps } from "./lifecycle.ts";
import type { Io } from "./io.ts";
import { loadContext } from "./context.ts";
import type { Ui } from "./render.ts";
import { cmdServe } from "./serve.ts";
import { realExec, realFiles, waitReady } from "./sys.ts";
import type { UpdateDeps } from "./update.ts";

// The dependency sets a verb is handed, built from the real seams. They live HERE, and not in the
// dispatcher, because `cli/main.ts` — the bootstrap that must run on a checkout whose `node_modules`
// is missing or stale — needs the two below without pulling in the verb table (and with it
// commander). See the header of `cli/main.ts`.

/**
 * Everything a lifecycle verb needs, resolved once per invocation: the context, the process and
 * filesystem seams, and the clock. Real implementations here; `cli/lifecycle.test.ts` supplies
 * fakes for the same interfaces.
 */
export function lifecycleDeps(io: Io, ui: Ui | null = null): LifecycleDeps {
  const ctx = loadContext(io.err);
  const deps: LifecycleDeps = {
    ctx,
    io,
    ui,
    exec: realExec(ctx.env, ctx.home),
    files: realFiles,
    ready: (port, host) => waitReady(port, host),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uid: () => process.getuid?.() ?? 0,
    platform: process.platform,
    // The first-run multiplexer question (`cli/mux.ts`), asked through Bun's built-in behind a tty
    // check exactly as `stt setup` and `pack add` guard theirs: a question nobody can answer must
    // refuse legibly rather than read EOF as an answer.
    interactive: process.stdin.isTTY === true,
    prompt: (question) => (process.stdin.isTTY === true ? prompt(question) : null),
    // The front door, over the same resolved context. `start` calls this and tolerates its failure;
    // `collie serve` is the same function plus the `open:` line. `into` mirrors `restart`'s optional
    // `io` (see `LifecycleDeps.serve`) — unused on this plain path, where `start` always passes back
    // the same `io` this object already closes over.
    serve: (into) => Promise.resolve(cmdServe(into === undefined ? deps : { ...deps, io: into })),
  };
  return deps;
}

/**
 * `update`'s dependencies: the lifecycle set plus `restart`, injected so the update tests can drive
 * the whole post-pull half without a service manager anywhere near them.
 */
export function updateDeps(io: Io): UpdateDeps {
  const deps = lifecycleDeps(io);
  return { ...deps, restart: () => cmdRestart(deps) };
}
