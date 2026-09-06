import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeExec, ROOT } from "./fakes.ts";
import { realExec } from "./sys.ts";
import { anonymousTagUrl, tagRemote } from "./update-remote.ts";

const HTTPS = "https://github.com/AltanS/collie.git";
const REMOTE = `https::${HTTPS}`;

describe("release tag transport", () => {
  test("GitHub spellings select the HTTPS helper; mirrors and paths are unchanged", () => {
    for (const url of [HTTPS, "git@github.com:AltanS/collie.git", "ssh://git@github.com/AltanS/collie.git"]) {
      expect(anonymousTagUrl(url)).toBe(REMOTE);
    }
    expect(anonymousTagUrl(" git@GitHub.com:a/b/ ")).toBe("https::https://github.com/a/b.git");
    for (const url of ["git@git.example.com:a/b.git", "https://git.example.com/a/b.git", "/srv/mirrors/collie.git"]) {
      expect(anonymousTagUrl(url)).toBe(url);
    }
  });

  test("a mirror retains its named-remote settings", () => {
    const exec = fakeExec({ answers: [[`git -C ${ROOT} remote get-url origin`, { stdout: "https://mirror.example/collie.git\n" }]] });
    expect(tagRemote(exec, ROOT)).toBe("origin");
  });

  test("an unreadable origin retains the named-remote fallback", () => {
    const exec = fakeExec({ answers: [[`git -C ${ROOT} remote get-url origin`, { code: 2 }]] });
    expect(tagRemote(exec, ROOT)).toBe("origin");
  });

  test("real git lists AND fetches over HTTPS despite global and local SSH rewrites, without editing config", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-update-https-"));
    try {
      const repo = join(root, "source");
      const checkout = join(root, "checkout");
      const helpers = join(root, "helpers");
      const log = join(root, "transport.log");
      const global = join(root, "gitconfig");
      mkdirSync(helpers);
      writeFileSync(global, '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
      // Only this private HTTPS helper can supply refs. It records the address Git actually hands
      // it, then serves a local fixture via upload-pack: no network and no operator credentials.
      writeFileSync(join(helpers, "git-remote-https"), `#!/bin/sh
printf '%s\\n' "$2" >> "$TRANSPORT_LOG"
while IFS= read -r line; do
  case "$line" in
    capabilities) printf 'connect\\n\\n' ;;
    'connect git-upload-pack') printf '\\n'; exec git upload-pack "$FIXTURE_REPO" ;;
    *) printf 'unsupported\\n' ;;
  esac
done
`, { mode: 0o755 });
      const noSsh = join(root, "no-ssh");
      writeFileSync(noSsh, '#!/bin/sh\necho "SSH must not be used" >&2\nexit 97\n', { mode: 0o755 });
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: global,
        GIT_EXEC_PATH: helpers,
        GIT_SSH_COMMAND: noSsh,
        GIT_TERMINAL_PROMPT: "0",
        TRANSPORT_LOG: log,
        FIXTURE_REPO: repo,
      };
      const exec = realExec(env, root);
      const git = (args: string[]): string => {
        const r = exec.capture("git", args, 5_000);
        if (!r.found || r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      git(["init", "-q", repo]);
      git(["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "release"]);
      git(["-C", repo, "tag", "v1.0.0"]);
      const commit = git(["-C", repo, "rev-parse", "HEAD"]);
      git(["init", "-q", checkout]);
      git(["-C", checkout, "remote", "add", "origin", HTTPS]);
      git(["-C", checkout, "config", "url.ssh://git@github.com/AltanS/.insteadOf", "https://github.com/AltanS/"]);
      const localConfig = join(checkout, ".git", "config");
      const before = readFileSync(localConfig, "utf8");
      const beforeGlobal = readFileSync(global, "utf8");

      // Negative control: a plain HTTPS URL is still rewritten to SSH by real Git.
      expect(git(["-C", checkout, "ls-remote", "--get-url", HTTPS])).toBe("ssh://git@github.com/AltanS/collie.git");
      expect(exec.capture("git", ["-C", checkout, "ls-remote", "--tags", HTTPS], 5_000).code).not.toBe(0);
      const remote = tagRemote(exec, checkout);
      expect(remote).toBe(REMOTE);
      expect(git(["-C", checkout, "ls-remote", "--tags", remote])).toBe(`${commit}\trefs/tags/v1.0.0`);
      git(["-C", checkout, "fetch", "--depth", "1", remote, "+refs/tags/v1.0.0:refs/tags/v1.0.0"]);
      expect(git(["-C", checkout, "rev-parse", "refs/tags/v1.0.0"])).toBe(commit);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([HTTPS, HTTPS]);
      expect(readFileSync(localConfig, "utf8")).toBe(before);
      expect(readFileSync(global, "utf8")).toBe(beforeGlobal);
      expect(git(["-C", checkout, "remote", "get-url", "--push", "origin"])).toBe("ssh://git@github.com/AltanS/collie.git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
