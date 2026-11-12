import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { powersOfDir, snapshotTrick } from "../tricks/approved.ts";
import { approvedTrickDir, trickStateDir, tricksConfigDir } from "../tricks/paths.ts";
import { updateSwitches, withApproval, withEntry } from "../tricks/switches.ts";
import { codeParts, leadTricks, readStateFiles } from "./standby-tricks-lead.ts";
import type { StandbyTricksStore } from "./standby-tricks.ts";

// Shared test fixtures for the §25 tricks copy. Not a test file itself (so `bun test` does not collect
// it) and not imported by any production path: three test files agree here on what a lead with an ON
// trick looks like, and on how its copy reaches a deputy's store.

/** The first bytes of a real PNG: the copy takes a picture only by its first bytes. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const made: string[] = [];

/** A fresh folder under the system temp folder, removed by {@link removeCarryDirs}. */
export async function carryTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `collie-carry-${label}-`));
  made.push(dir);
  return dir;
}

export async function removeCarryDirs(): Promise<void> {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export interface LeadMachine {
  readonly configDir: string;
  readonly stateDir: string;
}

export interface OnTrick {
  readonly id: string;
  readonly name?: string;
  readonly auto?: boolean;
  /** Extra files of the trick folder, by path. */
  readonly files?: Record<string, string | Uint8Array>;
  /** Files of the trick's state folder, by path. */
  readonly state?: Record<string, string>;
}

/** A machine with a config folder and a state folder, both empty. */
export async function machine(label: string): Promise<LeadMachine> {
  const root = await carryTempDir(label);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { configDir, stateDir };
}

/** Put one trick on `m` and switch it ON at its approved version, as the person's tap would. */
export async function putOnTrick(m: LeadMachine, t: OnTrick): Promise<string> {
  const dir = join(tricksConfigDir(m.configDir), t.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), `id = "${t.id}"\nname = "${t.name ?? t.id}"\nrun = "./p.sh"\nplaces = ["belt"]\n`);
  await writeFile(join(dir, "p.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  for (const [rel, body] of Object.entries(t.files ?? {})) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  const snap = await snapshotTrick({ src: dir, parent: approvedTrickDir(m.configDir, t.id) });
  if (!snap.ok) throw new Error(snap.reason);
  const powers = await powersOfDir(snap.dir, t.id);
  await updateSwitches(m.stateDir, (now) => {
    const approved = withApproval(now, t.id, { at: "2026-11-10T10:00:00.000Z", hash: snap.hash, by: "phone", powers });
    const entry = approved.on.get(t.id);
    return entry === undefined ? approved : withEntry(approved, t.id, { ...entry, auto: t.auto ?? false });
  });
  for (const [rel, body] of Object.entries(t.state ?? {})) {
    const path = join(trickStateDir(m.stateDir, t.id), rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }
  return snap.hash;
}

/** Carry everything `lead` runs to `store`, as the lead's sync would, without a wire. */
export async function carryAll(lead: LeadMachine, store: StandbyTricksStore, opts: { from?: string; crewId?: string; seq?: number } = {}): Promise<void> {
  const tricks = await leadTricks(lead.stateDir, lead.configDir);
  const applied = await store.applyList({ from: opts.from ?? "desk", crewId: opts.crewId ?? "crew-1", seq: opts.seq ?? 1, tricks: tricks.map((t) => t.trick) });
  if (!applied.ok) throw new Error(applied.code);
  for (const lt of tricks) {
    const parts = (await codeParts(lt.copyDir, lt.trick.files)) ?? [];
    for (let part = 0; part < parts.length; part += 1) {
      const done = await store.applyCodePart({ id: lt.trick.id, hash: lt.trick.hash, part, parts: parts.length, chunks: parts[part] ?? [] });
      if (!done.ok) throw new Error(done.reason);
    }
    if (lt.trick.state === null) continue;
    const pushed = await store.applyState({ id: lt.trick.id, digest: lt.trick.state, files: await readStateFiles(lt.state) });
    if (!pushed.ok) throw new Error(pushed.reason);
  }
}
