// The phone leg's HTTP hands (M56 spec 10, the phone leg): the calls the phone makes, with the
// headers the phone sends, read with the phone's own readers (web/src/lib/send-protocol.ts). Nothing
// here runs the Send Protocol in this process: every send goes to a bridge over HTTP, the way
// web/src/lib/api.ts sends it.
//
//   Authorization: Bearer <device token>     every request (reads need the token too, ADR 0086)
//   Origin: <the bridge's own origin>        a browser sends it on every POST; the bridge refuses a
//                                            write from a non-loopback Host without one
//   x-requested-with: XMLHttpRequest         api.ts sends it on every JSON request
//
// THE OWNED-PANE RULE. Against a running bridge (the dev lane) the leg may touch only the panes it
// made. Every call that names a pane checks the id against the panes this client created through
// `POST /api/workspace`, and throws before any request for any other id.

import { parseJson, asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../../../web/src/lib/json";
import { readAsk, readSendReceipts, readSendReply, readSurface, type SendReply } from "../../../web/src/lib/send-protocol";
import type { SendMode, SendReceiptRow } from "../../../web/src/lib/surface/send";
import type { Ask, Surface } from "../../../web/src/lib/surface/surface";

/** What the client hands its fetcher: the request's method, headers, body and deadline. */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type Fetcher = (url: string, init: FetchInit) => Promise<Response>;

/** The strings of a JSON list, in order; anything that is not a string is left out. */
function stringsOf(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asJsonString(entry);
    return text === undefined ? [] : [text];
  });
}

const REQUEST_TIMEOUT_MS = 30_000;

/** One pane of the snapshot, as much as the leg reads of it. */
export interface PhonePane {
  readonly paneId: string;
  /** `shell` for a pane with no agent; `claude` once the bridge names the agent. */
  readonly agent: string;
  readonly status: string;
  readonly surface: Surface | null;
  readonly hooks: string | null;
  readonly sendProtocol: boolean;
  /** The held sends the snapshot lists for the pane (M56 spec 15), by request id and state. */
  readonly held: readonly { readonly requestId: string; readonly state: string }[];
}

/** What `POST /api/send` answered: the phone's own reading, plus the receipt's line, keys and screen-word reason. */
export interface PhoneSendReply extends SendReply {
  readonly receiptDetail: string | null;
  readonly keys: readonly string[];
  /** The receipt's `saw.reason`: `no-profile` on a blind send to a pane with no profile (a shell). */
  readonly sawReason: string | null;
}

/** What `POST /api/ask/<id>` answered, as much as the leg reads of it. */
export interface PhoneAskReply {
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly keys: readonly string[];
  readonly detail: string | null;
  readonly ask: Ask | null;
}

export class PhoneHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PhoneHttpError";
  }
}

/** A request id the way the phone mints one: a UUID, fresh for every intent. */
export function mintRequestId(): string {
  return crypto.randomUUID();
}

export class PhoneClient {
  /** The panes this client made. The only panes it may name. */
  readonly owned = new Set<string>();
  private readonly origin: string;

  constructor(
    readonly base: string,
    private readonly token: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {
    this.origin = new URL(base).origin;
  }

  private headers() {
    return {
      authorization: `Bearer ${this.token}`,
      origin: this.origin,
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
    };
  }

  private mine(paneId: string): void {
    if (!this.owned.has(paneId)) throw new Error(`the phone leg refuses pane ${paneId}: it did not make it`);
  }

  private async call(method: string, path: string, body?: JsonValue): Promise<{ status: number; text: string; json: JsonValue | undefined }> {
    const init: FetchInit = { method, headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetcher(`${this.base}${path}`, init);
    const text = await res.text();
    return { status: res.status, text, json: parseJson(text) };
  }

  private async ok(method: string, path: string, body?: JsonValue): Promise<JsonValue | undefined> {
    const got = await this.call(method, path, body);
    if (got.status !== 200) throw new PhoneHttpError(got.status, `${method} ${path.split("?")[0] ?? path} answered ${String(got.status)}: ${got.text.slice(0, 200)}`);
    return got.json;
  }

  /** `GET /api/health`: true once the bridge answers. Needs no token. */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.base}/api/health`, { method: "GET", headers: {}, signal: AbortSignal.timeout(2000) });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** `GET /api/config`: the bridge's config body. The leg reads the operator's belt rows from it. */
  async config(): Promise<JsonValue | undefined> {
    return this.ok("GET", "/api/config");
  }

  /** `POST /api/workspace {cwd, label}`: a new space with one shell pane. The pane becomes this client's. */
  async createPane(cwd: string, label: string): Promise<string> {
    const node = asJsonObject(await this.ok("POST", "/api/workspace", { cwd, label }));
    const paneId = asJsonString(asJsonObject(node?.pane)?.paneId);
    if (node?.ok !== true || paneId === undefined) throw new Error(`POST /api/workspace made no pane: ${JSON.stringify(node ?? null).slice(0, 200)}`);
    this.owned.add(paneId);
    return paneId;
  }

  /** `POST /api/send`: one Send Protocol request. Every outcome is a 200 with the answer. */
  async send(body: { id: string; pane: string; text: string; mode: SendMode; rowsHash?: string | undefined; capAck?: boolean | undefined }): Promise<PhoneSendReply> {
    this.mine(body.pane);
    const payload: JsonObject = { id: body.id, pane: body.pane, text: body.text, mode: body.mode };
    if (body.rowsHash !== undefined) payload.rowsHash = body.rowsHash;
    if (body.capAck === true) payload.capAck = true;
    const json = await this.ok("POST", "/api/send", payload);
    const reply = readSendReply(json);
    if (reply === null) throw new Error(`POST /api/send answered a body the phone cannot read: ${JSON.stringify(json ?? null).slice(0, 200)}`);
    const receipt = asJsonObject(asJsonObject(json)?.receipt);
    const keys = stringsOf(receipt?.keys);
    return { ...reply, receiptDetail: asJsonString(receipt?.detail) ?? null, keys, sawReason: asJsonString(asJsonObject(receipt?.saw)?.reason) ?? null };
  }

  /**
   * A send the way the composer makes it: one request, and when the bridge answers `refused
   * unconfirmed` with a rows hash (a screen it cannot read, the first send to a fresh pane), the
   * commit tap as a new request with a new id and that hash. When the commit meets the cap (M56 spec
   * 09: too many sends past an unreadable screen in a day), the bridge asks to confirm once more, and
   * the leg taps once more with `capAck`, as the phone's sheet does. Returns every answer and the id of the last.
   */
  async sendAsPhone(pane: string, text: string, mode: SendMode): Promise<{ readonly id: string; readonly answers: readonly PhoneSendReply[] }> {
    let id = mintRequestId();
    const first = await this.send({ id, pane, text, mode });
    if (first.outcome !== "refused" || first.reason !== "unconfirmed" || first.rowsHash === null) return { id, answers: [first] };
    id = mintRequestId();
    const commit = await this.send({ id, pane, text, mode, rowsHash: first.rowsHash });
    if (commit.outcome !== "refused" || commit.reason !== "unconfirmed" || commit.cap === null || commit.rowsHash === null) return { id, answers: [first, commit] };
    id = mintRequestId();
    const again = await this.send({ id, pane, text, mode, rowsHash: commit.rowsHash, capAck: true });
    return { id, answers: [first, commit, again] };
  }

  /** `GET /api/send/receipts?pane=`: the last ten settled requests for the pane, newest first. */
  async receipts(pane: string): Promise<readonly SendReceiptRow[]> {
    this.mine(pane);
    return readSendReceipts(await this.ok("GET", `/api/send/receipts?pane=${encodeURIComponent(pane)}`)).receipts;
  }

  /** `GET /api/snapshot`, narrowed to one pane of this client's, from `agents[]` or `shellPanes[]`. Null when the bridge lists no such pane. */
  async pane(paneId: string): Promise<PhonePane | null> {
    this.mine(paneId);
    const snap = asJsonObject(await this.ok("GET", "/api/snapshot"));
    for (const list of [snap?.agents, snap?.shellPanes]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const node = asJsonObject(raw);
        if (node === undefined || node.paneId !== paneId) continue;
        const held = Array.isArray(node.held)
          ? node.held.flatMap((row) => {
              const entry = asJsonObject(row);
              const requestId = asJsonString(entry?.requestId);
              const state = asJsonString(entry?.state);
              return requestId === undefined || state === undefined ? [] : [{ requestId, state }];
            })
          : [];
        return {
          paneId,
          agent: asJsonString(node.agent) ?? "shell",
          status: asJsonString(node.status) ?? "unknown",
          surface: readSurface(node.surface),
          hooks: asJsonString(node.hooks) ?? null,
          sendProtocol: node.sendProtocol === true,
          held,
        };
      }
    }
    return null;
  }

  /** `POST /api/ask/<id>`: a tap on a dialog card, as the phone sends it. */
  async ask(askId: string, pane: string, hash: string, optionId: string): Promise<PhoneAskReply> {
    this.mine(pane);
    const node = asJsonObject(await this.ok("POST", `/api/ask/${encodeURIComponent(askId)}`, { pane, hash, optionId, origin: "person_tap" }));
    const receipt = asJsonObject(node?.receipt);
    const keys = stringsOf(receipt?.keys);
    return { outcome: asJsonString(receipt?.outcome) ?? null, reason: asJsonString(receipt?.reason) ?? null, keys, detail: asJsonString(node?.detail) ?? null, ask: readAsk(node?.ask) };
  }

  /**
   * `POST /api/pane/<id>/reply {text, submit: false}`: the phone's Type, text into the pane with no
   * Enter and no Send Protocol. The leg types `/` with it to read the slash menu.
   */
  async type(pane: string, text: string): Promise<boolean> {
    this.mine(pane);
    const node = asJsonObject(await this.ok("POST", `/api/pane/${encodeURIComponent(pane)}/reply`, { text, submit: false }));
    return node?.ok === true;
  }

  /** `POST /api/pane/<id>/keys {keys}`: the Keys board. True when the bridge pressed them. */
  async keys(pane: string, keys: readonly string[]): Promise<boolean> {
    this.mine(pane);
    const node = asJsonObject(await this.ok("POST", `/api/pane/${encodeURIComponent(pane)}/keys`, { keys: [...keys] }));
    return node?.ok === true;
  }

  /** `GET /api/pane/<id>`: the pane's text with its colours (ANSI), for a capture. */
  async text(pane: string): Promise<string> {
    this.mine(pane);
    return asJsonString(asJsonObject(await this.ok("GET", `/api/pane/${encodeURIComponent(pane)}`))?.text) ?? "";
  }

  /** `POST /api/pane/<id>/close`. The pane stops being this client's whatever the answer. */
  async close(pane: string): Promise<boolean> {
    this.mine(pane);
    try {
      const node = asJsonObject(await this.ok("POST", `/api/pane/${encodeURIComponent(pane)}/close`, {}));
      return node?.ok === true;
    } finally {
      this.owned.delete(pane);
    }
  }
}
