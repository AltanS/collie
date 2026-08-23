import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { diskIo, type OperatorFileIo } from "../operator-file.ts";
import { jsonRecord, jsonStringField } from "./json.ts";

// ── WHERE THE SPEECH-TO-TEXT SETTINGS COME FROM ──────────────────────────────────────────────
//
// Two sources, in one fixed order: `<stateDir>/stt.json`, then the environment on top of it,
// field by field. The environment wins because it is the deployment's own statement — a systemd
// drop-in or a Herdr plugin setting has to be able to point a checkout at a different endpoint
// without editing state the CLI owns.
//
// The file lives in the STATE dir rather than beside the operator's `.env`, for the reason pairing
// does: it can hold a credential, so it is written 0600 into a 0700 directory by `collie stt setup`
// and is never an operator-authored TOML anyone is invited to hand-edit. Nothing here writes it —
// this module only ever reads.
//
// It is re-read at request time behind an mtime check, exactly like `commands.toml` (and through
// the very same {@link OperatorFileIo} seam), so `collie stt setup` goes live with no restart. The
// path is derived from the state dir at startup and is NEVER client-supplied.
//
// A malformed file is a HOLD, never a 500: the last good settings keep serving, warned once per
// change rather than once per request. Feature-on is not a switch — it is "a provider resolved".

/** The file under the state dir holding the speech-to-text settings. */
export const STT_FILENAME = "stt.json";

/** Collie's default model once an OpenAI-compatible endpoint is configured. */
export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";

/**
 * The provider names this bridge can build. A one-member union today; the codex provider slots in
 * beside it without the file shape or this reader changing.
 */
export const STT_PROVIDERS = ["openai-compatible"] as const;
export type SttProviderName = (typeof STT_PROVIDERS)[number];

/** One configured OpenAI-compatible endpoint. */
export interface OpenAiSttSettings {
  provider: "openai-compatible";
  /**
   * The API base INCLUDING its version prefix (`https://api.openai.com/v1`), with no trailing
   * slash — the provider appends `/audio/transcriptions` itself.
   */
  baseUrl: string;
  /** The model the endpoint understands. Always resolved; {@link DEFAULT_STT_MODEL} when unstated. */
  model: string;
  /**
   * The bearer credential, when there is one. ABSENT is a supported mode, not a mistake: a
   * self-hosted endpoint on the tailnet may take no authentication at all, and the provider then
   * sends no `Authorization` header rather than an empty one.
   */
  apiKey?: string;
}

/** Everything a resolved provider can be. A union of exactly one, for now. */
export type SttSettings = OpenAiSttSettings;

/** The environment keys this module reads. Named once so the CLI and the docs can cite them. */
export const STT_ENV_KEYS = {
  url: "COLLIE_STT_URL",
  model: "COLLIE_STT_MODEL",
  key: "COLLIE_STT_KEY",
} as const;

/** The path `stt.json` sits at, given the bridge's state dir. */
export function sttSettingsPath(stateDir: string): string {
  return join(stateDir, STT_FILENAME);
}

/** A field of the settings as it arrived, before anything is believed about it. */
interface RawSettings {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** A trimmed string, or undefined when the value is absent, not a string, or blank. */
function optionalString(value: JsonValue | undefined): string | undefined {
  const raw = jsonStringField(value);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Coerce the parsed file into the fields this module knows, dropping anything else. A hand-edited
 * file with a number where a string belongs degrades to "that field was not set", which then either
 * falls through to the environment or fails the resolve below — never to a URL of `[object Object]`.
 */
export function coerceSttFile(raw: JsonValue | undefined): RawSettings {
  const o = jsonRecord(raw);
  if (o === null) return {};
  return {
    provider: optionalString(o.provider),
    baseUrl: optionalString(o.baseUrl),
    model: optionalString(o.model),
    apiKey: optionalString(o.apiKey),
  };
}

/** The environment's half of the settings — the same three fields, none of them required. */
export function sttEnvSettings(env: Record<string, string | undefined>): RawSettings {
  return {
    baseUrl: optionalString(env[STT_ENV_KEYS.url]),
    model: optionalString(env[STT_ENV_KEYS.model]),
    apiKey: optionalString(env[STT_ENV_KEYS.key]),
  };
}

/**
 * Canonicalise an API base, or null when it is not one Collie will dial.
 *
 * http(s) only — a `file:` or `data:` base would turn a settings typo into a local read — and the
 * trailing slash is stripped so `<base>/audio/transcriptions` is one shape whatever the operator
 * typed.
 */
function canonicalBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString().replace(/\/+$/, "");
}

/**
 * The settings this bridge will actually run with, or null when speech-to-text is off.
 *
 * Off is the default and is never an error: an operator who configured nothing gets `null` in
 * silence. A configuration that is PRESENT but unusable is a different thing — it warns and still
 * returns null, because the alternative is a microphone button that fails only after the operator
 * has spoken into it.
 */
export function resolveSttSettings(
  file: RawSettings,
  env: RawSettings,
  warn: (message: string) => void,
): SttSettings | null {
  const provider = file.provider ?? "openai-compatible";
  const baseUrl = env.baseUrl ?? file.baseUrl;
  const model = env.model ?? file.model;
  const apiKey = env.apiKey ?? file.apiKey;

  // Nothing was configured at all — the ordinary case, and not something to warn about.
  if (baseUrl === undefined && model === undefined && apiKey === undefined && file.provider === undefined) {
    return null;
  }
  if (!STT_PROVIDERS.some((known) => known === provider)) {
    warn(`speech-to-text is off: unknown provider "${provider}" (expected ${STT_PROVIDERS.join(", ")})`);
    return null;
  }
  if (baseUrl === undefined) {
    warn(`speech-to-text is off: no endpoint configured (set ${STT_ENV_KEYS.url} or "baseUrl" in ${STT_FILENAME})`);
    return null;
  }
  const canonical = canonicalBase(baseUrl);
  if (canonical === null) {
    warn(`speech-to-text is off: the endpoint must be an http(s) URL (${STT_ENV_KEYS.url} / "baseUrl")`);
    return null;
  }
  // A keyless request to OpenAI's own API can only fail — and it fails AFTER the audio has been
  // uploaded, so the operator pays for the recording to learn about the missing key. Refuse here
  // instead. A self-hosted compatible endpoint may legitimately want no credential, which is why
  // this check names one origin rather than requiring a key of everyone.
  const officialOpenAi = new URL(canonical).origin === "https://api.openai.com";
  if (officialOpenAi && apiKey === undefined) {
    warn(`speech-to-text is off: ${STT_ENV_KEYS.key} is required for api.openai.com`);
    return null;
  }

  const settings: OpenAiSttSettings = {
    provider: "openai-compatible",
    baseUrl: canonical,
    model: model ?? DEFAULT_STT_MODEL,
  };
  // Assigned, never spread in as `undefined`: "no credential" is a mode, and it must be the ABSENCE
  // of the field rather than a present-and-empty one the provider could send as a bearer token.
  if (apiKey !== undefined) settings.apiKey = apiKey;
  return settings;
}

/**
 * A reader for `<stateDir>/stt.json` + the environment, re-read behind an mtime check.
 *
 * The mtime cache covers the FILE only; the environment is read on every call because it costs
 * nothing and a process's environment does not change under it anyway. A file that stops parsing
 * keeps the last good settings and warns once per change, exactly like the operator TOML readers.
 */
export function createSttSettingsReader(opts: {
  stateDir: string;
  warn: (message: string) => void;
  io?: OperatorFileIo;
  env?: Record<string, string | undefined>;
}): () => Promise<SttSettings | null> {
  const path = sttSettingsPath(opts.stateDir);
  const io = opts.io ?? diskIo;
  const env = opts.env ?? process.env;
  // `seen` is the mtime `file` was derived from — including that of a file that FAILED to parse,
  // which is what stops a broken file re-warning on every request.
  let seen: number | null | undefined;
  let file: RawSettings = {};
  return async () => {
    const mtime = await io.mtime(path);
    if (mtime !== seen) {
      seen = mtime;
      if (mtime === null) {
        file = {};
      } else {
        try {
          // SAFETY: `JSON.parse` answers with a JSON value and `coerceSttFile` is its only reader —
          // every field it names is checked before it is believed.
          file = coerceSttFile(JSON.parse(await io.read(path)) as JsonValue);
        } catch (err) {
          opts.warn(`${path} could not be parsed (${String(err)}) — keeping the last good settings`);
        }
      }
    }
    return resolveSttSettings(file, sttEnvSettings(env), opts.warn);
  };
}
