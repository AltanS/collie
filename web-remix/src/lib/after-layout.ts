// Layout reads after the browser's own layout, batched (REMIX3.md, "Layout in insert callbacks").
//
// A read of a box (`getBoundingClientRect`, `scrollWidth`, `getComputedStyle`) inside the runtime's
// flush forces the whole new screen's style and layout inside the tap's task: whoever reads first
// pays for the first layout of the pane (research note 05, rank 2; the profile of 2026-10-06, 3.4).
// So a caller hands its read and its write here instead. One shared ResizeObserver takes the node;
// its first observation arrives after that frame's layout, when style and layout are clean and a
// read costs nothing. Every job of one delivery reads first, then every job writes, so one job's
// write never dirties the layout another job's read then forces.
//
// A node with no box (`display: none`, 0x0) gets no first observation until it has one, which is
// when a read can mean anything. Without ResizeObserver, one animation frame after the call.
import { hasResizeObserver } from "@web/lib/env";

/** One caller's read, returning the write it decided on: the read runs first, the write later. */
interface Job {
  read: () => () => void;
}

const jobs = new Map<Element, Job[]>();
let observer: ResizeObserver | null = null;

function deliver(entries: readonly ResizeObserverEntry[]): void {
  const batch: Job[] = [];
  for (const { target } of entries) {
    const list = jobs.get(target);
    if (list === undefined) continue;
    jobs.delete(target);
    observer?.unobserve(target);
    batch.push(...list);
  }
  const writes = batch.map((job) => job.read());
  for (const write of writes) write();
}

/**
 * Run `read` after the next layout of `node`, then `write` with what it returned. Reads of every job
 * due in the same frame run before any write. `signal` drops the job if it aborts first.
 */
export function afterLayout<T>(node: Element, read: () => T, write: (value: T) => void, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const job: Job = {
    read: () => {
      const value = read();
      return () => write(value);
    },
  };
  if (!hasResizeObserver()) {
    const frame = requestAnimationFrame(() => {
      if (signal?.aborted) return;
      job.read()();
    });
    signal?.addEventListener("abort", () => cancelAnimationFrame(frame), { once: true });
    return;
  }
  observer ??= new ResizeObserver(deliver);
  const list = jobs.get(node);
  if (list === undefined) {
    jobs.set(node, [job]);
    observer.observe(node);
  } else list.push(job);
  signal?.addEventListener(
    "abort",
    () => {
      const now = jobs.get(node);
      if (now === undefined) return;
      const left = now.filter((j) => j !== job);
      if (left.length > 0) {
        jobs.set(node, left);
        return;
      }
      jobs.delete(node);
      observer?.unobserve(node);
    },
    { once: true },
  );
}
