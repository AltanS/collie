// The small files the Bun example keeps in its data folder, so a restart keeps what the phone did:
// the names it gave a workspace or a tab (`titles.json`, WIRE.md 7.8) and the conversations it closed
// (`closed.json`, WIRE.md 7.9, until it reopens one, 7.16), and the sign-in a real model may use (`auth.json`). The layout is made again on every start, so these win over the code.
// Each is written to a temporary file and renamed over the old one, so a crash leaves the old file
// whole. A file that cannot be read is treated as empty: a program should start.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // an unreadable file is as good as none
  }
}

/** The names the phone gave. A key is the kind and the wire id: `tab/triage:inbox`. */
export class TitleStore {
  private readonly names = new Map<string, string>();
  constructor(private readonly file: string) {
    const parsed = readJson(file);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") this.names.set(key, value);
  }
  get(kind: "workspace" | "tab", id: string, fallback: string): string {
    return this.names.get(`${kind}/${id}`) ?? fallback;
  }
  set(kind: "workspace" | "tab", id: string, title: string): void {
    this.names.set(`${kind}/${id}`, title);
    writeJson(this.file, Object.fromEntries(this.names));
  }
}

/** The conversations the phone closed, by conversation id. A restart does not show them again. */
export class ClosedStore {
  private readonly ids = new Set<string>();
  constructor(private readonly file: string) {
    const parsed = readJson(file);
    if (!Array.isArray(parsed)) return;
    for (const id of parsed) if (typeof id === "string") this.ids.add(id);
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    writeJson(this.file, [...this.ids]);
  }
  /** The phone reopened it (WIRE.md 7.16): show it again on the next start. */
  delete(id: string): void {
    if (!this.ids.delete(id)) return;
    writeJson(this.file, [...this.ids]);
  }
}

/**
 * Pi's credential store on one JSON file, `auth.json`, the file `login openai` of Pi's CLI writes:
 * `{ "<provider id>": { "type": "oauth", ... } }`. Pi refreshes an expiring ChatGPT sign-in through `modify`,
 * and the new tokens are written back here. One process uses it, so a promise chain is the only lock it needs.
 * The file is written with mode 0600. Collie never reads it, and this app never prints it.
 */
export class CredentialFile implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private all(): Record<string, Credential> {
    const parsed = readJson(this.file);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, Credential>;
  }
  private exclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => {});
    return run;
  }
  async read(providerId: string): Promise<Credential | undefined> {
    return this.all()[providerId];
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.all()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.exclusive(async () => {
      const all = this.all();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      writeJson(this.file, { ...all, [providerId]: next });
      return next;
    });
  }
  delete(providerId: string): Promise<void> {
    return this.exclusive(() => {
      const { [providerId]: _gone, ...rest } = this.all();
      writeJson(this.file, rest);
    });
  }
}
