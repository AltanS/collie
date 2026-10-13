// The Worker's bindings: wrangler.jsonc, `.dev.vars` under wrangler dev, `wrangler secret put` after a deploy.
import type { Member } from "./member.ts";

export interface Env {
  MEMBER: DurableObjectNamespace<Member>;
  /** The bearer token. A secret, at least 32 bytes. Unset or shorter: every request is refused. */
  COLLIE_TOKEN?: string;
  /**
   * The next bearer token, a secret, set only while a rotation runs. A request with either token is taken. When the
   * peer uses the new one, move it to COLLIE_TOKEN and unset this (README, "Rotate the token").
   */
  COLLIE_TOKEN_NEXT?: string;
  /** An OpenRouter model id. Unset: the scripted model. */
  REAL_MODEL?: string;
  /** Your OpenRouter key, a secret. Pi reads it (through process.env) only when REAL_MODEL is set. */
  OPENROUTER_API_KEY?: string;
  /** The pause before each scripted answer, in ms. Default 400. */
  DM_STEP_MS?: string;
  /** How long the scripted answer to a follow-up takes, in ms. Default 10000. */
  DM_SLOW_MS?: string;
  /** How long the helper's scripted answer takes, in ms. Default: DM_STEP_MS. */
  DM_HELPER_MS?: string;
  /** `memory` keeps Pi's conversations in memory, for `npm run test:memory`. Anything else: the Durable Object's SQLite. */
  DM_STORAGE?: string;
}
