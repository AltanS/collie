import type { CodexAuthBroker } from "./codex-auth.ts";
import type { SttAudio, SttProvider, SttStatus } from "./provider.ts";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";
const REQUEST_TIMEOUT_MS = 120_000;

interface CodexProviderOptions {
  broker: CodexAuthBroker;
  fetch?: Fetcher;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CodexSttProvider implements SttProvider {
  readonly id = "codex";
  private readonly broker: CodexAuthBroker;
  private readonly fetcher: Fetcher;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: CodexProviderOptions) {
    this.broker = options.broker;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  status(): Promise<SttStatus> {
    return this.broker.status();
  }

  transcribe(input: SttAudio): Promise<{ text: string }> {
    // A 401 asks Codex to refresh its OAuth session. Keep that refresh and its retry ordered even
    // when two Collie clients record at once, so this process never starts competing refreshes.
    const result = this.tail.then(() => this.transcribeOnce(input));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async transcribeOnce(input: SttAudio): Promise<{ text: string }> {
    let response = await this.request(input, false);
    if (response.status === 401) response = await this.request(input, true);
    if (!response.ok) throw new Error(responseError(response.status));

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Codex returned an invalid transcription response");
    }
    const text = (payload as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Codex returned an empty transcription");
    }
    return { text: text.trim() };
  }

  close(): void {
    this.broker.close();
  }

  private async request(input: SttAudio, refresh: boolean): Promise<Response> {
    const { accessToken } = await this.broker.accessToken(refresh);
    const accountId = accountIdFromJwt(accessToken);
    const body = new FormData();
    const bytes = new Uint8Array(input.audio.byteLength);
    bytes.set(input.audio);
    body.append("file", new File([bytes.buffer], input.filename, { type: input.mimeType }));

    try {
      return await this.fetcher(TRANSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "ChatGPT-Account-ID": accountId,
          "User-Agent": "codex_cli_rs/0.0.0 (Collie)",
          originator: "codex_cli_rs",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("Codex transcription timed out");
      }
      throw new Error("Could not reach Codex transcription");
    }
  }
}

function accountIdFromJwt(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Codex access token is invalid");
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const accountId = claims[ACCOUNT_ID_CLAIM];
    if (typeof accountId !== "string" || !accountId) {
      throw new Error("missing account id");
    }
    return accountId;
  } catch {
    throw new Error("Codex access token has no ChatGPT account id");
  }
}

function responseError(status: number): string {
  if (status === 401) return "Codex sign-in expired — run codex login";
  if (status === 403) return "Codex transcription was refused";
  if (status === 429) return "Codex transcription is rate limited — try again shortly";
  return `Codex transcription failed (${status})`;
}
