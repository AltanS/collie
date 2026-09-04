import type { JsonObject, JsonValue } from "../json.ts";
import { pluginRoot } from "../root.ts";
import { collieVersionBare } from "../version.ts";
import type { CodexSttSettings, SttWireIdentity } from "./config.ts";
import { createCodexAuthBroker, type CodexAuthBroker } from "./codex-auth.ts";
import { jsonRecord, jsonStringField } from "./json.ts";
import type { FetchFn } from "./openai.ts";
import {
  createSttDeadline,
  SttCancelledError,
  SttError,
  type SttAudio,
  type SttDeadline,
  type SttProvider,
  type SttResult,
  type SttStatus,
} from "./provider.ts";
import { discardBody, parseTranscript, readCapped } from "./transcript.ts";

// ── THE CODEX PROVIDER ───────────────────────────────────────────────────────────────────────
//
// One request, to one endpoint Collie does not get to choose:
// `POST https://chatgpt.com/backend-api/transcribe`, multipart, the audio in a field called `file`,
// authorised by a short-lived token the operator's own `codex` binary handed over (codex-auth.ts).
//
// The endpoint is PRIVATE. It owes Collie nothing, it is undocumented, and it will break. That is
// accepted in ADR 0029 and it is why `collie stt test` exists — so the day it breaks, the failure is
// one command away from being diagnosed instead of being "the microphone stopped working".
//
// ── The identity, which is the whole reason this provider was once declined ──────────────────
//
// #115 reached this endpoint wearing the Codex CLI's `originator` header and the operator's own
// ChatGPT token, silently. Impersonation nobody was asked about is not a trade an operator can
// consent to. So the identity is a SETTING, resolved once by {@link probeCodexIdentity} at
// `collie stt setup`, written into `stt.json` in a word the operator can read back, and never
// inferred at request time:
//
//   • `honest`    — `User-Agent: Collie/<version>`, and NO `originator` header at all.
//   • `codex-cli` — the CLI's headers verbatim, reached only because `honest` was refused and the
//                   operator was told so in the setup consent step.
//
// Everything else mirrors openai.ts's hygiene, because the reasons are the same ones: a manual
// redirect (a 302 must never move an upload with a bearer token on it to a new host), a whole-call
// deadline, a capped response, no reflected error body, and a `fetch` that is a parameter so all of
// it is reachable from `bun test`.

/** The one endpoint this provider knows. Not configurable: it is not the operator's to choose. */
export const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

/**
 * The whole-operation deadline, including auth, one retry, and response cleanup.
 *
 * Two minutes, against openai.ts's one: this endpoint is on the far side of the public internet
 * from a phone-recorded clip, and a slow answer is still an answer worth waiting for.
 */
export const CODEX_TIMEOUT_MS = 120_000;

/** The claim shapes the ChatGPT account id has been seen under, both handled, in this order. */
const FLAT_ACCOUNT_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";
const NESTED_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Honest FIRST, always. The probe walks this list in order and takes the first identity the
 * endpoint accepts, so the impersonating one can only ever be reached by the honest one failing.
 */
const IDENTITY_ORDER: readonly SttWireIdentity[] = ["honest", "codex-cli"];

export interface CodexSttDeps {
  /** The auth broker. Injected by the tests and by `collie stt test`; otherwise built from settings. */
  broker?: CodexAuthBroker;
  fetch?: FetchFn;
  /** The deadline, overridable so a test does not have to wait two minutes to see one expire. */
  timeoutMs?: number;
  /** What the honest `User-Agent` names. Defaults to this checkout's own version. */
  version?: string;
  /**
   * Whether the first `status()` may warm the broker in the background. On by default and off in
   * the tests — see the note at {@link createCodexSttProvider}'s `status`.
   */
  prime?: boolean;
}

/**
 * A provider over the operator's own Codex sign-in.
 *
 * Nothing is spawned and nothing is dialled at construction time: the gate builds this inside a
 * snapshot poll, and a poll must stay free.
 */
export function createCodexSttProvider(settings: CodexSttSettings, deps: CodexSttDeps = {}): SttProvider {
  const transport = createTransport(settings, deps);
  const prime = deps.prime ?? true;
  let primed = false;

  return {
    id: settings.provider,

    /**
     * The LAST KNOWN state, never a fresh check.
     *
     * The snapshot route asks this on every poll, so it may not spawn a child, may not handshake and
     * may not block. What it may do is warm the broker ONCE — the first poll after this provider was
     * built answers "not checked yet", and every poll after it answers the truth. That single spawn
     * is the long-running child ADR 0029 sanctions, paid once per settings change by an operator who
     * asked for this provider by name; it is not a per-poll cost.
     */
    async status(): Promise<SttStatus> {
      if (prime && !primed) {
        primed = true;
        void transport.broker.probe();
      }
      return transport.broker.lastKnown();
    },

    async transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult> {
      // One lifecycle owns token acquisition, both possible uploads, and every response phase. A
      // 401 may refresh once, but it never earns a fresh two-minute budget.
      const deadline = createSttDeadline(signal, transport.timeoutMs);
      try {
        const response = await transport.send(input, settings.wireIdentity, deadline);
        if (isRedirect(response)) {
          await deadline.wait(discardBody(response));
          deadline.throwIfAborted();
          throw new SttError("refused", "the Codex transcription endpoint tried to redirect the upload");
        }
        const body = await deadline.wait(readCapped(response, deadline.signal));
        if (!response.ok) {
          // The status, and only the status. The body of a ChatGPT error can name the account, the
          // plan and an internal request id, and none of that belongs in a browser.
          throw new SttError("refused", codexRefusal(response.status));
        }
        return { text: parseTranscript(body) };
      } catch (err) {
        deadline.throwIfAborted();
        if (err instanceof SttError || err instanceof SttCancelledError) throw err;
        throw new SttError("unavailable", "the Codex transcription endpoint could not be reached");
      } finally {
        deadline.close();
      }
    },

    close(): void {
      transport.broker.close();
    },
  };
}

/**
 * Which identity this endpoint will actually accept — one honest request, then at most one
 * impersonating one. This is what `collie stt setup` calls, and its answer is what gets written
 * into `stt.json`.
 *
 * The clip it sends is a fifth of a second of digital silence, generated here rather than shipped
 * as a fixture so there is no binary in the tree whose contents nobody can read. What matters is the
 * STATUS LINE, not the transcript: an endpoint that accepts silence and returns an empty string has
 * accepted the identity, which is the only question being asked.
 *
 * An auth failure is NOT an identity verdict and is re-thrown as itself — "Codex is not signed in"
 * must never be reported to the operator as "both identities were refused".
 */
export async function probeCodexIdentity(
  settings: CodexSttSettings,
  deps: CodexSttDeps = {},
): Promise<SttWireIdentity> {
  const transport = createTransport(settings, deps);
  // One probe includes honest identity, its possible refresh, and only then the fallback identity.
  const deadline = createSttDeadline(undefined, transport.timeoutMs);
  const clip: SttAudio = { audio: silentWavBytes(), mimeType: "audio/wav", filename: "probe.wav" };
  const refusals: string[] = [];
  try {
    for (const identity of IDENTITY_ORDER) {
      const response = await transport.send(clip, identity, deadline);
      await deadline.wait(discardBody(response));
      deadline.throwIfAborted();
      if (response.ok && !isRedirect(response)) return identity;
      refusals.push(`${identity} → ${isRedirect(response) ? "a redirect" : codexRefusal(response.status)}`);
    }
    throw new SttError(
      "refused",
      `the Codex transcription endpoint accepted neither identity (${refusals.join("; ")})`,
    );
  } finally {
    deadline.close();
    // Only kill what this call started. A broker handed in by the caller outlives the probe.
    if (transport.owned) transport.broker.close();
  }
}

interface CodexTransport {
  readonly broker: CodexAuthBroker;
  /** True when the broker was built here, and is therefore this transport's to close. */
  readonly owned: boolean;
  /** The provider-local lifecycle budget, injectable only for hermetic tests. */
  readonly timeoutMs: number;
  /** One upload, with the single 401 → refresh → retry-once dance inside one lifecycle. */
  send(input: SttAudio, identity: SttWireIdentity, deadline: SttDeadline): Promise<Response>;
}

function createTransport(settings: CodexSttSettings, deps: CodexSttDeps): CodexTransport {
  const supplied = deps.broker;
  const broker =
    supplied ??
    createCodexAuthBroker({ codexBin: settings.codexBin, clientVersion: collieVersionOnce() });
  const doFetch = deps.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? CODEX_TIMEOUT_MS;
  const version = deps.version ?? collieVersionOnce();

  async function once(
    input: SttAudio,
    identity: SttWireIdentity,
    refresh: boolean,
    deadline: SttDeadline,
  ): Promise<Response> {
    try {
      deadline.throwIfAborted();
      // Do not abort a shared broker request: another caller may still need the same token. This
      // lifecycle only stops waiting and continues to observe its eventual result.
      const { accessToken } = await deadline.wait(broker.accessToken(refresh));
      deadline.throwIfAborted();
      const form = new FormData();
      form.append("file", new File([input.audio], input.filename, { type: input.mimeType }));

      return await deadline.wait(
        doFetch(CODEX_TRANSCRIBE_URL, {
          method: "POST",
          body: form,
          headers: identityHeaders(identity, accessToken, accountIdFromJwt(accessToken), version),
          // Manual, not "error": a 3xx has to be READ and refused as a 3xx, because the honest-identity
          // probe needs to tell "this endpoint bounced me" apart from "the network broke".
          redirect: "manual",
          signal: deadline.signal,
        }),
      );
    } catch (err) {
      deadline.throwIfAborted();
      if (err instanceof SttError || err instanceof SttCancelledError) throw err;
      throw new SttError("unavailable", "the Codex transcription endpoint could not be reached");
    }
  }

  return {
    broker,
    owned: supplied === undefined,
    timeoutMs,
    async send(input, identity, deadline) {
      const first = await once(input, identity, false, deadline);
      deadline.throwIfAborted();
      if (first.status !== 401) return first;
      // A 401 means the borrowed session lapsed mid-flight. Ask Codex to renew it and re-upload
      // ONCE — the recording is already in memory, and a second 401 is a real refusal, not a race.
      await deadline.wait(discardBody(first));
      deadline.throwIfAborted();
      return once(input, identity, true, deadline);
    },
  };
}

/**
 * The headers for one identity.
 *
 * A `Headers` rather than a dictionary so the absence of `originator` in honest mode is a fact about
 * the object the test can assert directly, in the same normalised form the runtime will send.
 */
function identityHeaders(
  identity: SttWireIdentity,
  accessToken: string,
  accountId: string,
  version: string,
): Headers {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "chatgpt-account-id": accountId,
  });
  if (identity === "codex-cli") {
    // Verbatim from #115, and only reachable because the endpoint refused the honest pair and the
    // operator agreed to this at `collie stt setup`. Do not "improve" either line: they are a claim
    // about what the endpoint accepts, not a description of Collie.
    headers.set("user-agent", "codex_cli_rs/0.0.0 (Collie)");
    headers.set("originator", "codex_cli_rs");
    return headers;
  }
  // Honest: Collie says it is Collie, and sends NO `originator` at all — not an empty one, not a
  // Collie-flavoured one. The header's absence is the signal.
  headers.set("user-agent", `Collie/${version}`);
  return headers;
}

/** A 3xx that `redirect: "manual"` handed back, in either of the two shapes a runtime reports it. */
function isRedirect(response: Response): boolean {
  if (response.type === "opaqueredirect") return true;
  return response.status >= 300 && response.status < 400;
}

/** One sentence per refusal status. Collie's own words — never the endpoint's body. */
function codexRefusal(status: number): string {
  if (status === 401) return "the Codex sign-in was rejected (401) — try `codex login`";
  if (status === 403) return "the Codex transcription endpoint refused this request (403)";
  if (status === 429) return "the Codex account is rate limited (429) — try again shortly";
  return `the Codex transcription endpoint answered ${status}`;
}

/**
 * The ChatGPT account id carried in the access token, read WITHOUT verifying the signature.
 *
 * That is deliberate and it is safe here: Collie is not authenticating anybody with this token, it
 * is passing it straight back to the service that minted it, and it needs one routing field out of
 * the payload to do so. Verifying would mean fetching and pinning ChatGPT's signing keys to learn a
 * value the same request is about to be checked against anyway.
 *
 * Two claim shapes, tried in this order, because both have been seen in the wild:
 *   • flat   — `"https://api.openai.com/auth.chatgpt_account_id": "acct-…"`
 *   • nested — `"https://api.openai.com/auth": { "chatgpt_account_id": "acct-…" }`
 */
export function accountIdFromJwt(token: string): string {
  const claims = jwtClaims(token);
  const flat = claims === null ? null : jsonStringField(claims[FLAT_ACCOUNT_CLAIM]);
  const nested = claims === null ? null : jsonRecord(claims[NESTED_AUTH_CLAIM]);
  const accountId = flat ?? (nested === null ? null : jsonStringField(nested.chatgpt_account_id));
  if (accountId === null || accountId === "") {
    throw new SttError("unavailable", "the Codex access token names no ChatGPT account");
  }
  return accountId;
}

/** The payload segment of a JWT, decoded and narrowed, or null when it is not readable as one. */
function jwtClaims(token: string): JsonObject | null {
  const payload = token.split(".")[1];
  if (payload === undefined || payload === "") return null;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction, and `jsonRecord` is the only
    // reader of it — every claim below is checked before it is believed.
    return jsonRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JsonValue);
  } catch {
    return null;
  }
}

/**
 * A fifth of a second of digital silence, as a 16-bit mono PCM WAV.
 *
 * Built byte by byte on purpose: a probe that ships a binary fixture is a probe whose payload nobody
 * in review can read, and `audio/wav` is the one container every transcription service demuxes.
 */
export function silentWavBytes(milliseconds = 200, sampleRate = 8_000): Uint8Array<ArrayBuffer> {
  const samples = Math.max(1, Math.round((sampleRate * milliseconds) / 1000));
  const dataBytes = samples * 2; // mono, 16 bits per sample
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // a PCM fmt chunk is 16 bytes
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // The samples themselves are already zero — silence is the absence of a write.
  return new Uint8Array(buffer);
}

/**
 * This checkout's own version, for the honest `User-Agent`.
 *
 * Resolved once and remembered: it reads two files and it cannot change without a restart, exactly
 * as `bridge/index.ts` treats the same answer for the pack wire.
 */
let cachedVersion: string | null = null;
function collieVersionOnce(): string {
  cachedVersion ??= collieVersionBare(pluginRoot());
  return cachedVersion;
}
