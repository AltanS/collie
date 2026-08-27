import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import {
  coerceSttFile,
  DEFAULT_CODEX_BIN,
  DEFAULT_STT_MODEL,
  resolveSttSettings,
  STT_ENV_KEYS,
  STT_FILENAME,
  STT_PROVIDERS,
  sttEnvSettings,
  type CodexSttSettings,
  type SttProviderName,
  type SttSettings,
  type SttWireIdentity,
} from "../bridge/stt/config.ts";
import { CODEX_TRANSCRIBE_URL, probeCodexIdentity, silentWavBytes } from "../bridge/stt/codex.ts";
import { createSttProvider } from "../bridge/stt/index.ts";
import { SttError, type SttProvider } from "../bridge/stt/provider.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { parsePackArgs } from "./pack.ts";
import type { Exec, Files } from "./sys.ts";

// `stt setup | test | status | off` — the operator's half of speech-to-text (ADR 0029).
//
// ── WHY THIS IS A CLI ACT AND NOT A SETTINGS PAGE ────────────────────────────
// For the reason `collie pair` is one: this surface MINTS OR ACCEPTS A CREDENTIAL. `setup` writes a
// provider key into the state dir, or — on the codex provider — records the operator's consent to put
// somebody else's name on the wire. Neither decision can be authorised by a page loaded over the
// front door; the shell on the host IS the proof, exactly as it is for enrolment (see the header of
// `cli/pairing.ts`). There is no web setup form and there is not going to be one.
//
// ── THE THREE THINGS THIS MODULE OWES THE BRIDGE ─────────────────────────────
//  1. It writes `<stateDir>/stt.json`, and the bridge re-reads that file behind an mtime check
//     (`bridge/stt/config.ts`). So every verb here says "no restart needed" and means it.
//  2. It never re-implements the resolve. `setup` VALIDATES by calling the bridge's own
//     `resolveSttSettings`, `test` loads through it, and `status` reports what it decided — one
//     parser, so a config the CLI calls good can never be a config the bridge calls off.
//  3. It never prints the API key. `status` shows at most the last four characters, and no verb here
//     ever echoes a key back at a terminal that may be logged or shoulder-read.
//
// Reading a key without echo would need a raw-mode tty read this CLI has nowhere else, so `setup`
// does not pretend to have one: the prompt says out loud where the value is about to land.

/** The `stt` sub-verbs, in the order the usage block prints them. */
export const STT_SUBCOMMANDS = ["setup", "test", "status", "off"] as const;

/** Flags `setup` takes with no value. Everything else is `--name value` / `--name=value`. */
const BARE_FLAGS = ["accept-risk"] as const;

export interface SttDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  /** Only ever asked `which(<codex binary>)` — no verb here runs an external tool. */
  exec: Exec;
  /**
   * Whether there is a terminal to ask at all.
   *
   * Asked BEFORE a question is printed, not deduced from a `null` answer afterwards: an unattended
   * run must not have the lead-in copy of a question nobody can answer scrolling past in its log,
   * and on the codex path it must not see the consent prompt at all.
   */
  interactive: boolean;
  /**
   * The free-text ask, behind a seam. `null` means "nobody is there to answer" — the same refusal
   * {@link interactive} predicts, kept as the belt to that pair of braces.
   */
  prompt(question: string): string | null | Promise<string | null>;
  /**
   * The identity probe, injected so no test dials `chatgpt.com`. Production leaves it: it is
   * `bridge/stt/codex.ts`'s `probeCodexIdentity`, which spends one honest request and at most one
   * impersonating one.
   */
  probe?(settings: CodexSttSettings): Promise<SttWireIdentity>;
  /** The provider builder, injected by `stt test`'s tests. Production leaves it. */
  create?(settings: SttSettings): SttProvider;
  /** Injected so a test can pin the reported round trip. */
  now?(): number;
}

const settingsPath = (deps: SttDeps): string => join(deps.ctx.stateDir, STT_FILENAME);

/** The raw shape `bridge/stt/config.ts` reads a file (or the environment) into. */
type RawSettings = ReturnType<typeof coerceSttFile>;

/** `stt.json` as it is on disk. Absent, unreadable or malformed all read as "nothing in the file". */
function readFileSettings(deps: SttDeps): RawSettings {
  const raw = deps.files.read(settingsPath(deps));
  if (raw === null) return coerceSttFile(undefined);
  try {
    // SAFETY: `JSON.parse` answers with a JSON value, and `coerceSttFile` is its only reader — every
    // field it names is checked before it is believed.
    return coerceSttFile(JSON.parse(raw) as JsonValue);
  } catch {
    return coerceSttFile(undefined);
  }
}

/** The environment keys that are set right now, in the order {@link STT_ENV_KEYS} declares them. */
function liveEnvKeys(ctx: CliContext): string[] {
  return Object.values(STT_ENV_KEYS).filter((name) => (ctx.env[name] ?? "").trim() !== "");
}

// ── setup ────────────────────────────────────────────────────────────────────

const SETUP_USAGE = [
  "usage: collie stt setup [--provider openai-compatible|codex]",
  "                        [--url <base>] [--model <name>] [--key <api-key>]",
  "                        [--lang <iso-639-1>]                                (openai-compatible)",
  "                        [--codex-bin <path>] [--accept-risk]                (codex)",
];

/**
 * `collie stt setup` — pick a provider, prove it is usable, and write `<stateDir>/stt.json`.
 *
 * Interactive by default and fully scriptable by flag: every question below is skipped when the flag
 * that answers it is present, which is what lets a provisioning run configure a host without a tty.
 * A run that is neither — no flag, no terminal — REFUSES and writes nothing rather than guessing.
 */
export async function cmdSttSetup(deps: SttDeps, args: readonly string[]): Promise<number> {
  const { flags, bare } = parsePackArgs(args, BARE_FLAGS);

  const provider = await chooseProvider(deps, flags.provider);
  if (provider === null) return EXIT.FAIL;
  const document =
    provider === "codex"
      ? await setupCodex(deps, flags, bare.has("accept-risk"))
      : await setupOpenAi(deps, flags);
  if (document === null) return EXIT.FAIL;

  // The bridge's own resolve is the acceptance test. Anything it would refuse at request time is
  // refused HERE, while the operator is still standing at the terminal — a microphone button that
  // only fails after somebody has spoken into it is the outcome this line exists to prevent. The
  // environment is deliberately empty for this check: what is being validated is the FILE.
  const warnings: string[] = [];
  const resolved = resolveSttSettings(document, {}, (m) => warnings.push(m));
  if (resolved === null) {
    for (const line of warnings) deps.io.err(`error: ${line}`);
    deps.io.err("Nothing was written.");
    return EXIT.FAIL;
  }
  // The one field the resolve REWRITES rather than merely accepts: a base URL is canonicalised
  // (trailing slashes stripped) so `<base>/audio/transcriptions` is one shape whatever was typed.
  // Storing the canonical form keeps the file and `stt status` agreeing with the request that will
  // actually be sent. Nothing else is copied back — a defaulted model must stay ABSENT in the file,
  // or this install would be pinned to today's default forever.
  if (resolved.provider === "openai-compatible") {
    document.baseUrl = resolved.baseUrl;
    // The second rewritten field, for the same reason: the resolve lower-cases a language and
    // narrows a regional tag (`en-GB` → `en`), and a file saying one thing while the wire carries
    // another is exactly what `stt status` exists to prevent.
    if (resolved.language !== undefined) document.language = resolved.language;
  }

  // Written through a temporary name in the same directory and renamed into place: a `setup` that
  // died mid-write must leave the previous configuration intact, never a half-file the bridge would
  // then read as "the operator turned this off".
  const path = settingsPath(deps);
  const temporary = `${path}.tmp`;
  try {
    deps.files.mkdirp(deps.ctx.stateDir, 0o700);
    deps.files.write(temporary, `${JSON.stringify(document, null, 2)}\n`, 0o600);
    deps.files.rename(temporary, path);
  } catch (err) {
    deps.files.remove(temporary);
    deps.io.err(`error: could not write ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  deps.io.out(`✓ speech-to-text configured — ${path} (owner-only)`);
  deps.io.out("  Live immediately — no restart needed. The bridge re-reads this file per request.");
  deps.io.out("  Check it end to end with `collie stt test`.");
  reportEnvOverrides(deps);
  return EXIT.OK;
}

/** Which provider, from the flag or from the operator. `null` when there is no usable answer. */
async function chooseProvider(
  deps: SttDeps,
  flag: string | undefined,
): Promise<SttProviderName | null> {
  const named = flag ?? (await askProvider(deps));
  if (named === null) return null;
  const known = STT_PROVIDERS.find((p) => p === named);
  if (known === undefined) {
    deps.io.err(`error: unknown provider \`${named}\` — expected ${STT_PROVIDERS.join(" or ")}.`);
    for (const line of SETUP_USAGE) deps.io.err(line);
    return null;
  }
  return known;
}

async function askProvider(deps: SttDeps): Promise<string | null> {
  if (!deps.interactive) {
    deps.io.err("error: this run is not interactive, and it would have asked which provider to use.");
    deps.io.err("       Pass it: `collie stt setup --provider openai-compatible|codex`.");
    return null;
  }
  deps.io.out("Which speech-to-text provider?");
  deps.io.out("  openai-compatible  any endpoint that speaks POST /audio/transcriptions —");
  deps.io.out("                     the public OpenAI API, or a local whisper.cpp / parakeet.cpp");
  deps.io.out("                     server, which is the zero-egress choice and the one to prefer.");
  deps.io.out("  codex              borrow your own `codex` sign-in. No new key, no new account —");
  deps.io.out("                     and a private endpoint that may break without notice.");
  const answered = (await deps.prompt("provider [openai-compatible]: "))?.trim();
  if (answered === undefined) {
    deps.io.err("error: this run is not interactive, and it would have asked which provider to use.");
    deps.io.err("       Pass it: `collie stt setup --provider openai-compatible|codex`.");
    return null;
  }
  return answered === "" ? "openai-compatible" : answered;
}

/** The `openai-compatible` document, or null when the operator gave nothing usable. */
async function setupOpenAi(
  deps: SttDeps,
  flags: Readonly<Record<string, string>>,
): Promise<RawSettings | null> {
  const url = await ask(deps, flags.url, {
    lead: [
      "The API base, INCLUDING its version prefix — the provider appends /audio/transcriptions.",
      "  local  http://127.0.0.1:8080/v1     (whisper.cpp / parakeet.cpp — nothing leaves the host)",
      "  cloud  https://api.openai.com/v1    (room audio leaves this machine)",
    ],
    question: "base URL: ",
    missing: "the endpoint — `collie stt setup --url <base>`",
  });
  if (url === null) return null;
  if (url === "") {
    deps.io.err("error: no endpoint given. Nothing was written.");
    return null;
  }

  const model = await ask(deps, flags.model, {
    lead: [`The model the endpoint understands. Empty takes Collie's default, ${DEFAULT_STT_MODEL}.`],
    question: `model [${DEFAULT_STT_MODEL}]: `,
    missing: `the model — \`collie stt setup --model <name>\` (default ${DEFAULT_STT_MODEL})`,
    optional: true,
  });
  if (model === null) return null;

  const key = await ask(deps, flags.key, {
    lead: [
      "The API key, if the endpoint wants one. LEAVE IT EMPTY for a self-hosted endpoint that takes",
      "no authentication — keyless is a supported mode, and Collie then sends no Authorization header",
      "at all rather than an empty one.",
      `This terminal cannot read without echo, so what you type is visible here; it lands in ${STT_FILENAME}`,
      "at mode 0600 and is never printed again.",
    ],
    question: "API key [none]: ",
    missing: "the API key — `collie stt setup --key <api-key>` (omit it for a keyless endpoint)",
    optional: true,
  });
  if (key === null) return null;

  const language = await ask(deps, flags.lang, {
    lead: [
      "The language you speak, as a two-letter ISO-639-1 code — en, de, tr, ja.",
      "LEAVE IT EMPTY to let the model detect it, which is what you want if you mix languages in one",
      "sentence. Name one only if short clips keep coming back in a language you did not speak: a few",
      "seconds of accented audio is too little for the model to detect from, and it guesses.",
    ],
    question: "spoken language [auto-detect]: ",
    missing: "the spoken language — `collie stt setup --lang <iso-639-1>` (omit it for auto-detect)",
    optional: true,
  });
  if (language === null) return null;

  const document: RawSettings = { provider: "openai-compatible", baseUrl: url };
  if (model !== "") document.model = model;
  // Same rule as the key: absent means auto-detect, so an empty answer must leave the field OUT
  // rather than write `""` — a present-and-empty value is a language the resolve would refuse.
  if (language !== "") document.language = language;
  // Assigned, never present-and-empty: "no credential" must be the ABSENCE of the field, or the
  // provider would send `Bearer ` at an endpoint that asked for nothing.
  if (key !== "") document.apiKey = key;
  return document;
}

/** One question: the flag if it is there, the terminal if it is not, `null` when neither can answer. */
async function ask(
  deps: SttDeps,
  flag: string | undefined,
  copy: { lead: string[]; question: string; missing: string; optional?: boolean },
): Promise<string | null> {
  if (flag !== undefined) return flag.trim();
  // An optional question nobody can answer takes its default in silence. A required one is a
  // refusal, and it names the flag that would have answered it.
  const answered = deps.interactive ? await askAt(deps, copy) : null;
  if (answered !== null) return answered.trim();
  if (copy.optional === true) return "";
  deps.io.err(`error: this run is not interactive, and it would have asked for ${copy.missing}.`);
  deps.io.err("       Nothing was written.");
  return null;
}

async function askAt(
  deps: SttDeps,
  copy: { lead: string[]; question: string },
): Promise<string | null> {
  for (const line of copy.lead) deps.io.out(line);
  return await deps.prompt(copy.question);
}

// ── setup: the codex provider ────────────────────────────────────────────────

/**
 * The paragraph that is the whole difference between this provider and the one ADR 0029 records as
 * declined. It is printed BEFORE anything is spawned, dialled or written, and the run stops here
 * unless the operator says the word.
 */
function consentParagraph(deps: SttDeps, codexPath: string): void {
  deps.io.out("");
  deps.io.out("── Read this before you accept ──────────────────────────────────────────────");
  deps.io.out(`  Recordings would be sent to ${CODEX_TRANSCRIBE_URL}.`);
  deps.io.out("  That endpoint is PRIVATE and UNSUPPORTED. It is undocumented, nobody owes Collie");
  deps.io.out("  compatibility with it, and it may stop working at any time without notice.");
  deps.io.out("");
  deps.io.out(`  Every request is authorised by a short-lived token from YOUR sign-in at ${codexPath}.`);
  deps.io.out("  So YOUR ChatGPT account carries the exposure: the rate limits are yours, and so is");
  deps.io.out("  any suspension or ban that comes of using a private endpoint this way.");
  deps.io.out("");
  deps.io.out("  Collie asks the endpoint under its OWN name first. If that is refused, the fallback");
  deps.io.out("  wears the Codex CLI's headers — that is impersonation, and accepting here is what");
  deps.io.out("  permits it. Whichever identity is accepted gets written into the config, in a word");
  deps.io.out("  you can read back with `collie stt status`.");
  deps.io.out("");
  deps.io.out("  Nothing has run yet. Nothing is written unless you accept.");
  deps.io.out("─────────────────────────────────────────────────────────────────────────────");
}

/** The `codex` document, or null when the binary is missing, consent is absent, or the probe failed. */
async function setupCodex(
  deps: SttDeps,
  flags: Readonly<Record<string, string>>,
  acceptedByFlag: boolean,
): Promise<RawSettings | null> {
  const codexBin = locateCodex(deps, flags["codex-bin"]);
  if (codexBin === null) return null;

  consentParagraph(deps, codexBin);
  if (!(await accepted(deps, acceptedByFlag))) return null;

  deps.io.out("");
  deps.io.out("Probing the endpoint — honest identity first…");
  const settings: CodexSttSettings = { provider: "codex", codexBin, wireIdentity: "honest" };
  let identity: SttWireIdentity;
  try {
    identity = await (deps.probe ?? probeCodexIdentity)(settings);
  } catch (err) {
    // Including the sign-in failures `bridge/stt/codex-auth.ts` re-throws by name: "Codex is not
    // signed in — run `codex login`" is a different sentence from "both identities were refused",
    // and it must reach the operator as itself.
    deps.io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    deps.io.err("Nothing was written — the identity is only recorded once the endpoint has accepted it.");
    return null;
  }

  if (identity === "codex-cli") {
    deps.io.out("");
    deps.io.out("  ⚠ THE HONEST IDENTITY WAS REFUSED. The endpoint accepted Collie only while it wore");
    deps.io.out("    the Codex CLI's own headers (`originator: codex_cli_rs`). Collie will impersonate");
    deps.io.out("    the Codex CLI on every transcription from now on. That is what you just accepted,");
    deps.io.out("    it is recorded as `wireIdentity: \"codex-cli\"`, and `collie stt off` ends it.");
  } else {
    deps.io.out("  ✓ The endpoint accepted Collie under its own name. No impersonation is configured;");
    deps.io.out("    the recorded identity is `honest`, and no `originator` header is ever sent.");
  }
  return { provider: "codex", codexBin, wireIdentity: identity };
}

/**
 * The `codex` binary, as an absolute path.
 *
 * Resolved here rather than left as the bare default, and written into the config as what was found:
 * the bridge spawns it from a systemd user unit whose PATH is minimal, so a bare name that resolves
 * in the operator's login shell may resolve nowhere at all in the service (the lesson `cli/tools.ts`
 * exists for). A value the operator spelled with a slash is theirs and is only checked for existence.
 */
function locateCodex(deps: SttDeps, flag: string | undefined): string | null {
  const named = flag?.trim();
  if (named !== undefined && named !== "") {
    if (named.includes("/")) {
      if (deps.files.exists(named)) return named;
      deps.io.err(`error: no such file: ${named} (--codex-bin)`);
      return null;
    }
    const found = deps.exec.which(named);
    if (found !== null) return found;
    deps.io.err(`error: \`${named}\` was not found on PATH (--codex-bin).`);
    return null;
  }
  const found = deps.exec.which(DEFAULT_CODEX_BIN);
  if (found !== null) return found;
  deps.io.err(`error: no \`${DEFAULT_CODEX_BIN}\` binary was found on PATH.`);
  deps.io.err("       The codex provider borrows that binary's sign-in; install it, or pass");
  deps.io.err("       `--codex-bin <path>`, or use `--provider openai-compatible`.");
  return null;
}

/** Consent: the flag, or the word `yes` typed at a terminal. Nothing else counts. */
async function accepted(deps: SttDeps, byFlag: boolean): Promise<boolean> {
  if (byFlag) {
    deps.io.out("  --accept-risk was passed: the risks above are accepted for this run.");
    return true;
  }
  const answered = deps.interactive
    ? await deps.prompt('Type "yes" to accept these risks, anything else to stop: ')
    : null;
  if (answered === null) {
    deps.io.err("error: this run is not interactive, so the risks above cannot be accepted at a prompt.");
    deps.io.err("       Pass `--accept-risk` to accept them in a script. Nothing was written.");
    return false;
  }
  if (answered.trim().toLowerCase() !== "yes") {
    deps.io.err("Stopped — the risks were not accepted. Nothing was written, and nothing ran.");
    return false;
  }
  return true;
}

// ── test ─────────────────────────────────────────────────────────────────────

/**
 * `collie stt test` — one real round trip through the configured provider.
 *
 * The clip is a fifth of a second of generated digital silence, the same bytes the setup probe uses.
 * A silent clip legitimately transcribes to nothing, so an EMPTY answer is a PASS: what this verb
 * proves is that the credential, the endpoint and the response shape all work, not that anything was
 * heard. That is said in the output, because a bare empty line reads like a failure.
 */
export async function cmdSttTest(deps: SttDeps): Promise<number> {
  const settings = loadSettings(deps);
  if (settings === null) return EXIT.FAIL;

  const provider = (deps.create ?? createSttProvider)(settings);
  const clock = deps.now ?? Date.now;
  deps.io.out(`provider: ${describeProvider(settings)}`);
  deps.io.out("sending:  0.2 s of generated silence (audio/wav)");
  const started = clock();
  try {
    const result = await provider.transcribe({
      audio: silentWavBytes(),
      mimeType: "audio/wav",
      filename: "collie-stt-test.wav",
    });
    const elapsed = clock() - started;
    deps.io.out(`✓ round trip in ${elapsed} ms`);
    deps.io.out(
      result.text.trim() === ""
        ? "  transcript: (empty) — expected from silence, and the empty answer still proves the pipeline."
        : `  transcript: ${result.text}`,
    );
    return EXIT.OK;
  } catch (err) {
    const elapsed = clock() - started;
    deps.io.err(`error: transcription failed after ${elapsed} ms`);
    if (err instanceof SttError) {
      deps.io.err(`       kind: ${err.kind}`);
      deps.io.err(`       ${err.message}`);
    } else {
      deps.io.err(`       ${err instanceof Error ? err.message : String(err)}`);
    }
    return EXIT.FAIL;
  } finally {
    // The codex provider owns a `codex app-server` child. A test run that left one behind would be a
    // process leak the operator never asked for.
    provider.close?.();
  }
}

/** The settings the BRIDGE would run with: the file, then the environment on top. */
function loadSettings(deps: SttDeps): SttSettings | null {
  const warnings: string[] = [];
  const settings = resolveSttSettings(
    readFileSettings(deps),
    sttEnvSettings(deps.ctx.env),
    (m) => warnings.push(m),
  );
  if (settings !== null) return settings;
  for (const line of warnings) deps.io.err(`error: ${line}`);
  if (warnings.length === 0) {
    deps.io.err("error: speech-to-text is off — nothing is configured on this machine.");
    deps.io.err("       Run `collie stt setup`.");
  }
  return null;
}

/** One line naming the provider and the thing it will actually talk to. Never the credential. */
function describeProvider(settings: SttSettings): string {
  if (settings.provider === "codex") {
    return `codex (${settings.codexBin}, identity ${settings.wireIdentity})`;
  }
  const language = settings.language === undefined ? "auto-detect" : settings.language;
  return `openai-compatible (${settings.baseUrl}, model ${settings.model}, language ${language})`;
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * `collie stt status` — what is configured, and where each part of it came from.
 *
 * Every row carries its source, because the two-source resolve is the thing that surprises: an
 * environment variable silently outranks the file `stt setup` wrote, and an operator staring at a
 * correct `stt.json` needs to be told that in one line rather than deduce it.
 */
export function cmdSttStatus(deps: SttDeps): number {
  const file = readFileSettings(deps);
  const env = sttEnvSettings(deps.ctx.env);
  const warnings: string[] = [];
  const settings = resolveSttSettings(file, env, (m) => warnings.push(m));
  const path = settingsPath(deps);

  // Where one field's value came from, in the same precedence the bridge resolves in.
  const source = (name: keyof RawSettings, fallback = "default"): string => {
    if (env[name] !== undefined) return STT_ENV_KEYS[envKeyOf(name)];
    if (file[name] !== undefined) return STT_FILENAME;
    return fallback;
  };
  const row = (label: string, value: string, from: string): void =>
    deps.io.out(`  ${label.padEnd(9)} ${value.padEnd(34)} (${from})`);

  if (settings === null) {
    if (warnings.length === 0) {
      deps.io.out("speech-to-text: off — nothing configured. Run `collie stt setup` to turn it on.");
      deps.io.out(`  config    ${path} (absent)`);
      return EXIT.OK;
    }
    // Present but unusable is a real problem, not an "off": something was configured and it is being
    // ignored, so this exits non-zero even though the verb only reads.
    deps.io.out("speech-to-text: off — the configuration on this machine cannot be used.");
    for (const line of warnings) deps.io.err(`  ${line}`);
    deps.io.out(`  config    ${path}`);
    return EXIT.FAIL;
  }

  deps.io.out("speech-to-text: on");
  row("provider", settings.provider, source("provider"));
  if (settings.provider === "codex") {
    row("binary", settings.codexBin, source("codexBin", "default"));
    row("endpoint", CODEX_TRANSCRIBE_URL, "fixed");
    row("identity", identityLabel(settings.wireIdentity), source("wireIdentity", "default"));
    // Named only when it is set, and named as IGNORED. The codex endpoint takes one part, `file`,
    // and no language; an operator who switched providers with the field still in place would
    // otherwise be left believing it applies.
    if (file.language !== undefined || env.language !== undefined) {
      row("language", "ignored — this endpoint takes no language", source("language"));
    }
  } else {
    row("endpoint", settings.baseUrl, source("baseUrl"));
    row("model", settings.model, source("model", "default"));
    row("api key", keyLabel(settings.apiKey), settings.apiKey === undefined ? "none" : source("apiKey"));
    row(
      "language",
      settings.language ?? "auto-detect — the model decides",
      settings.language === undefined ? "default" : source("language"),
    );
  }
  deps.io.out(`  config    ${path}${deps.files.exists(path) ? "" : " (absent)"}`);
  return EXIT.OK;
}

/** The env key that carries one raw field. One switch, so a renamed field cannot silently mis-report. */
function envKeyOf(name: keyof RawSettings): keyof typeof STT_ENV_KEYS {
  if (name === "baseUrl") return "url";
  if (name === "apiKey") return "key";
  return name;
}

/** The identity, in the plainest words available. `codex-cli` is never softened. */
function identityLabel(identity: SttWireIdentity): string {
  return identity === "codex-cli"
    ? "codex-cli — impersonating the Codex CLI (accepted at setup)"
    : "honest — Collie names itself on the wire";
}

/** Enough to recognise a key by, and no more. Never the key. */
function keyLabel(apiKey: string | undefined): string {
  if (apiKey === undefined) return "none — the endpoint is dialled without one";
  return apiKey.length <= 4 ? "set" : `set (…${apiKey.slice(-4)})`;
}

// ── off ──────────────────────────────────────────────────────────────────────

/**
 * `collie stt off` — remove `stt.json`, and only `stt.json`.
 *
 * Not "clear the state dir": the pairing registry, the trust store and the push subscriptions all
 * live beside this file and none of them are this verb's business. A second `off` is a clean no-op,
 * so it is safe in a provisioning script that does not know the current state.
 */
export function cmdSttOff(deps: SttDeps): number {
  const path = settingsPath(deps);
  const existed = deps.files.exists(path);
  try {
    deps.files.remove(path);
  } catch (err) {
    deps.io.err(`error: could not remove ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(
    existed
      ? `✓ removed ${path} — speech-to-text is off from the next request (no restart needed).`
      : `speech-to-text was already off — no ${path} to remove.`,
  );
  reportEnvOverrides(deps, "off");
  return EXIT.OK;
}

/**
 * Name the environment variables that outrank the file, whenever one is set.
 *
 * After `setup` it is the difference between "I configured it" and "I configured it and something
 * else is winning"; after `off` it is the difference between off and still-on. Names only — the
 * values may include a credential.
 */
function reportEnvOverrides(deps: SttDeps, verb: "setup" | "off" = "setup"): void {
  const live = liveEnvKeys(deps.ctx);
  if (live.length === 0) return;
  deps.io.out(
    verb === "off"
      ? `  ⚠ but the environment still configures it, and the environment wins: ${live.join(", ")}.`
      : `  ⚠ the environment overrides part of this, field by field: ${live.join(", ")}.`,
  );
  deps.io.out("    Unset them (or edit this install's .env) — `collie stt status` shows what won.");
}

// ── the parent verb ──────────────────────────────────────────────────────────

export function sttUsage(): string {
  return `usage: collie stt {${STT_SUBCOMMANDS.join("|")}}`;
}

/**
 * Reached only when no sub-verb matched — a bare `collie stt`, or a misspelt one — and it names each
 * sub-verb with its summary, as `cmdDevices` and `cmdPack` do.
 */
export async function cmdStt(deps: SttDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup":
      return await cmdSttSetup(deps, rest);
    case "test":
      return await cmdSttTest(deps);
    case "status":
      return cmdSttStatus(deps);
    case "off":
      return cmdSttOff(deps);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown stt subcommand \`${sub}\``);
      }
      deps.io.err(sttUsage());
      deps.io.err("  setup    pick a provider and write it into the state dir (interactive or by flag)");
      deps.io.err("  test     one real round trip through what is configured");
      deps.io.err("  status   the provider, where each setting came from, and whether it is on");
      deps.io.err("  off      remove stt.json — speech-to-text is absent again");
      return EXIT.USAGE;
  }
}
