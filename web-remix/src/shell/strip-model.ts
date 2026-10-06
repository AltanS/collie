// The top band's registry (web/src/components/ui/strip-host.tsx): four strips can be true above the
// header at once (auth refusal, outage, an update run, a degraded link, an update offer), and the
// band shows exactly ONE, the highest priority. The table is web/'s `lib/strip-priority.ts`, reused
// read-only: AUTH 40 > OUTAGE 30 > UPDATE_RUN 25 > DEGRADED 20 > UPDATE 10.
//
// A feature takes a slot in setup and shows or hides it; the strip host draws the winner. Like the
// header claim, an entry is data plus a render function made once in setup, with `rev` bumped when
// what it draws changes; equal entries wake nobody.
import { TypedEventTarget } from "remix/component";
import type { RemixNode } from "remix/component";

export { AUTH, DEGRADED, OUTAGE, UPDATE, UPDATE_RUN } from "@web/lib/strip-priority";

export interface StripEntry {
  priority: number;
  render: () => RemixNode;
  rev?: number | string;
}

export interface StripSlot {
  show(entry: StripEntry): void;
  hide(): void;
}

export interface StripLayer {
  id: string;
  entry: StripEntry;
}

export class StripModel extends TypedEventTarget<{ change: Event }> {
  #slots = new Map<string, StripEntry>();
  #next = 0;

  /** Every registered strip, in registration order. The host stacks them all in one cell. */
  get layers(): StripLayer[] {
    return [...this.#slots].map(([id, entry]) => ({ id, entry }));
  }

  /** The id of the highest-priority strip; the first registered wins a tie. */
  get winner(): string | null {
    let best: string | null = null;
    let top = Number.NEGATIVE_INFINITY;
    for (const [id, entry] of this.#slots) {
      if (entry.priority > top) {
        top = entry.priority;
        best = id;
      }
    }
    return best;
  }

  /** The band shows something. The header reads it to hand over the notch inset. */
  get open(): boolean {
    return this.#slots.size > 0;
  }

  /** A slot for one feature, removed when `signal` aborts. */
  slot(signal?: AbortSignal): StripSlot {
    const id = `strip-${String(this.#next++)}`;
    const hide = (): void => {
      if (this.#slots.delete(id)) this.#changed();
    };
    signal?.addEventListener("abort", hide, { once: true });
    return {
      show: (entry) => {
        if (signal?.aborted) return;
        const current = this.#slots.get(id);
        if (current && current.priority === entry.priority && current.render === entry.render && current.rev === entry.rev) return;
        this.#slots.set(id, entry);
        this.#changed();
      },
      hide,
    };
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }
}
