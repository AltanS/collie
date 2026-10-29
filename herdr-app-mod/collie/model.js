// The Collie panel's decisions, with no herdr or gpui import, so `bun test` runs them
// (herdr-app-mod/collie.test.ts). main.js draws what these return and runs what they name.
//
// Everything Collie knows comes from Collie itself: `collie status --json`, `collie pair --json`
// and the bridge's own `/api/health`. The panel keeps no copy of any of it on disk. The pairing
// code lives in the panel's memory until it expires or the operator hides it.

/** How often the panel asks `collie status --json` (about 0.2 s of work each time). */
export const POLL_MS = 15_000;

/** The verbs the panel runs. Nothing else reaches `exec`. */
export const VERBS = ["status", "start", "stop", "restart", "pair", "push-test"];

/** Collie's own rule for an instance name (cli/context.ts): it becomes a unit name and a filename. */
const INSTANCE = /^[a-z0-9-]{1,16}$/;

/** A pairing code as Collie mints it: letters and digits (bridge/pairing.ts CODE_ALPHABET). */
const CODE = /^[A-Za-z0-9]{4,32}$/;

/** An ESC, built rather than written, so no raw control character sits in the source. */
const ESC = String.fromCodePoint(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * The instance this panel watches: the `instance` prop from the layout, or null for the
 * host's default Collie. A name Collie would refuse is refused here too, with the reason.
 */
export function pickInstance(props) {
  const raw = props?.instance;
  if (raw === undefined || raw === null || raw === "" || raw === "default") return { ok: true, instance: null };
  const name = String(raw).trim();
  if (!INSTANCE.test(name)) return { ok: false, reason: `"${name}" is not an instance name: use 1 to 16 of a-z, 0-9 and -.` };
  return { ok: true, instance: name };
}

/**
 * The program and arguments for one verb. A named instance goes through `env`, because the
 * app's `exec` takes no environment; on Windows there is no `env`, so an instance is refused.
 */
export function collieCommand(verb, instance, platform) {
  if (!VERBS.includes(verb)) throw new Error(`not a panel verb: ${verb}`);
  const args = [verb];
  if (verb === "status" || verb === "pair") args.push("--json");
  if (instance === null) return { command: "collie", args };
  if (platform === "windows") return null;
  return { command: "env", args: [`COLLIE_INSTANCE=${instance}`, "collie", ...args] };
}

/** How to open a URL in the system's browser. */
export function openCommand(platform, url) {
  if (platform === "macos") return { command: "open", args: [url] };
  if (platform === "windows") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

function firstJsonLine(stdout) {
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * `collie status --json` read. A Collie from before the flag prints its banner instead; that is
 * named as too old rather than as a failure, because `collie update` is the fix.
 */
export function readStatus(result) {
  const json = firstJsonLine(result.stdout);
  if (json !== null && json.running !== undefined && json.port !== undefined) {
    return {
      ok: true,
      status: {
        running: json.running === true,
        version: String(json.version ?? ""),
        instance: json.instance ?? null,
        port: Number(json.port),
        localUrl: String(json.localUrl ?? ""),
        phoneUrl: json.phoneUrl ? String(json.phoneUrl) : null,
        crew: String(json.crew ?? "solo"),
        service: String(json.service ?? ""),
        pairedDevices: Number(json.pairedDevices ?? 0),
      },
    };
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (/Collie is running|isn't answering/.test(text)) return { ok: false, kind: "old" };
  return { ok: false, kind: "failed", text: summary(result) || "collie status gave no answer." };
}

/** The bridge's `/api/health` body, or null. Only the two fields the panel shows. */
export function readHealth(body) {
  if (body === null || body === undefined || body.ok !== true) return null;
  return { version: String(body.version ?? ""), mode: String(body.mode ?? "") };
}

/**
 * `collie pair --json` read. Exit 2 with a usage line is a Collie from before the flag: it minted
 * nothing, so nothing is lost by saying so.
 */
export function readPair(result, now) {
  const json = firstJsonLine(result.stdout);
  const code = String(json?.code ?? "");
  if (result.code === 0 && CODE.test(code)) {
    const expiresAt = Date.parse(json.expiresAt);
    const qr = Array.isArray(json.qr) && json.qr.every((row) => /^[01]+$/.test(row)) ? json.qr : null;
    return {
      ok: true,
      pairing: {
        code,
        expiresAt: Number.isNaN(expiresAt) ? now + 10 * 60_000 : expiresAt,
        url: json.url ? String(json.url) : null,
        qr,
        replaced: json.replaced === true,
      },
    };
  }
  if (result.code === 2 && /usage: collie pair/.test(result.stderr)) return { ok: false, kind: "old" };
  return { ok: false, kind: "failed", text: summary(result) || "collie pair gave no code." };
}

/** The last line worth reading from a run: stderr when it failed, else stdout, colours stripped. */
export function summary(result) {
  const pick = (text) =>
    String(text ?? "")
      .replace(SGR, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^[█▀▄ ]+$/.test(line));
  const lines = result.code === 0 ? pick(result.stdout) : [...pick(result.stderr), ...pick(result.stdout)];
  const line = result.code === 0 ? lines.at(-1) : lines[0];
  if (line === undefined) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Whole minutes left on a pairing code, never below zero. */
export function minutesLeft(expiresAt, now) {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * A QR bitmap as runs per row, so a row draws as a few boxes instead of one per module. The
 * quiet zone is added here, four light modules on every side, as the QR spec asks.
 */
export function qrRuns(rows, quiet = 4) {
  const n = rows.length;
  const blank = [{ dark: false, length: n + 2 * quiet }];
  const out = [];
  for (let i = 0; i < quiet; i++) out.push(blank);
  for (const row of rows) {
    const runs = [{ dark: false, length: quiet }];
    for (const m of row) {
      const dark = m === "1";
      const last = runs.at(-1);
      if (last.dark === dark) last.length += 1;
      else runs.push({ dark, length: 1 });
    }
    const last = runs.at(-1);
    if (last.dark) runs.push({ dark: false, length: quiet });
    else last.length += quiet;
    out.push(runs);
  }
  for (let i = 0; i < quiet; i++) out.push(blank);
  return out;
}

/** Pixels per module so the code and its quiet zone fit `width`, between 2 and 6. */
export function moduleSize(width, modules, quiet = 4) {
  const total = modules + 2 * quiet;
  return Math.max(2, Math.min(6, Math.floor(width / total)));
}

/**
 * What the panel shows, from what it knows. `problem` wins over `status`; `status` null with no
 * problem is the first look, still on its way.
 */
export function describe(state) {
  const { status, health, problem } = state;
  if (problem?.kind === "missing") {
    return {
      mark: "problem",
      headline: "Collie is not installed here",
      detail: "There is no collie command on this computer's PATH. Install Collie, then open this panel again.",
      rows: [],
    };
  }
  if (problem?.kind === "old") {
    return {
      mark: "problem",
      headline: "This Collie is too old for the panel",
      detail: "The panel needs a Collie that answers status --json. Run collie update in a terminal.",
      rows: [],
    };
  }
  if (problem?.kind === "instance") {
    return { mark: "problem", headline: "The panel cannot watch this instance", detail: problem.text, rows: [] };
  }
  if (problem?.kind === "failed" && status === null) {
    return { mark: "problem", headline: "Collie did not answer", detail: problem.text, rows: [] };
  }
  if (status === null) return { mark: "unknown", headline: "Looking for Collie", detail: "", rows: [] };
  const rows = [];
  if (status.instance !== null) rows.push({ label: "Instance", value: status.instance });
  rows.push({ label: "Version", value: health?.version || status.version });
  rows.push({ label: "Mode", value: health?.mode || status.crew });
  rows.push({ label: "Port", value: String(status.port) });
  rows.push({ label: "Service", value: status.service });
  if (status.crew !== "peer") {
    rows.push({ label: "Paired", value: status.pairedDevices === 1 ? "1 device" : `${status.pairedDevices} devices` });
  }
  return {
    mark: status.running ? "running" : "stopped",
    headline: status.running ? "Collie is running" : "Collie is stopped",
    detail: status.running && status.crew === "peer" ? "This machine is a crew member. Pair your phone on the lead." : "",
    rows,
  };
}

/** Which buttons can act now. Nothing acts while one verb runs. */
export function actions(state) {
  const { status, busy } = state;
  const idle = busy === null;
  const known = status !== null && state.problem?.kind !== "old" && state.problem?.kind !== "missing";
  return {
    start: idle && known && !status.running,
    stop: idle && known && status.running,
    restart: idle && known && status.running,
    pair: idle && known && status.running && status.crew !== "peer",
    pushTest: idle && known && status.running,
    open: known && status.phoneUrl !== null,
  };
}

/** The word a button shows while its verb runs. */
export const BUSY_LABEL = {
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  pair: "Making a code",
  "push-test": "Sending",
};
