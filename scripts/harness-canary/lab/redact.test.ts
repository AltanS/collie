import { describe, expect, test } from "bun:test";
import { redact, redactRows, stripAnsi, type RedactContext } from "./redact";

const ctx: RedactContext = { home: "/home/alice", user: "alice", host: "bluefin", labDirs: ["/home/alice/.cache/collie-lab/harness-lab/claude-2.1.301"] };

describe("redact", () => {
  test("the home, the lab dir, the user and the host go", () => {
    const text = "cwd /home/alice/.cache/collie-lab/harness-lab/claude-2.1.301/project and /home/alice/notes by alice on bluefin";
    expect(redact(text, ctx)).toBe("cwd <lab>/project and ~/notes by user on host");
  });

  test("the /var/home spelling of a home is redacted too, in both directions", () => {
    expect(redact("/var/home/alice/x", ctx)).toBe("~/x");
    expect(redact("/home/bob/x", { ...ctx, home: "/var/home/bob", user: "bob" })).toBe("~/x");
  });

  test("an e-mail, a key and a bearer token go", () => {
    const out = redact("me@example.com sk-ant-abcdefghijklmnop1234 Bearer abcdefghijklmnopqrstuvwxyz0123", ctx);
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("<email>");
  });

  test("a long mixed secret and a uuid go, a plain long word stays", () => {
    const out = redact("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6 123e4567-e89b-12d3-a456-426614174000 internationalization", ctx);
    expect(out).toContain("<secret>");
    expect(out).toContain("<id>");
    expect(out).toContain("internationalization");
  });

  test("escape sequences are stripped and trailing blank rows are dropped", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(redactRows(["\u001b[1mhi alice\u001b[0m  ", "", ""], ctx)).toEqual(["hi user"]);
  });
});
