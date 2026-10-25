// Clear on a draft the harness rewrites after every Backspace (omp gang 13-drafts, 2026-10-25, OMP 18.6.1
// and 18.12.6): the screens are the captures of a `-> then do this` draft (web/src/fixtures/surface/), the
// profile is OMP's own, and its `keys.clearAll` (Ctrl+C) is pressed at most once, never on an empty box.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { ClearReceipt } from "../../web/src/lib/surface/clear.ts";
import { KeyGate } from "./key-gate.ts";
import { ClearService } from "./clear.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const fx = (name: string): string => readFileSync(join(SURFACE, name), "utf8");

const WITH_BODY = fx("omp--draft-queueing-body--v18.12.6.txt");
const LABEL_ONLY = fx("omp--draft-queueing-label--v18.12.6.txt");
const EMPTY = fx("omp--box-empty--v18.12.6.txt");

/** An OMP box in the queue-prefix state: Backspace takes the body, then the label stays; Ctrl+C empties. */
class QueueingScreen {
  /** The settled screen, without a probe character on it. */
  base = WITH_BODY;
  /** The probe character typed and not yet taken back: OMP draws it after the draft, in the box. */
  probe = "";
  /** Every text typed into the box (the Clear's probe character). */
  typed: string[] = [];
  keys: string[] = [];
  /** Ctrl+C presses that met an empty box. */
  emptyPresses = 0;
  /** A Ctrl+C that leaves the box alone. */
  deafCtrlC = false;

  get screen(): string {
    return this.probe === "" ? this.base : `${this.base.replace(/\n$/u, "")}${this.probe}\n`;
  }

  set screen(next: string) {
    this.base = next;
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 0 }));
  };

  /** A stale image: typed text reaches no box on the screen, and the screen never changes. */
  stale = false;

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.typed.push(text);
    if (!this.stale) this.probe += text;
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keys.push(key);
      if (key === "ctrl+c") {
        if (this.base === EMPTY) this.emptyPresses++;
        else if (!this.deafCtrlC) this.base = EMPTY;
      } else if (key === "Backspace") {
        if (this.probe !== "") this.probe = "";
        else if (this.base === WITH_BODY) this.base = LABEL_ONLY;
      }
    }
    return Promise.resolve(muxAck());
  };
}

function service(pane: QueueingScreen, version = "18.12.6"): ClearService {
  return new ClearService({
    mux: pane,
    gate: new KeyGate(pane),
    profile: (harness) => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
    sleep: () => Promise.resolve(),
  });
}

async function clear(svc: ClearService, id: string): Promise<ClearReceipt> {
  const answer = await svc.handle(id, "%1", "omp");
  if (answer.kind !== "receipt") throw new Error("id reused");
  return answer.receipt;
}

describe("Clear on a box OMP rewrites after every Backspace", () => {
  test("the stuck screens read as a draft, the empty one as an empty box (the Surface the Clear acts on)", async () => {
    const pane = new QueueingScreen();
    pane.screen = EMPTY;
    expect(await clear(service(pane), "c0")).toMatchObject({ outcome: "refused", reason: "no_draft" });
    expect(pane.keys).toEqual([]);
  });

  test("Backspace takes the body, leaves the label, and Ctrl+C is pressed once to empty it: cleared, never on an empty box", async () => {
    for (const version of ["18.6.1", "18.12.6"]) {
      const pane = new QueueingScreen();
      const receipt = await clear(service(pane, version), `c1-${version}`);
      expect(receipt, version).toMatchObject({ outcome: "cleared" });
      expect(pane.keys.filter((key) => key === "ctrl+c"), version).toHaveLength(1);
      expect(pane.keys.at(-1)).toBe("ctrl+c");
      expect(pane.keys.slice(0, -1).every((key) => key === "Backspace")).toBe(true);
      expect(pane.emptyPresses).toBe(0);
      // The probe runs first: its character goes in as text, and its one Backspace comes before the batch.
      expect(pane.typed, version).toEqual(["⌁"]);
      expect(pane.keys[0], version).toBe("Backspace");
      expect(pane.probe).toBe("");
    }
  });

  test("a stale screen refuses stale_screen at the probe and presses no stroke key", async () => {
    const pane = new QueueingScreen();
    pane.stale = true;
    expect(await clear(service(pane), "c-stale")).toMatchObject({ outcome: "refused", reason: "stale_screen" });
    expect(pane.typed).toEqual(["⌁"]);
    expect(pane.keys).toEqual([]);
  });

  test("a box the label alone fills (Backspace left it unchanged from the first press) gets the stroke key the same way", async () => {
    const pane = new QueueingScreen();
    pane.screen = LABEL_ONLY;
    expect(await clear(service(pane), "c2")).toMatchObject({ outcome: "cleared" });
    expect(pane.keys.filter((key) => key === "ctrl+c")).toHaveLength(1);
    expect(pane.emptyPresses).toBe(0);
  });

  test("a stroke key that does not empty the box is pressed once: press_failed, and no second press", async () => {
    const pane = new QueueingScreen();
    pane.deafCtrlC = true;
    expect(await clear(service(pane), "c3")).toMatchObject({ outcome: "refused", reason: "press_failed" });
    expect(pane.keys.filter((key) => key === "ctrl+c")).toHaveLength(1);
    expect(pane.emptyPresses).toBe(0);
  });

  test("a replay of the request id answers the stored receipt and presses nothing more", async () => {
    const pane = new QueueingScreen();
    const svc = service(pane);
    await clear(svc, "c4");
    const pressed = pane.keys.length;
    expect(await clear(svc, "c4")).toMatchObject({ outcome: "cleared" });
    expect(pane.keys).toHaveLength(pressed);
  });

  test("a profile without the stroke key keeps the old end: press_failed after one Backspace batch, no Ctrl+C", async () => {
    // OMP's own profile with keys.clearAll removed: the old road, one Backspace batch and then press_failed.
    const pane = new QueueingScreen();
    const without = new ClearService({
      mux: pane,
      gate: new KeyGate(pane),
      profile: (harness) => {
        const match = profileFor(harness, "18.12.6", { log: () => undefined });
        if (match === null) return Promise.resolve(null);
        const { clearAll, ...keys } = match.profile.keys;
        void clearAll;
        return Promise.resolve({ ...match, profile: { ...match.profile, keys } });
      },
      sleep: () => Promise.resolve(),
    });
    expect(await clear(without, "c5")).toMatchObject({ outcome: "refused", reason: "press_failed" });
    expect(pane.keys).not.toContain("ctrl+c");
  });
});
