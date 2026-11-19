// Shared by deliver.test.ts and deliver.slow.test.ts: the helpers both files need. Not a test file.

import { loadProfiles, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { type WalkyPane } from "./deliver.ts";
import { spaceOf } from "./space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
export const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

export const roots: string[] = [];

export function pane(paneId: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE, ...over };
}

export const operator = { kind: "operator" as const, label: "cli" };

export const send = (id: string, to: string, body = "hello") => ({ id, to, body, replyTo: null });

// ── Through the real Send Protocol ────────────────────────────────────────────────────────────────

export const RULE = "─".repeat(40);

export const WIDTH = 38;

/** The Claude profile's probe character. */
export const PROBE = loadProfiles().get("claude")!.probe.char;

/** The Claude range the Send Protocol tests pin (protocol.rig.ts `CLAUDE_TEST_RANGE`). */
export const TEST_RANGE: readonly [VersionRange] = [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }];

/** A Claude Code input box as protocol.rig.ts's FakePane draws it, cut to what a walky send needs. */
export class BoxPane {
  revision = 1;
  transcript = ["> an earlier question", "An answer from the agent."];
  box = "";
  /** The turn the poll's Surface reads. The screen itself draws no running row: no release reads it then. */
  running = false;
  calls: string[] = [];
  keysSeen: string[] = [];
  /**
   * Set: the empty box shows these hints as plain text, the next one on each read, as Claude Code
   * rotates them and herdr-core reads them (no faint attribute, live 2026-10-30). Null: one faint hint.
   */
  plainHints: readonly string[] | null = null;
  /**
   * The screen as herdr-core reads it (M78 spec 06): no styling anywhere, so the grey rules and a faint
   * suggestion come as plain text. False: Claude Code's colours, as a coloured multiplexer reads them.
   */
  plain = false;
  /** Set: the empty box shows Claude Code's prompt suggestion in free words (faint, or plain with {@link plain}). */
  suggestion: string | null = null;
  /** The box does not take the probe character: it never shows (a deaf box). */
  deaf = false;
  private reads = 0;

  private boxRows(): string[] {
    if (this.box === "" && this.plainHints !== null) return [`❯ ${this.plainHints[this.reads % this.plainHints.length]!}`];
    if (this.box === "" && this.suggestion !== null) return [this.plain ? `❯ ${this.suggestion}` : `❯ \u001b[2m${this.suggestion}\u001b[0m`];
    if (this.box === "") return ['❯ \u001b[2mTry "fix the failing tests"\u001b[0m'];
    const rows: string[] = [];
    this.box.split("\n").forEach((line, li) => {
      const chunks = line.length === 0 ? [""] : (line.match(new RegExp(`.{1,${String(WIDTH)}}`, "gu")) ?? [""]);
      chunks.forEach((chunk, ci) => rows.push(li === 0 && ci === 0 ? `❯ ${chunk}` : `  ${chunk}`));
    });
    return rows;
  }

  /** What the bridge's poll reads: a turn, a draft, or a free pane. */
  surface(): Surface {
    if (this.running) return { revision: this.revision, turn: "running", modal: "none", composer: this.box === "" ? "empty" : "draft" };
    return { revision: this.revision, turn: "idle", modal: "none", composer: this.box === "" ? "empty" : "draft" };
  }

  readGrid = (paneId: string): Promise<MuxOutcome<MuxGrid>> => {
    this.reads++;
    // Claude Code paints its rules grey; a plain-text read (herdr-core) has no colour at all.
    const rule = this.plain || this.plainHints !== null ? RULE : `\u001b[38;2;136;136;136m${RULE}\u001b[0m`;
    return Promise.resolve(muxOk({ paneId, text: [...this.transcript, "", rule, ...this.boxRows(), rule, "  sonnet · project · main"].join("\n"), truncated: false, revision: this.revision }));
  };

  private take(text: string): void {
    this.box += text;
    this.revision++;
  }

  typeText = (_paneId: string, text: string): Promise<MuxAck> => {
    this.calls.push(`type:${text}`);
    if (this.deaf && text === PROBE) return Promise.resolve(muxAck());
    this.take(text);
    return Promise.resolve(muxAck());
  };

  pasteText = (_paneId: string, text: string): Promise<MuxAck> => {
    this.calls.push(`paste:${text}`);
    this.take(text);
    return Promise.resolve(muxAck());
  };

  writeKeys = (_paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "ctrl+j") this.box += "\n";
      else if (key === "Enter" && this.box.length > 0) {
        this.transcript.push(`> ${this.box.replace(/\n/gu, " ")}`);
        this.box = "";
      }
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };
}

/** What the desk of {@link wired} changes between polls: the pane's instance, the person, a send to wait for. */
export interface DeskState {
  instance: string;
  desk: (poll: number) => void;
  hold: Promise<unknown> | null;
}
