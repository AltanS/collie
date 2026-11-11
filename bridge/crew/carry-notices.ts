import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import type { HillCollieSender, HillCollieVerdict, HillPostAnswer } from "../hill/service.ts";
import { tricksStateDir } from "../tricks/paths.ts";
import { TAKEOVER_NOTICES_FILE, type CarryFailure } from "./carry-adopt.ts";

// A CARRIED TRICK THAT DID NOT START IS SAID ON THE HILL (CREW_PROTOCOL §25). The takeover tap runs in a
// process that is still a peer, which cannot post; it leaves the failures in a file, and the next boot,
// as the lead, posts one Decision of Collie's own for each: the trick's name, the old lead, and why. It
// asks nothing: one button, OK, which closes it. A post that did not land stays in the file for the next
// boot while the Hill is off or full; the file goes once nothing is left to post.

/** The sender's name on the card, as on Collie's other cards. */
export const CARRIED_CARD_SENDER = "Collie";
/** The card's one option. */
export const CARRIED_OK = "ok";

const HASH_RE = /^[0-9a-f]{64}$/u;

/** What the file holds: the failures of one tap. */
export interface CarryNotices {
  readonly lead: string;
  readonly at: number;
  readonly failed: readonly CarryFailure[];
}

/** The notices file, or null when it is absent or does not read. */
export function parseCarryNotices(raw: string | null): CarryNotices | null {
  if (raw === null) return null;
  const doc = parseJsonObject(raw);
  const lead = asJsonString(doc?.lead);
  const at = asJsonNumber(doc?.at);
  const rows = doc?.failed;
  if (doc === undefined || asJsonNumber(doc.v) !== 1 || lead === undefined || lead === "" || at === undefined || !Array.isArray(rows)) return null;
  const failed: CarryFailure[] = [];
  for (const value of rows) {
    const row = asJsonObject(value);
    const id = asJsonString(row?.id);
    const name = asJsonString(row?.name);
    const hash = asJsonString(row?.hash);
    const reason = asJsonString(row?.reason);
    if (id === undefined || !isTrickId(id) || name === undefined || hash === undefined || !HASH_RE.test(hash) || reason === undefined) continue;
    failed.push(asJsonString(row?.kind) === "rights" ? { id, name, hash, reason, kind: "rights" } : { id, name, hash, reason });
  }
  return { lead, at, failed };
}

/** A stable request id per tap and trick, so a second boot posts the same card once. */
export function carriedRequestId(lead: string, at: number, failure: CarryFailure): string {
  const hex = createHash("sha256").update(`collie-carried-card\0${lead}\0${String(at)}\0${failure.id}\0${failure.hash}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The card for one trick that did not start, or that was left off for its rights (review 7 R6). */
export function carriedCard(lead: string, at: number, failure: CarryFailure): HillPostInput {
  if (failure.kind === "rights") {
    return {
      requestId: carriedRequestId(lead, at, failure),
      title: `The trick ${failure.name} is off after the takeover`,
      summary: `It ran on ${lead}, but the rights its code asks for are not the rights your lead says you approved. Collie left it off on this machine. Read its rights in Settings → Tricks before you switch it on.`,
      options: [{ intent: CARRIED_OK, label: "OK" }],
      text: "none",
    };
  }
  return {
    requestId: carriedRequestId(lead, at, failure),
    title: `The trick ${failure.name} did not start after the takeover`,
    summary: `It ran on ${lead}. Collie did not start it on this machine: ${failure.reason}. Switch it on again in Settings → Tricks when you want it here.`,
    options: [{ intent: CARRIED_OK, label: "OK" }],
    text: "none",
  };
}

/** The sender of the card about one trick. */
export function carriedSender(failure: CarryFailure): HillCollieSender {
  return { kind: "collie", ref: { type: "carried", id: failure.id, hash: failure.hash }, label: CARRIED_CARD_SENDER };
}

/** The answer to a card: OK closes it, and nothing else is an option. */
export function answerCarried(intent: string): HillCollieVerdict {
  return intent === CARRIED_OK ? { ok: true } : { ok: false, reason: "That is not an option of this card." };
}

export interface PostCarryNoticesOptions {
  readonly stateDir: string;
  readonly hill: { postCollie(from: HillCollieSender, input: HillPostInput): HillPostAnswer };
  readonly warn: (line: string) => void;
}

/** Post the notices a takeover left, once this machine leads. Answers how many are on the Hill now. Never throws. */
export async function postCarryNotices(opts: PostCarryNoticesOptions): Promise<number> {
  const path = join(tricksStateDir(opts.stateDir), TAKEOVER_NOTICES_FILE);
  const notices = parseCarryNotices(await readFile(path, "utf8").catch(() => null));
  if (notices === null) return 0;
  const left: CarryFailure[] = [];
  let posted = 0;
  for (const failure of notices.failed) {
    const answer = opts.hill.postCollie(carriedSender(failure), carriedCard(notices.lead, notices.at, failure));
    if (answer.ok) {
      posted += 1;
      continue;
    }
    // Only a Hill that is off or full may take it at a later boot; any other refusal never will.
    if (answer.code === "hill_off" || answer.code === "too_many_open") left.push(failure);
    opts.warn(`${failure.id}: the card that says it did not start after the takeover was not posted: ${answer.error}`);
  }
  try {
    if (left.length === 0) {
      await rm(path, { force: true });
      return posted;
    }
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ v: 1, lead: notices.lead, at: notices.at, failed: left }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    opts.warn(`the takeover notices could not be kept: ${err instanceof Error ? err.message : String(err)}`);
  }
  return posted;
}
