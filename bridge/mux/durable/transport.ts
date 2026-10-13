// WHICH TRANSPORT A DURABLE PEER USES, CHOSEN IN ONE PLACE (ADR 0103).
//
// Two ways reach a program: the private Unix socket (`COLLIE_DURABLE_SOCKET`, WIRE.md section 1A) or
// HTTPS with a bearer token (`COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN`, section 1B). Exactly
// one may be configured. The adapter factory, its boot line and `collie doctor` all read the choice
// from here, so the three can never disagree about which transport a peer has.
//
// A configuration that is wrong does not stop the bridge, as an unset socket path never did: the
// adapter gets a transport that dials nothing and answers every read with the one line that says
// what is wrong. That line is also the boot line, so `collie logs` shows it once at start.

import { HOST } from "../../host.ts";
import { DURABLE_SOCKET_ENV, DurableSocketClient, DurableUnreachable, resolveSocketPath, type DurableReply, type DurableTransport, type DurableTransportKind } from "./client.ts";
import { DURABLE_TOKEN_ENV, DURABLE_URL_ENV, DurableHttpClient, resolveDurableToken, resolveDurableUrl } from "./http-client.ts";

/** The one line a Windows peer shows when `COLLIE_DURABLE_SOCKET` is set. Boot line, adapter and doctor all print it. */
export const WINDOWS_NO_SOCKET = `the private socket transport is not available on Windows; set ${DURABLE_URL_ENV} and ${DURABLE_TOKEN_ENV} instead`;

/** The environment the choice reads. Only the three durable names are looked at. */
export type DurableEnv = Readonly<Record<string, string | undefined>>;

/**
 * What the environment configures. `https` carries the raw values, unchecked: the URL and token
 * rules run in {@link buildDurableTransport} and in doctor's own rows, so each can say which failed.
 */
export type DurableTransportChoice =
  | { readonly kind: "socket"; readonly configured: string | undefined }
  | { readonly kind: "https"; readonly url: string; readonly token: string }
  | { readonly kind: "conflict"; readonly detail: string; readonly windows?: true };

function present(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/**
 * Read the three variables (ADR 0103 point 1). The socket alone, or the URL and the token together:
 * anything else is a conflict with one line that names the variables. Nothing set at all is the
 * socket transport with no path, which reports `COLLIE_DURABLE_SOCKET is not set` as it always did.
 *
 * Windows has no socket transport (WIRE.md section 1A needs a Unix socket and its owner and mode
 * checks), so a socket path set there is a conflict that says what to set instead. `platform` is a
 * parameter so a test names the platform; it defaults to this process's.
 */
export function chooseDurableTransport(env: DurableEnv, platform: NodeJS.Platform = HOST.platform): DurableTransportChoice {
  const socket = env[DURABLE_SOCKET_ENV];
  const url = env[DURABLE_URL_ENV];
  const token = env[DURABLE_TOKEN_ENV];
  const hasSocket = present(socket);
  const hasUrl = present(url);
  const hasToken = present(token);
  if (hasSocket && platform === "win32") return { kind: "conflict", detail: WINDOWS_NO_SOCKET, windows: true };
  if (hasSocket && (hasUrl || hasToken)) {
    return {
      kind: "conflict",
      detail: `${DURABLE_SOCKET_ENV} and ${hasUrl ? DURABLE_URL_ENV : DURABLE_TOKEN_ENV} are both set; set the socket, or the URL with its token, not both`,
    };
  }
  if (hasUrl && !hasToken) return { kind: "conflict", detail: `${DURABLE_URL_ENV} is set without ${DURABLE_TOKEN_ENV}; the program refuses a caller with no token` };
  if (hasToken && !hasUrl) return { kind: "conflict", detail: `${DURABLE_TOKEN_ENV} is set without ${DURABLE_URL_ENV}; a token is only sent to a URL` };
  if (hasUrl) return { kind: "https", url: url ?? "", token: token ?? "" };
  return { kind: "socket", configured: socket };
}

/** A transport that dials nothing and answers every call with one fixed line. */
class MisconfiguredTransport implements DurableTransport {
  constructor(
    readonly kind: DurableTransportKind,
    private readonly detail: string,
  ) {}

  get(): Promise<DurableReply> {
    return Promise.reject(new DurableUnreachable(this.detail));
  }

  post(): Promise<DurableReply> {
    return Promise.reject(new DurableUnreachable(this.detail));
  }
}

/** The transport the adapter runs on, and the one line the boot log prints for it. */
export interface BuiltTransport {
  readonly transport: DurableTransport;
  /** Which transport, and where it points. Never the token. */
  readonly description: string;
}

/**
 * Build the transport a choice names. A choice that breaks a rule gets a transport that reports the
 * broken rule on every read, and a description that says the same, so the boot line and the
 * peer's `unreachable` detail are one sentence.
 */
export function buildDurableTransport(choice: DurableTransportChoice): BuiltTransport {
  if (choice.kind === "conflict") {
    return { transport: new MisconfiguredTransport("socket", choice.detail), description: `not started: ${choice.detail}` };
  }
  if (choice.kind === "socket") {
    const resolved = resolveSocketPath(choice.configured);
    return {
      transport: new DurableSocketClient(choice.configured),
      description: resolved.ok ? `private socket ${resolved.path}` : resolved.detail,
    };
  }
  const url = resolveDurableUrl(choice.url);
  if (!url.ok) return { transport: new MisconfiguredTransport("https", url.detail), description: `not started: ${url.detail}` };
  const token = resolveDurableToken(choice.token);
  if (!token.ok) return { transport: new MisconfiguredTransport("https", token.detail), description: `not started: ${token.detail}` };
  const how = url.loopback ? "loopback http (wrangler dev)" : "https";
  return {
    transport: new DurableHttpClient(url.base, token.reveal()),
    description: `${how} ${url.base} with a bearer token (${String(token.bytes)} bytes)`,
  };
}
