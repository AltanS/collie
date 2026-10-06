import { describe, expect, test } from "bun:test";

import { MASK, redactAnsi, redactSegments, redactText } from "./redact.ts";

// PLACEHOLDERS ONLY. No string here is a real key. The ones whose shape a repo-wide secret scan
// would flag (`ghp_…`, `AKIA…`, a bare `sk-…`) are joined at runtime from two halves, so the scan in
// the M46 spec (`git grep` for those shapes over bridge/) finds nothing in this file either.
const OPENROUTER = `sk-or-v1-your-key-here-${"0".repeat(40)}`;
const ANTHROPIC = `sk-ant-api03-your-key-here-${"0".repeat(30)}`;
const OPENAI = ["sk-", "PLACEHOLDERplaceholder0000"].join("");
const GITHUB = ["ghp_", "placeholder0000000000000000000000"].join("");
const GITHUB_PAT = ["github_pat_", "placeholder_000000000000000"].join("");
const SLACK = ["xoxb-", "000000000-placeholder"].join("");
const AWS = ["AKIA", "PLACEHOLDER00000"].join("");
const GOOGLE = ["AIza", "Placeholder_000000000000000000000000"].join("");
const GITLAB = ["glpat-", "placeholder000000000"].join("");
const NPM = ["npm_", "placeholder00000000000000000000000000"].join("");
const JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJwbGFjZWhvbGRlciJ9.cGxhY2Vob2xkZXJzaWduYXR1cmU";

const ESC = String.fromCodePoint(0x1b);

/** The same string with every masked character found, for asserting WHERE the mask landed. */
function maskedAt(text: string): string {
  return [...text].map((c) => (c === MASK ? "x" : ".")).join("");
}

describe("redact — each pattern family masks its placeholder", () => {
  const families: [string, string, number][] = [
    ["an OpenRouter key", OPENROUTER, 4],
    ["an Anthropic key", ANTHROPIC, 4],
    ["an OpenAI-style sk- key", OPENAI, 4],
    ["a GitHub token", GITHUB, 4],
    ["a fine-grained GitHub PAT", GITHUB_PAT, 4],
    ["a Slack token", SLACK, 4],
    ["an AWS access key id", AWS, 4],
    ["a Google API key", GOOGLE, 4],
    ["a GitLab token", GITLAB, 4],
    ["an npm token", NPM, 4],
    ["a JWT", JWT, 4],
  ];
  for (const [name, secret, keep] of families) {
    test(`${name}: masked to the same width, its vendor prefix kept`, () => {
      const out = redactText(`before ${secret} after`);
      expect(out).toBe(`before ${secret.slice(0, keep)}${MASK.repeat(secret.length - keep)} after`);
      expect(out).not.toContain(secret);
    });
  }

  test("a bearer token: the token is masked whole, the word Bearer stays", () => {
    const token = "placeholder-token-0000000000";
    const out = redactText(`curl -H 'Authorization: Bearer ${token}' https://example.com`);
    expect(out).toBe(`curl -H 'Authorization: Bearer ${MASK.repeat(token.length)}' https://example.com`);
  });

  test("password=, DB_PASSWORD:, \"api_key\": and GITHUB_TOKEN= mask the value only", () => {
    expect(redactText("password=placeholder1")).toBe(`password=${MASK.repeat(12)}`);
    expect(redactText("DB_PASSWORD: placeholder1")).toBe(`DB_PASSWORD: ${MASK.repeat(12)}`);
    expect(redactText('{"api_key": "placeholder1"}')).toBe(`{"api_key": "${MASK.repeat(12)}"}`);
    expect(redactText("AWS_SECRET_ACCESS_KEY=placeholder000")).toBe(`AWS_SECRET_ACCESS_KEY=${MASK.repeat(14)}`);
    // A named value that is itself a prefixed key keeps the prefix, as it would on its own.
    expect(redactText(`GITHUB_TOKEN=${GITHUB}`)).toBe(`GITHUB_TOKEN=ghp_${MASK.repeat(GITHUB.length - 4)}`);
  });

  test("a PEM private key: every body line masked, BEGIN and END kept, line count unchanged", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "PLACEHOLDERplaceholderPLACEHOLDERplaceholder0000",
      "placeholder0000==",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(`key:\n${pem}\ndone`);
    const lines = out.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("-----BEGIN PRIVATE KEY-----");
    expect(lines[2]).toBe(MASK.repeat(48));
    expect(lines[3]).toBe(MASK.repeat(17));
    expect(lines[4]).toBe("-----END PRIVATE KEY-----");
    expect(lines[5]).toBe("done");
  });

  test("a PEM block whose END is off screen masks the body lines it can see", () => {
    const out = redactText("-----BEGIN RSA PRIVATE KEY-----\nPLACEHOLDER0000\nplaceholder0000");
    expect(out.split("\n")).toEqual(["-----BEGIN RSA PRIVATE KEY-----", MASK.repeat(15), MASK.repeat(15)]);
  });
});

describe("redact — ordinary text and code stay unchanged", () => {
  const untouched = [
    ["a 40-char hex git sha", "commit 3f786850e387550fdab836ed7e6dc881de23001b"],
    ["a URL without a token", "open https://example.com/docs/page?q=1&lang=en#token-section"],
    ["password: with a short value", "password: short"],
    ["an empty password: line", "password: "],
    ["a TypeScript field", "  token: string;"],
    ["code that reads a secret", "const key = process.env.SECRET; secret: options.secret,"],
    ["a placeholder value", "API_KEY=${API_KEY} TOKEN=$TOKEN password=<your-password>"],
    ["a token count", "max_tokens: 4096000000, input_tokens: 123456789"],
    ["a short sk- slug", "pip install sk-learn"],
    ["a PEM writer's source", 'const a = "-----BEGIN PRIVATE KEY-----";\nwrite(a);\nconst b = "-----END PRIVATE KEY-----";'],
    ["a public key", "-----BEGIN PUBLIC KEY-----\nPLACEHOLDER0000\n-----END PUBLIC KEY-----"],
  ];
  for (const [name, text] of untouched) {
    test(`redact leaves ${name} alone`, () => {
      expect(redactText(text!)).toBe(text!);
    });
  }

  test("redact leaves a call or an index on an identifier alone: it is code, not a secret", () => {
    for (const code of ["token = useToken()", "secret: getSecret(cfg)", "api_key=cfg.keys[0]", "f(token=getToken())"]) {
      expect(redactText(code)).toBe(code);
    }
  });

  test("redact still masks a plain value, and one with text after its brackets", () => {
    expect(redactText("token=abcDEF123xyz")).toBe(`token=${MASK.repeat(12)}`);
    expect(redactText("token=abc(123)xyz")).toBe(`token=${MASK.repeat(11)}`);
  });

  test("redact is idempotent: a masked text has nothing left to mask", () => {
    const once = redactText(`${OPENROUTER} password=placeholder1 ${JWT}`);
    expect(redactText(once)).toBe(once);
  });
});

describe("redact — layout holds", () => {
  test("layout: every row keeps its length, so the mirror's columns hold", () => {
    const screen = [`export KEY=${AWS}`, "ls -la", `curl -H "Authorization: Bearer ${"p".repeat(24)}"`].join("\n");
    const out = redactText(screen);
    expect(out.split("\n").map((r) => r.length)).toEqual(screen.split("\n").map((r) => r.length));
  });

  test("layout: segments keep their count and widths when a key spans a colour change", () => {
    const segments = ["$ echo ", OPENROUTER.slice(0, 12), OPENROUTER.slice(12), " ok"];
    const out = redactSegments(segments);
    expect(out).toHaveLength(segments.length);
    expect(out.map((s) => s.length)).toEqual(segments.map((s) => s.length));
    expect(out[0]).toBe("$ echo ");
    expect(out[1]).toBe(`sk-o${MASK.repeat(8)}`);
    expect(out[2]).toBe(MASK.repeat(OPENROUTER.length - 12));
    expect(out[3]).toBe(" ok");
  });

  test("layout: ANSI escapes survive byte for byte around a masked key", () => {
    const red = `${ESC}[31m`;
    const reset = `${ESC}[0m`;
    const text = `${red}${OPENROUTER.slice(0, 10)}${reset}${OPENROUTER.slice(10)} tail`;
    const out = redactAnsi(text);
    expect(out.length).toBe(text.length);
    expect(out.startsWith(`${red}sk-o${MASK.repeat(6)}${reset}`)).toBe(true);
    expect(out.endsWith(" tail")).toBe(true);
    expect(out).not.toContain(OPENROUTER.slice(10));
  });

  test("layout: an OSC hyperlink's hidden target is masked too, and the escape still parses", () => {
    const osc = `${ESC}]8;;https://example.com/?token=placeholder000${ESC}\\`;
    const out = redactAnsi(`${osc}link${ESC}]8;;${ESC}\\`);
    expect(out.startsWith(`${ESC}]8;;https://example.com/?token=${MASK.repeat(14)}${ESC}\\`)).toBe(true);
    expect(out).toContain("link");
  });

  test("layout: a key the terminal wrapped at its edge is masked on both rows", () => {
    const width = 30;
    const line = `KEY ${JWT}`;
    const rows = [line.slice(0, width), line.slice(width, 2 * width), line.slice(2 * width)];
    const screen = [...rows, "next prompt $"].join("\n");
    const out = redactAnsi(screen).split("\n");
    expect(out.map((r) => r.length)).toEqual(screen.split("\n").map((r) => r.length));
    expect(maskedAt(out[1]!)).toBe("x".repeat(rows[1]!.length));
    expect(maskedAt(out[2]!)).toBe("x".repeat(rows[2]!.length));
    expect(out[3]).toBe("next prompt $");
  });

  test("layout: a short row's value is not followed onto the next row", () => {
    const out = redactAnsi(`${"-".repeat(40)}\npassword=placeholder1\nls -la`).split("\n");
    expect(out[2]).toBe("ls -la");
  });
});

describe("redact — cost", () => {
  // The mirror is polled every 1.5 s per open pane. Best of five, so one GC pause is not a failure;
  // set COLLIE_SKIP_PERF=1 on a machine too slow or too loaded for a wall-clock bound.
  test.skipIf(process.env.COLLIE_SKIP_PERF === "1")("redact: a 200 × 200 screen in under 20 ms", () => {
    const filler = "const value = compute(input, options); // a line of ordinary code ";
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) {
      const base = `${ESC}[3${i % 8}m${filler}${filler}${filler}${ESC}[0m`;
      rows.push(i % 50 === 0 ? `${base} token=placeholder${i}0000 ${OPENROUTER}`.slice(0, 220) : base.slice(0, 210));
    }
    const screen = rows.join("\n");
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      redactAnsi(screen);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(20);
  });
});
