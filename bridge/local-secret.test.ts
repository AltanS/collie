import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isWellFormedLocalSecret,
  LOCAL_SECRET_FILENAME,
  localAuthHeader,
  localCredentialOf,
  localSecretPath,
  mintLocalSecret,
  readLocalSecret,
  removeLocalSecret,
  writeLocalSecret,
} from "./local-secret.ts";

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-local-secret-"));
  dirs.push(dir);
  return join(dir, "state");
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const diskRead = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

describe("the local secret", () => {
  test("a fresh secret is 256 bits as base64url, and two are never the same", () => {
    const a = mintLocalSecret();
    expect(a).toHaveLength(43);
    expect(isWellFormedLocalSecret(a)).toBe(true);
    expect(mintLocalSecret()).not.toBe(a);
    expect(mintLocalSecret(() => Buffer.alloc(32, 0))).toBe("A".repeat(43));
  });

  test("the matcher keeps the hash, and matches the secret and nothing else", () => {
    const secret = mintLocalSecret();
    const credential = localCredentialOf(secret);
    expect(credential.matches(secret)).toBe(true);
    expect(credential.matches(null)).toBe(false);
    expect(credential.matches("")).toBe(false);
    expect(credential.matches(mintLocalSecret())).toBe(false);
    expect(credential.matches(`${secret} `)).toBe(false);
    expect(credential.matches(secret.slice(1))).toBe(false);
    // The matcher holds no copy of the secret itself.
    expect(JSON.stringify(credential)).not.toContain(secret);
  });

  test("it is written owner-only into an owner-only state folder, and read back by the CLI", async () => {
    const dir = await stateDir();
    const secret = mintLocalSecret();
    await writeLocalSecret(dir, secret);
    expect(localSecretPath(dir)).toBe(join(dir, LOCAL_SECRET_FILENAME));
    if (process.platform !== "win32") {
      expect((await stat(localSecretPath(dir))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    expect(readLocalSecret(dir, diskRead)).toBe(secret);
    // A restart rotates it: the file is replaced, never appended to.
    const next = mintLocalSecret();
    await writeLocalSecret(dir, next);
    expect(readLocalSecret(dir, diskRead)).toBe(next);
  });

  test("the CLI reads nothing from a missing file or one that is not secret-shaped", async () => {
    const dir = await stateDir();
    expect(readLocalSecret(dir, diskRead)).toBeNull();
    await writeLocalSecret(dir, mintLocalSecret());
    for (const body of ["", "short", `${"A".repeat(43)}!`, "A".repeat(44), "has space in it and is forty-three chars."]) {
      await writeFile(localSecretPath(dir), body);
      expect(readLocalSecret(dir, diskRead)).toBeNull();
    }
    expect(localAuthHeader(null)).toEqual({});
    expect(localAuthHeader("A".repeat(43))).toEqual({ authorization: `Bearer ${"A".repeat(43)}` });
  });

  test("a clean stop deletes its own file, and leaves a newer bridge's file alone", async () => {
    const dir = await stateDir();
    const mine = mintLocalSecret();
    await writeLocalSecret(dir, mine);
    await removeLocalSecret(dir, mine);
    expect(existsSync(localSecretPath(dir))).toBe(false);
    // Removing again, or with nothing there, is quiet.
    await removeLocalSecret(dir, mine);
    // An overlapping restart: the new bridge wrote its own before the old one finished stopping.
    const theirs = mintLocalSecret();
    await writeLocalSecret(dir, theirs);
    await removeLocalSecret(dir, mine);
    expect(readLocalSecret(dir, diskRead)).toBe(theirs);
  });
});
