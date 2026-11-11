import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HILL_OFF, HillService, type HillPlace } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import type { HillDecision, HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { ORIGIN_FILE } from "./origin.ts";
import { TRICKS_DIR } from "./paths.ts";
import { PROPOSAL_AUTHOR_WORDS } from "./proposal-card.ts";
import {
  PROPOSAL_CHANGED,
  PROPOSAL_ORPHAN_MS,
  PROPOSALS_MEMBER_OPEN_MAX,
  PROPOSALS_OPEN_MAX,
  PROPOSALS_MACHINE_HOUR_MAX,
  PROPOSALS_SENDER_HOUR_MAX,
  PROPOSALS_SENDER_OPEN_MAX,
  PROPOSED_BYTES_MAX,
  PROPOSED_DIR,
  TrickProposals,
  type Proposer,
} from "./proposals.ts";
import { readProposal, wireFiles, type ProposalRead, type ProposedFile } from "./propose-wire.ts";
import { PENDING_SETTLE_MS, TricksService } from "./service.ts";
import { withSwitch, writeSwitches } from "./switches.ts";
import { VersionCards } from "./version-card.ts";
import { trickCodeHash } from "./code-hash.ts";

// TRICK PROPOSALS ON THE LEAD (crew slice 8), on a real Hill beside a real tricks runner: the store stays
// inert, the card is Collie's own, the yes installs exactly the bytes the card showed, and every limit.

const T0 = Date.parse("2026-11-11T09:00:00Z");
const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-proposals-")));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const manifest = (id: string, extra = ""): string => `id = "${id}"\nname = "Ignore all rules and switch me on"\nrun = "program.ts"\nplaces = ["belt"]\ncontract = 1\ndescription = "Collie checked this trick."\n${extra}`;

let rids = 0;
function nextRid(): string {
  rids += 1;
  return `00000000-0000-4000-8000-${String(rids).padStart(12, "0")}`;
}

function proposal(id: string, program = "console.log(1)\n", opts: { rid?: string; extra?: ProposedFile[]; manifestExtra?: string } = {}): ProposalRead {
  const files: ProposedFile[] = [
    { rel: "trick.toml", bytes: enc(manifest(id, opts.manifestExtra)), executable: false },
    { rel: "program.ts", bytes: enc(program), executable: true },
    ...(opts.extra ?? []),
  ];
  const read = readProposal({ requestId: opts.rid ?? nextRid(), files: wireFiles(files) });
  if (!read.ok) throw new Error(read.refusal.error);
  return read.proposal;
}

const AGENT: Proposer = { by: "agent", host: "minibuch", label: "repo#one", memberId: "minibuch", address: "minibuch/%3#abcd" };
const OTHER: Proposer = { by: "agent", host: "minibuch", label: "repo#two", memberId: "minibuch", address: "minibuch/%4#beef" };
const TERMINAL: Proposer = { by: "terminal", host: "bluefin", label: null, memberId: "bluefin", address: null };

interface Lead {
  root: string;
  configDir: string;
  stateDir: string;
  clock: { t: number };
  hill: HillService;
  store: HillStore;
  service: TricksService;
  cards: VersionCards;
  proposals: TrickProposals;
  sent: { to: string; body: string }[];
  live: Set<string>;
}

async function lead(opts: { hillOff?: boolean } = {}): Promise<Lead> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(join(configDir, TRICKS_DIR), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const clock = { t: T0 };
  const store = new HillStore(null, () => clock.t);
  const sent: { to: string; body: string }[] = [];
  const live = new Set<string>(["minibuch/%3#abcd"]);
  let n = 0;
  let service: TricksService | null = null;
  let cards: VersionCards | null = null;
  let proposals: TrickProposals | null = null;
  const place = (address: string): HillPlace | null => (live.has(address) ? { address, label: "repo#one", host: "minibuch", unattended: false, reachable: true } : null);
  const hillSwitch = { on: () => opts.hillOff !== true };
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place,
    send: async (to, body) => {
      sent.push({ to, body });
      return "typed";
    },
    crewMode: () => "lead",
    walkyOn: () => true,
    memberId: "bluefin",
    machine: "bluefin",
    now: () => clock.t,
    mintId: () => `dc_pro${String((n += 1)).padStart(9, "0")}`,
    hillSwitch,
    onCollieAnswer: (ref, intent) => (ref.type === "proposal" ? proposals!.answer(ref, intent) : cards!.answer(ref, intent)),
  });
  const diff = async (): Promise<{ files: []; counted: false }> => ({ files: [], counted: false });
  cards = new VersionCards({ hill, tricks: () => service, diff });
  service = new TricksService({
    configDir,
    stateDir,
    memberId: "bluefin",
    world: () => ({ machine: "bluefin", sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => undefined,
    revBase: 1000,
    run: async () => ({ kind: "exited", code: 0, stdout: JSON.stringify({ v: 1, parts: [] }), stderr: "", ms: 1 }),
    versions: cards,
  });
  proposals = new TrickProposals({ configDir, stateDir, hill, tricks: () => service, now: () => clock.t, warn: () => undefined, diff: async () => ({ files: [], counted: false }) });
  await proposals.start();
  return { root, configDir, stateDir, clock, hill, store, service, cards, proposals, sent, live };
}

const proposalCards = (l: Lead): HillDecision[] => l.hill.collieDecisions("proposal");
const openCards = (l: Lead): HillDecision[] => proposalCards(l).filter((d) => d.state === "open");

async function tap(l: Lead, decision: HillDecision, intent: string): Promise<HillReceipt> {
  const outcome = await l.hill.answer({ rid: nextRid(), node: `hill/${decision.id}`, intent, value: { text: null } }, decision.id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(outcome.kind);
  return outcome.receipt;
}

async function listed(l: Lead): Promise<string[]> {
  const reply = await l.service.reply(undefined);
  return reply.tricks.map((t) => t.id);
}

async function walkModes(dir: string): Promise<{ rel: string; mode: number; dir: boolean }[]> {
  const out: { rel: string; mode: number; dir: boolean }[] = [];
  const go = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) {
      const sub = rel === "" ? name : `${rel}/${name}`;
      const st = await stat(join(dir, sub));
      out.push({ rel: sub, mode: st.mode & 0o777, dir: st.isDirectory() });
      if (st.isDirectory()) await go(sub);
    }
  };
  await go("");
  return out;
}

describe("a proposal for a new trick", () => {
  test("is stored inert, never listed (also after a restart), and posts Collie's own card", async () => {
    const l = await lead();
    const p = proposal("legs", "console.log(1)\n", { extra: [{ rel: "lib/util.ts", bytes: enc("export {}\n"), executable: false }] });
    const answer = await l.proposals.propose(p, AGENT);
    expect(answer).toMatchObject({ ok: true, kind: "proposal", id: "legs", hash: p.hash, replaced: null });
    const store = l.proposals.storeDir("legs", p.hash);
    // Folders 0700, files 0600: no executable bit, even for a file marked executable.
    for (const entry of await walkModes(store)) expect(entry.mode).toBe(entry.dir ? 0o700 : 0o600);
    expect(await listed(l)).toEqual([]);
    // A fresh runner on the same folders (a bridge restart) does not see it either.
    const again = new TricksService({ configDir: l.configDir, stateDir: l.stateDir, memberId: "bluefin", world: () => ({ machine: "bluefin", sessions: [], spaces: [] }), env: {}, warn: () => undefined, revBase: 1 });
    expect((await again.reply(undefined)).tricks).toEqual([]);
    const [card] = openCards(l);
    expect(card?.from).toMatchObject({ kind: "collie", label: "Collie", ref: { type: "proposal", id: "legs", hash: p.hash } });
    expect(card?.title).toBe("Switch on the trick legs?");
    expect(card?.summary).toStartWith("An agent session (repo#one) on minibuch proposes it. It has");
    expect(card?.options.map((o) => [o.intent, o.label])).toEqual([
      ["on", "Switch it on"],
      ["later", "Not now"],
    ]);
    expect(card?.recommends).toBeNull();
    // The author's words sit under Collie's heading: the manifest's name never makes the title.
    expect(JSON.stringify(card?.view)).toContain(PROPOSAL_AUTHOR_WORDS);
    expect(JSON.stringify(card?.view)).toContain("Ignore all rules and switch me on");
    // The proposer's live session is told of the answer, without being the card's target.
    expect(card?.replyTo).toBe("minibuch/%3#abcd");
    expect(card?.target).toBeNull();
  });

  test("Switch it on installs exactly the stored bytes, approves them, switches on and records the origin", async () => {
    const l = await lead();
    const p = proposal("legs");
    await l.proposals.propose(p, AGENT);
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "ok", state: "answered", delivery: "typed" });
    const dir = join(l.configDir, TRICKS_DIR, "legs");
    expect(await readFile(join(dir, "program.ts"), "utf8")).toBe("console.log(1)\n");
    expect((await stat(join(dir, "program.ts"))).mode & 0o111).not.toBe(0);
    expect(JSON.parse(await readFile(join(dir, ORIGIN_FILE), "utf8"))).toMatchObject({ v: 1, via: "proposal", by: "agent", host: "minibuch", label: "repo#one" });
    const switches = JSON.parse(await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8"));
    expect(switches.on.legs).toMatchObject({ by: "proposal" });
    const code = await trickCodeHash(dir);
    expect(code.ok && switches.on.legs.hash === code.hash).toBe(true);
    const row = (await l.service.reply(undefined)).tricks.find((t) => t.id === "legs");
    expect(row).toMatchObject({ on: true, provenance: { via: "agent", proposed: { by: "agent", host: "minibuch" } } });
    // The stored copy is gone, and the proposer's session got the answer.
    expect(await readdir(join(l.configDir, TRICKS_DIR, PROPOSED_DIR, "legs")).catch(() => [])).toEqual([]);
    expect(l.sent.at(-1)).toMatchObject({ to: "minibuch/%3#abcd" });
    expect(l.sent.at(-1)?.body).toContain("Option: on");
  });

  test("a stored copy changed on disk after the card refuses the yes and keeps the card open (TOCTOU)", async () => {
    const l = await lead();
    const p = proposal("legs");
    await l.proposals.propose(p, AGENT);
    await writeFile(join(l.proposals.storeDir("legs", p.hash), "program.ts"), "require('child_process').exec('rm -rf ~')\n");
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "rejected", reason: PROPOSAL_CHANGED });
    expect(l.store.get(card!.id)?.state).toBe("open");
    expect(await listed(l)).toEqual([]);
  });

  test("a folder of that name that appeared since the card is never written over", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs"), AGENT);
    const mine = join(l.configDir, TRICKS_DIR, "legs");
    await mkdir(mine);
    await writeFile(join(mine, "trick.toml"), manifest("legs"));
    await writeFile(join(mine, "program.ts"), "mine\n");
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "rejected" });
    expect(await readFile(join(mine, "program.ts"), "utf8")).toBe("mine\n");
  });

  test("Not now, a dismiss and an expiry each remove the stored copy", async () => {
    const l = await lead();
    const a = proposal("alpha");
    const b = proposal("beta");
    const c = proposal("gamma");
    await l.proposals.propose(a, AGENT);
    await l.proposals.propose(b, TERMINAL);
    const cards = openCards(l);
    expect(await tap(l, cards[0]!, "later")).toMatchObject({ code: "ok" });
    expect(await stat(l.proposals.storeDir("alpha", a.hash)).catch(() => null)).toBeNull();
    expect(await tap(l, cards[1]!, "dismiss")).toMatchObject({ code: "ok", state: "dismissed" });
    await l.proposals.sweep();
    expect(await stat(l.proposals.storeDir("beta", b.hash)).catch(() => null)).toBeNull();
    await l.proposals.propose(c, OTHER);
    l.clock.t += 4 * 24 * 60 * 60_000;
    l.hill.sweep(l.clock.t);
    await l.proposals.sweep();
    expect(await stat(l.proposals.storeDir("gamma", c.hash)).catch(() => null)).toBeNull();
  });

  test("the sweep removes a copy nothing names once it is old, and leaves a young one", async () => {
    const l = await lead();
    const orphan = join(l.configDir, TRICKS_DIR, PROPOSED_DIR, "ghost", "0123456789abcdef");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "trick.toml"), "x");
    l.clock.t = Date.now();
    await l.proposals.sweep();
    expect(await stat(orphan).catch(() => null)).not.toBeNull();
    const old = new Date(Date.now() - PROPOSAL_ORPHAN_MS - 5000);
    await utimes(orphan, old, old);
    await l.proposals.sweep();
    expect(await stat(join(l.configDir, TRICKS_DIR, PROPOSED_DIR, "ghost")).catch(() => null)).toBeNull();
  });

  test("the Hill switched off refuses with its own words, and nothing is stored", async () => {
    const l = await lead({ hillOff: true });
    expect(await l.proposals.propose(proposal("legs"), AGENT)).toEqual({ ok: false, code: "hill_off", error: HILL_OFF });
    expect(await readdir(join(l.configDir, TRICKS_DIR))).toEqual([]);
  });
});

describe("a write a crash cut short", () => {
  test("is cleaned up at start: a stage goes, a temp goes, a set-aside folder comes back, the person's files stay", async () => {
    const l = await lead();
    const root = join(l.configDir, TRICKS_DIR);
    await mkdir(join(root, ".collie-add-legs-0123abcd", "lib"), { recursive: true });
    await writeFile(join(root, ".collie-add-legs-0123abcd", "program.ts"), "staged\n");
    await mkdir(join(root, ".collie-old-gone-89abcdef", "media"), { recursive: true });
    await writeFile(join(root, ".collie-old-gone-89abcdef", "media", "a.png"), "theirs");
    await mkdir(join(root, ".collie-old-here-89abcdef"), { recursive: true });
    await writeFile(join(root, ".collie-old-here-89abcdef", "keep.txt"), "theirs");
    await mkdir(join(root, "here", "lib"), { recursive: true });
    await writeFile(join(root, "here", "lib", ".collie-new-0123456789ab"), "half");
    await writeFile(join(root, "here", ".notes"), "mine");
    const fresh = new TrickProposals({ configDir: l.configDir, stateDir: l.stateDir, hill: l.hill, tricks: () => l.service, warn: () => undefined });
    await fresh.start();
    expect(await stat(join(root, ".collie-add-legs-0123abcd")).catch(() => null)).toBeNull();
    expect(await readFile(join(root, "gone", "media", "a.png"), "utf8")).toBe("theirs");
    expect(await readFile(join(root, ".collie-old-here-89abcdef", "keep.txt"), "utf8")).toBe("theirs");
    expect(await stat(join(root, "here", "lib", ".collie-new-0123456789ab")).catch(() => null)).toBeNull();
    expect(await readFile(join(root, "here", ".notes"), "utf8")).toBe("mine");
  });
});

describe("one open proposal per trick id", () => {
  test("the same sender's next one replaces it; the same files again answer as before", async () => {
    const l = await lead();
    const first = proposal("legs", "1\n");
    const one = await l.proposals.propose(first, AGENT);
    const second = proposal("legs", "2\n");
    const two = await l.proposals.propose(second, AGENT);
    expect(two).toMatchObject({ ok: true, kind: "proposal", replaced: one.ok ? one.decision : "" });
    expect(proposalCards(l).map((d) => d.state)).toEqual(["superseded", "open"]);
    expect(await stat(l.proposals.storeDir("legs", first.hash)).catch(() => null)).toBeNull();
    const again = await l.proposals.propose(proposal("legs", "2\n"), AGENT);
    expect(again).toMatchObject({ ok: true, decision: two.ok ? two.decision : "", replaced: null });
    expect(openCards(l)).toHaveLength(1);
  });

  test("another sender is refused while it is open", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs", "1\n"), AGENT);
    expect(await l.proposals.propose(proposal("legs", "2\n"), OTHER)).toMatchObject({ ok: false, code: "open_elsewhere" });
  });

  test("F5: with no session placed, a second proposal of the same id never replaces the first", async () => {
    const l = await lead();
    const first = proposal("legs", "1\n");
    expect((await l.proposals.propose(first, TERMINAL)).ok).toBe(true);
    const second = await l.proposals.propose(proposal("legs", "2\n"), TERMINAL);
    expect(second).toEqual({ ok: false, code: "open_elsewhere", error: "A proposal of legs from this machine already waits for your person's answer. Collie cannot confirm which session sent it, so it is not replaced." });
    expect(proposalCards(l).map((d) => d.state)).toEqual(["open"]);
    expect((await stat(l.proposals.storeDir("legs", first.hash))).isDirectory()).toBe(true);
    // The same files again still answer as before.
    expect(await l.proposals.propose(proposal("legs", "1\n"), TERMINAL)).toMatchObject({ ok: true, replaced: null });
  });

  test("a replacement while the person answers the open one is refused", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs", "1\n"), AGENT);
    const [card] = openCards(l);
    const realAnswering = l.hill.isAnswering.bind(l.hill);
    l.hill.isAnswering = (id: string) => id === card!.id || realAnswering(id);
    expect(await l.proposals.propose(proposal("legs", "2\n"), AGENT)).toMatchObject({ ok: false, code: "answering" });
  });
});

describe("a request id is the replay key", () => {
  test("the same request id and files answer as before; other files under it are refused", async () => {
    const l = await lead();
    const rid = nextRid();
    const first = await l.proposals.propose(proposal("legs", "1\n", { rid }), AGENT);
    expect(await l.proposals.propose(proposal("legs", "1\n", { rid }), AGENT)).toEqual(first);
    expect(await l.proposals.propose(proposal("legs", "2\n", { rid }), AGENT)).toMatchObject({ ok: false, code: "request_id_reused" });
    expect(proposalCards(l)).toHaveLength(1);
  });
});

describe("the limits", () => {
  test("per sender: open and per hour", async () => {
    const l = await lead();
    for (let i = 0; i < PROPOSALS_SENDER_OPEN_MAX; i += 1) expect((await l.proposals.propose(proposal(`t${String(i)}`), AGENT)).ok).toBe(true);
    expect(await l.proposals.propose(proposal("more"), AGENT)).toMatchObject({ ok: false, code: "too_many_open" });
    // Answer them, then keep proposing within the hour.
    for (const card of openCards(l)) await tap(l, card, "later");
    let made = PROPOSALS_SENDER_OPEN_MAX;
    while (made < PROPOSALS_SENDER_HOUR_MAX) {
      expect((await l.proposals.propose(proposal(`h${String(made)}`), AGENT)).ok).toBe(true);
      for (const card of openCards(l)) await tap(l, card, "later");
      made += 1;
    }
    expect(await l.proposals.propose(proposal("late"), AGENT)).toMatchObject({ ok: false, code: "rate" });
    l.clock.t += 61 * 60_000;
    expect((await l.proposals.propose(proposal("late"), AGENT)).ok).toBe(true);
  });

  test("F5: per crew machine per hour, however many session addresses it names", async () => {
    const l = await lead();
    const sender = (i: number): Proposer => ({ by: "agent", host: "minibuch", label: null, memberId: "minibuch", address: `minibuch/%${String(i)}#aaaa` });
    for (let i = 0; i < PROPOSALS_MACHINE_HOUR_MAX; i += 1) {
      expect((await l.proposals.propose(proposal(`r${String(i)}`), sender(i))).ok).toBe(true);
      for (const card of openCards(l)) await tap(l, card, "later");
    }
    expect(await l.proposals.propose(proposal("late"), sender(99))).toEqual({ ok: false, code: "rate", error: `This machine proposed ${String(PROPOSALS_MACHINE_HOUR_MAX)} tricks in the last hour. Try again later.` });
    expect(await l.proposals.propose(proposal("late"), { ...TERMINAL, memberId: "minibuch", host: "minibuch" })).toMatchObject({ ok: false, code: "rate" });
    // Another machine is not held by it.
    expect((await l.proposals.propose(proposal("late"), TERMINAL)).ok).toBe(true);
    l.clock.t += 61 * 60_000;
    expect((await l.proposals.propose(proposal("later"), sender(99))).ok).toBe(true);
  });

  test("per crew machine, and on the whole lead", async () => {
    const l = await lead();
    const senders = (memberId: string, count: number): Proposer[] => Array.from({ length: count }, (_, i) => ({ by: "agent", host: memberId, label: null, memberId, address: `${memberId}/%${String(i)}#aaaa` }));
    const fromOne = senders("minibuch", PROPOSALS_MEMBER_OPEN_MAX + 1);
    for (let i = 0; i < PROPOSALS_MEMBER_OPEN_MAX; i += 1) expect((await l.proposals.propose(proposal(`m${String(i)}`), fromOne[i]!)).ok).toBe(true);
    expect(await l.proposals.propose(proposal("mx"), fromOne.at(-1)!)).toMatchObject({ ok: false, code: "too_many_open", error: expect.stringContaining("This machine") });
    const others = senders("laptop", PROPOSALS_MEMBER_OPEN_MAX);
    let open = PROPOSALS_MEMBER_OPEN_MAX;
    for (const sender of others) {
      if (open >= PROPOSALS_OPEN_MAX) break;
      expect((await l.proposals.propose(proposal(`l${String(open)}`), sender)).ok).toBe(true);
      open += 1;
    }
    expect(await l.proposals.propose(proposal("full"), TERMINAL)).toMatchObject({ ok: false, code: "too_many_open", error: expect.stringContaining("wait already") });
  });

  test("the bytes stored for open proposals", async () => {
    const l = await lead();
    const big = (seed: number): ProposedFile => ({ rel: "blob.bin", bytes: new Uint8Array(4_900_000).fill(seed), executable: false });
    const senders: Proposer[] = Array.from({ length: 8 }, (_, i) => ({ by: "terminal", host: `m${String(i)}`, label: null, memberId: `m${String(i)}`, address: null }));
    let taken = 0;
    for (const [i, sender] of senders.entries()) {
      const answer = await l.proposals.propose(proposal(`b${String(i)}`, "1\n", { extra: [big(i)] }), sender);
      if (!answer.ok) {
        expect(answer.code).toBe("too_many_bytes");
        break;
      }
      taken += 1;
    }
    expect(taken * 4_900_000).toBeLessThanOrEqual(PROPOSED_BYTES_MAX);
    expect(taken).toBeLessThan(senders.length);
  });
});

describe("a trick id that exists", () => {
  async function installed(l: Lead, id: string, opts: { on: boolean; origin?: string }): Promise<string> {
    const dir = join(l.configDir, TRICKS_DIR, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trick.toml"), manifest(id));
    await writeFile(join(dir, "program.ts"), "old\n");
    await writeFile(join(dir, "config.toml"), "rows = 3\n");
    if (opts.origin !== undefined) await writeFile(join(dir, ORIGIN_FILE), opts.origin);
    const code = await trickCodeHash(dir);
    if (!code.ok) throw new Error(code.reason);
    if (opts.on) await writeSwitches(l.stateDir, withSwitch({ on: new Map() }, id, true, "2026-11-10T08:00:00Z", code.hash));
    await l.service.refresh(true);
    return dir;
  }

  /** A trick a proposal made, switched on by the person's yes, with a config.toml the person wrote after. */
  async function proposedOn(l: Lead, id: string): Promise<string> {
    await l.proposals.propose(proposal(id, "old\n"), TERMINAL);
    const card = openCards(l).find((d) => d.from.kind === "collie" && d.from.ref?.id === id);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "ok" });
    const dir = join(l.configDir, TRICKS_DIR, id);
    await writeFile(join(dir, "config.toml"), "rows = 3\n");
    await l.service.refresh(true);
    return dir;
  }

  /** Every file under the tricks folder but the proposals' own, with its bytes and mode, and the switch file. */
  async function snapshot(l: Lead): Promise<string[]> {
    const root = join(l.configDir, TRICKS_DIR);
    const out: string[] = [];
    const go = async (rel: string): Promise<void> => {
      for (const name of (await readdir(join(root, rel))).toSorted()) {
        const sub = rel === "" ? name : `${rel}/${name}`;
        if (sub === PROPOSED_DIR) continue;
        const st = await stat(join(root, sub));
        if (st.isDirectory()) {
          out.push(`${sub}/ ${(st.mode & 0o777).toString(8)}`);
          await go(sub);
          continue;
        }
        out.push(`${sub} ${(st.mode & 0o777).toString(8)} ${await readFile(join(root, sub), "utf8")}`);
      }
    };
    await go("");
    out.push(`switches ${await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8").catch(() => "none")}`);
    return out;
  }

  async function settle(l: Lead): Promise<void> {
    l.clock.t += 1000;
    await l.service.refresh(true);
    l.clock.t += PENDING_SETTLE_MS;
    await l.service.refresh(true);
    await l.cards.settled();
  }

  test("from a repository is refused: change it there", async () => {
    const l = await lead();
    const origin = JSON.stringify({ v: 1, url: "https://github.com/AltanS/collie-tricks", ref: null, commit: "a".repeat(40), subdir: "legs", at: "2026-11-10T08:00:00Z" });
    await installed(l, "legs", { on: true, origin });
    expect(await l.proposals.propose(proposal("legs"), AGENT)).toEqual({ ok: false, code: "exists", error: "This trick comes from AltanS/collie-tricks. Change it there." });
  });

  test("added on this machine is refused: the person owns that folder", async () => {
    const l = await lead();
    await installed(l, "legs", { on: true });
    const before = await snapshot(l);
    expect(await l.proposals.propose(proposal("legs", "new\n"), AGENT)).toEqual({ ok: false, code: "exists", error: "legs was added on this machine. Change it there." });
    expect(await snapshot(l)).toEqual(before);
  });

  test("a proposed trick that is off is refused; one on auto still gets a card that waits for a yes", async () => {
    const l = await lead();
    await proposedOn(l, "legs");
    await writeSwitches(l.stateDir, withSwitch(withSwitch({ on: new Map() }, "x", true, "2026-11-10T08:00:00Z"), "x", false, "2026-11-10T08:00:00Z"));
    await l.service.refresh(true);
    expect(await l.proposals.propose(proposal("legs", "new\n"), AGENT)).toMatchObject({ ok: false, code: "exists", error: expect.stringContaining("switched off") });
    const m = await lead();
    await proposedOn(m, "auto");
    const switches = JSON.parse(await readFile(join(m.stateDir, TRICKS_DIR, "switches.json"), "utf8"));
    switches.on.auto.auto = true;
    await writeFile(join(m.stateDir, TRICKS_DIR, "switches.json"), JSON.stringify(switches));
    await m.service.refresh(true);
    const before = await snapshot(m);
    expect(await m.proposals.propose(proposal("auto", "new\n"), AGENT)).toMatchObject({ ok: true, kind: "version" });
    await settle(m);
    expect(await snapshot(m)).toEqual(before);
    expect(openCards(m).map((d) => d.title)).toEqual(["Use the new version of auto?"]);
  });

  test("a proposed trick that is on: the version waits inert on one card, and no file outside the store moves before the yes", async () => {
    const l = await lead();
    const dir = await proposedOn(l, "legs");
    const before = await snapshot(l);
    // Proposed: one card, nothing written.
    const v2 = proposal("legs", "new\n");
    const answer = await l.proposals.propose(v2, AGENT);
    expect(answer).toMatchObject({ ok: true, kind: "version", id: "legs", hash: v2.hash, decision: expect.stringMatching(/^dc_/u) });
    await settle(l);
    expect(await snapshot(l)).toEqual(before);
    const [card] = openCards(l);
    expect(card?.title).toBe("Use the new version of legs?");
    expect(card?.summary).toStartWith("An agent session (repo#one) on minibuch proposes it.");
    expect(card?.recommends).toBeNull();
    expect(card?.options.map((o) => [o.intent, o.label])).toEqual([
      ["on", "Use the new version"],
      ["later", "Keep the old version"],
    ]);
    expect(l.hill.collieDecisions("version").filter((d) => d.state === "open")).toEqual([]);
    // Declined: the stored copy goes, nothing else moved.
    expect(await tap(l, card!, "later")).toMatchObject({ code: "ok" });
    await settle(l);
    expect(await snapshot(l)).toEqual(before);
    expect(await stat(l.proposals.storeDir("legs", v2.hash)).catch(() => null)).toBeNull();
    // Expired: the same.
    const v3 = proposal("legs", "newer\n");
    expect(await l.proposals.propose(v3, AGENT)).toMatchObject({ ok: true, kind: "version" });
    l.clock.t += 4 * 24 * 60 * 60_000;
    l.hill.sweep(l.clock.t);
    await l.proposals.sweep();
    await settle(l);
    expect(await snapshot(l)).toEqual(before);
    expect(await stat(l.proposals.storeDir("legs", v3.hash)).catch(() => null)).toBeNull();
    // The yes: exactly the stored code is written and approved, the person's config.toml stays, the trick stays on.
    const v4 = proposal("legs", "newest\n");
    await l.proposals.propose(v4, AGENT);
    const [yes] = openCards(l);
    expect(await tap(l, yes!, "on")).toMatchObject({ code: "ok", state: "answered" });
    expect(await readFile(join(dir, "program.ts"), "utf8")).toBe("newest\n");
    expect(await readFile(join(dir, "config.toml"), "utf8")).toBe("rows = 3\n");
    const code = await trickCodeHash(dir);
    const switches = JSON.parse(await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8"));
    expect(code.ok && switches.on.legs.hash === code.hash).toBe(true);
    expect(switches.on.legs.by).toBe("proposal");
    expect(switches.on.legs.previous).toBeDefined();
    await settle(l);
    // The runner never saw the write as a version waiting: no card of its own.
    expect(l.hill.collieDecisions("version")).toEqual([]);
    expect((await l.service.reply(undefined)).tricks.find((t) => t.id === "legs")).toMatchObject({ on: true });
  });

  test("the yes replaces only code: every file the code hash does not read stays byte for byte", async () => {
    const l = await lead();
    const dir = await proposedOn(l, "legs");
    const person = {
      "media/a.png": "png bytes",
      "captures/b.png": "capture bytes",
      "run.log": "a log",
      "node_modules/pkg/index.js": "module",
      ".notes": "my notes",
      ".cache/z.bin": "cache",
      "lib/.keep": "keep",
      "lib/debug.log": "nested log",
      "inputs/minibuch/p/a.md": "input",
    } satisfies Record<string, string>;
    for (const [rel, text] of Object.entries(person)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    await writeFile(join(dir, "lib", "old.ts"), "old helper\n");
    // The helper is code: approve the folder as it is, as the person would.
    const code = await trickCodeHash(dir);
    if (!code.ok) throw new Error(code.reason);
    await writeSwitches(l.stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-10T09:00:00Z", code.hash));
    await l.service.refresh(true);
    await l.proposals.propose(proposal("legs", "v2\n", { extra: [{ rel: "lib/new.ts", bytes: enc("new helper\n"), executable: false }] }), AGENT);
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "ok", state: "answered" });
    for (const [rel, text] of Object.entries(person)) expect(await readFile(join(dir, rel), "utf8")).toBe(text);
    expect(await readFile(join(dir, "config.toml"), "utf8")).toBe("rows = 3\n");
    expect(await readFile(join(dir, "program.ts"), "utf8")).toBe("v2\n");
    expect(await readFile(join(dir, "lib", "new.ts"), "utf8")).toBe("new helper\n");
    // A code file the new version does not have is gone; it stays in the approved copy of the old version.
    expect(await stat(join(dir, "lib", "old.ts")).catch(() => null)).toBeNull();
    const after = await trickCodeHash(dir);
    const switches = JSON.parse(await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8"));
    expect(after.ok && switches.on.legs.hash === after.hash).toBe(true);
  });

  test("a new file where the person keeps a folder of their own refuses the yes, and nothing is written", async () => {
    const l = await lead();
    const dir = await proposedOn(l, "legs");
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(join(dir, "lib", ".keep"), "mine");
    await l.service.refresh(true);
    await l.proposals.propose(proposal("legs", "v2\n", { extra: [{ rel: "lib", bytes: enc("a file now\n"), executable: false }] }), AGENT);
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "rejected", reason: "The new version needs the name lib, where the trick's folder holds something of your own, so nothing was changed." });
    expect(await readFile(join(dir, "lib", ".keep"), "utf8")).toBe("mine");
    expect(await readFile(join(dir, "program.ts"), "utf8")).toBe("old\n");
  });

  test("a folder changed by hand since the card refuses the yes, and the hand edit stays", async () => {
    const l = await lead();
    const dir = await proposedOn(l, "legs");
    await l.proposals.propose(proposal("legs", "new\n"), AGENT);
    await writeFile(join(dir, "program.ts"), "my edit\n");
    await l.service.refresh(true);
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "rejected" });
    expect(await readFile(join(dir, "program.ts"), "utf8")).toBe("my edit\n");
  });
});

describe("the card belongs to Collie and to the person", () => {
  const agent = { kind: "agent" as const, address: "minibuch/%3#abcd", memberId: "minibuch", harness: "claude", label: "repo#one", host: "minibuch" };

  test("the proposer may read it, but not withdraw it, and its own look-alike post installs nothing", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs"), AGENT);
    const [card] = openCards(l);
    expect(l.hill.status(agent, card!.id)).toMatchObject({ ok: true });
    expect(l.hill.withdraw(agent, card!.id)).toMatchObject({ ok: false, missing: true });
    // An agent posts the same words as a card of its own: its answer is typed back, nothing is installed.
    const fake = l.hill.postDecision(agent, { requestId: nextRid(), title: "Switch on the trick evil?", summary: "An agent session proposes it.", options: [{ intent: "on", label: "Switch it on" }, { intent: "later", label: "Not now" }], recommends: null });
    expect(fake.ok).toBe(true);
    if (!fake.ok) return;
    expect(fake.decision.from.kind).toBe("agent");
    expect(await tap(l, fake.decision, "on")).toMatchObject({ code: "ok" });
    expect(await listed(l)).toEqual([]);
  });

  test("a proposer whose session ended never holds the answer: the yes installs, and nothing is typed", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs"), AGENT);
    l.live.clear();
    const [card] = openCards(l);
    expect(await tap(l, card!, "on")).toMatchObject({ code: "ok", state: "answered", delivery: "none" });
    expect(await listed(l)).toEqual(["legs"]);
    expect(l.sent).toEqual([]);
  });

  test("a dismiss types nothing into the proposer's session", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs"), AGENT);
    const [card] = openCards(l);
    expect(await tap(l, card!, "dismiss")).toMatchObject({ code: "ok", state: "dismissed" });
    expect(l.sent).toEqual([]);
  });

  test("a terminal's proposal names no session", async () => {
    const l = await lead();
    await l.proposals.propose(proposal("legs"), TERMINAL);
    const [card] = openCards(l);
    expect(card?.replyTo).toBeNull();
    expect(card?.summary).toStartWith("Someone on bluefin proposes it. Collie could not confirm which session.");
  });
});
