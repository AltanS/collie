import { describe, expect, test } from "bun:test";

import { claimAgeDays } from "../bridge/cache/claims.ts";
import { allCacheRules } from "../bridge/cache/rules/index.ts";
import { cacheFindings, CLAIM_WARN_DAYS, cacheRulesPath, type CacheDeps } from "./cache-findings.ts";
import { context, fakeFiles, type SeededFiles } from "./fakes.ts";
import type { Finding } from "./finding.ts";

// `collie doctor`'s cache section. Nothing here reaches a real home, a real clock or a real bridge:
// the environment is injected, the clock is injected, and the one file read goes through the shared
// fake. That is the whole reason `cache-env` is a table test rather than a "set a variable and see".

const deps = (over: { env?: Record<string, string | undefined>; now?: number; files?: SeededFiles } = {}): CacheDeps => ({
  ctx: context(),
  files: fakeFiles(over.files ?? {}),
  env: over.env ?? {},
  now: () => over.now ?? Date.parse("2026-09-13T12:00:00Z"),
});

const find = (findings: readonly Finding[], check: string): Finding => {
  const hit = findings.find((f) => f.check === check);
  if (hit === undefined) throw new Error(`no ${check} finding`);
  return hit;
};

test("the section is exactly the three checks, and none can fail the verb", () => {
  const findings = cacheFindings(deps());
  expect(findings.map((f) => f.check)).toEqual(["cache-claims", "cache-rules", "cache-env"]);
  // All three are warn-severity at worst, so `collie doctor` still exits 0 (cli/doctor.ts:219).
  for (const f of findings) expect(f.status === "ok" || f.status === "warn").toBe(true);
});

describe("cache-claims", () => {
  test("passes on the shipped rules at a date inside the window, and names the oldest age", () => {
    // Every shipped claim was read on 2026-08-24, which is 20 days before the fixture's clock.
    const f = find(cacheFindings(deps()), "cache-claims");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain(`${String(allCacheRules().length)} cache rules`);
    expect(f.detail).toMatch(/oldest was checked \d+ days ago/);
  });

  test("warns once the wall clock has passed 180 days, naming each rule and its age", () => {
    const oldest = allCacheRules()[0];
    expect(oldest).toBeDefined();
    const at = Date.parse(`${oldest?.ttlSeconds.source.retrievedAt ?? ""}T00:00:00Z`) + (CLAIM_WARN_DAYS + 10) * 86_400_000;
    const f = find(cacheFindings(deps({ now: at })), "cache-claims");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("cache rule claude.subscription last checked 2026-08-24");
    expect(f.detail).toMatch(/\d+ days ago/);
    expect(f.remedy ?? "").toContain("cache-rules.toml");
  });

  test("is still ok one day before the threshold — the warning is strictly past it", () => {
    const source = allCacheRules()[0]?.ttlSeconds.source;
    expect(source).toBeDefined();
    const at = Date.parse(`${source?.retrievedAt ?? ""}T00:00:00Z`) + CLAIM_WARN_DAYS * 86_400_000;
    if (source !== undefined) expect(claimAgeDays(source, new Date(at))).toBe(CLAIM_WARN_DAYS);
    expect(find(cacheFindings(deps({ now: at })), "cache-claims").status).toBe("ok");
  });
});

describe("cache-rules", () => {
  const CONFIG_FILE = cacheRulesPath(context());
  const GOOD = `[[rule]]
id = "claude.api"
ttl_seconds = 3600
source_url = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
retrieved = "2026-09-12"
`;

  test("no file is the ordinary case, not a fault", () => {
    const f = find(cacheFindings(deps()), "cache-rules");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("every TTL is the shipped rule");
  });

  test("names each applied override when the file is clean", () => {
    const f = find(cacheFindings(deps({ files: { [CONFIG_FILE]: GOOD } })), "cache-rules");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("claude.api → 3600s");
  });

  test("warns with the validator's own reason, naming the row", () => {
    const bad = GOOD.replace('retrieved = "2026-09-12"', 'retrieved = "soon"');
    const f = find(cacheFindings(deps({ files: { [CONFIG_FILE]: bad } })), "cache-rules");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain('row 1: "retrieved" is not a YYYY-MM-DD date');
  });

  test("keeps the good rows and warns about the bad one in the same line", () => {
    const mixed = `${GOOD}\n[[rule]]\nid = "nope.nope"\nttl_seconds = 60\nsource_url = "https://x.invalid"\nretrieved = "2026-09-13"\n`;
    const f = find(cacheFindings(deps({ files: { [CONFIG_FILE]: mixed } })), "cache-rules");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("claude.api → 3600s");
    expect(f.detail).toContain("row 2");
  });

  test("a file that is not TOML is a HOLD, described as one", () => {
    const f = find(cacheFindings(deps({ files: { [CONFIG_FILE]: "[[rule]\nid =" } })), "cache-rules");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("not valid TOML");
  });
});

describe("cache-env", () => {
  const CONFIG_FILE = cacheRulesPath(context());

  test("is ok when neither variable is set", () => {
    const f = find(cacheFindings(deps()), "cache-env");
    expect(f.status).toBe("ok");
    expect(f.remedy).toBeNull();
  });

  test.each([["ENABLE_PROMPT_CACHING_1H"], ["FORCE_PROMPT_CACHING_5M"]])(
    "warns when %s is set in this shell and no override mirrors it",
    (name) => {
      const f = find(cacheFindings(deps({ env: { [name]: "1" } })), "cache-env");
      expect(f.status).toBe("warn");
      expect(f.detail).toContain(`${name}=1`);
      expect(f.remedy).toBe("mirror this into cache-rules.toml with the page you read and today's date");
    },
  );

  test("an empty or whitespace value is not set", () => {
    expect(find(cacheFindings(deps({ env: { ENABLE_PROMPT_CACHING_1H: "  " } })), "cache-env").status).toBe("ok");
  });

  test("goes quiet once cache-rules.toml names a claude rule", () => {
    const files = { [CONFIG_FILE]: 'id = "claude.api"\nttl_seconds = 3600\n' };
    const f = find(cacheFindings(deps({ env: { ENABLE_PROMPT_CACHING_1H: "1" }, files })), "cache-env");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("already moves a claude rule");
  });

  test("a file that moves some OTHER harness's rule does not silence the warning", () => {
    const files = { [CONFIG_FILE]: 'id = "codex.api"\nttl_seconds = 1800\n' };
    expect(find(cacheFindings(deps({ env: { FORCE_PROMPT_CACHING_5M: "1" }, files })), "cache-env").status).toBe("warn");
  });

  test("the bridge's own environment is never consulted — the env is the one handed in", () => {
    // Stated as a test because it is the whole reason `env` is a parameter (ADR 0041): the bridge is a
    // systemd unit whose environment belongs to the wrong process, and only `doctor` may read a shell.
    const f = find(cacheFindings({ ...deps(), env: {} }), "cache-env");
    expect(f.detail).toBe("no Claude Code cache variable is set in this shell");
  });
});
