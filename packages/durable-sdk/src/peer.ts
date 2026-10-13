// Who is on the other end of an accepted Unix connection, and is that process the program itself or
// one of its descendants? WIRE.md "What the socket does not protect against".
//
// What Bun gives us: `Bun.listen({ unix })` hands every accepted socket an `fd`. With that fd,
// `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` through `bun:ffi` returns the peer's pid, uid and gid, as the
// kernel recorded them at connect time. Bun has no API of its own for this: `Bun.serve({ unix })` gives
// `requestIP() === null`, and a `node:net` socket under Bun has no handle and no fd. So the SDK listens with
// `Bun.listen` and feeds each connection to `node:http` (see server.ts). Linux only. Elsewhere there is no
// reading, and the SDK refuses to start unless the program turns the defence off by name.

import { readFileSync } from "node:fs";

export interface PeerCred {
  pid: number;
  uid: number;
  gid: number;
}

/** `self`: the program's own pid. `descendant`: a child, grandchild and so on. `other`: neither. `unknown`: the walk broke. */
export type Relation = "self" | "descendant" | "other" | "unknown";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

let getsockopt: ((fd: number, level: number, name: number, value: number, length: number) => number) | undefined;
let pointer: ((v: ArrayBufferView) => number) | undefined;
if (typeof Bun !== "undefined" && process.platform === "linux") {
  try {
    const ffi = await import("bun:ffi");
    const lib = ffi.dlopen("libc.so.6", { getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" } });
    getsockopt = lib.symbols.getsockopt as unknown as typeof getsockopt;
    pointer = ffi.ptr as unknown as typeof pointer;
  } catch {
    getsockopt = undefined;
  }
}

/** True when this runtime and platform can read the peer's credentials. */
export const peerCredsAvailable = (): boolean => getsockopt !== undefined;

/** The peer of an accepted Unix socket, or undefined when it cannot be read. */
export function peerOf(fd: number): PeerCred | undefined {
  if (!getsockopt || !pointer) return undefined;
  const cred = new Int32Array(3); // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
  const size = new Uint32Array([cred.byteLength]);
  const rc = getsockopt(fd, SOL_SOCKET, SO_PEERCRED, pointer(cred), pointer(size));
  if (rc !== 0 || size[0] !== cred.byteLength) return undefined;
  return { pid: cred[0]!, uid: cred[1]!, gid: cred[2]! };
}

/** The parent of a process, from `/proc/<pid>/status`. Undefined when the process is gone or unreadable. */
export function parentOf(pid: number): number | undefined {
  try {
    const m = /^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `pid` through parent links. Reaching `self` means the peer is the program or below it. The walk
 * ends at pid 1 (or 0) with `other`. A process that is gone before the walk starts, or a broken link on the way,
 * is `unknown`: the caller must not read that as `other`.
 */
export function relationOf(pid: number, self: number = process.pid, parent: (p: number) => number | undefined = parentOf): Relation {
  if (pid === self) return "self";
  let cur = pid;
  for (let steps = 0; steps < 4096; steps++) {
    const up = parent(cur);
    if (up === undefined) return "unknown";
    if (up === self) return "descendant";
    if (up <= 1) return "other";
    cur = up;
  }
  return "unknown";
}
