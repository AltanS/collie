// A Bun-accepted Unix socket as a Duplex stream, so `node:http` can serve it (`server.emit("connection", conn)`).
// The reason to accept with `Bun.listen` and not `server.listen`: only a `Bun.listen` socket has an fd, and the fd
// is the way to the peer's credentials (peer.ts). The connection carries who the peer is.

import { Duplex } from "node:stream";
import { type PeerCred, peerOf, type Relation, relationOf } from "./peer.ts";

type BunSocket = import("bun").Socket<Conn>;

export class Conn extends Duplex {
  readonly peer?: PeerCred;
  /** The peer against the program's own pid, read once when the connection opens. */
  readonly relation: Relation;
  private out?: Buffer;
  private at = 0;
  private done?: (e?: Error | null) => void;

  constructor(private readonly sock: BunSocket) {
    super({ allowHalfOpen: true });
    // SAFETY: Bun puts the accepted connection's `fd` on every socket `Bun.listen` hands over; its types do not declare it yet.
    this.peer = peerOf((sock as BunSocket & { fd: number }).fd);
    this.relation = this.peer ? relationOf(this.peer.pid) : "unknown";
  }

  // Bytes in from the peer. A full buffer pauses the socket until the reader asks again.
  feed(chunk: Uint8Array) {
    if (!this.push(Buffer.from(chunk))) this.sock.pause();
  }
  _read() {
    this.sock.resume();
  }
  finish() {
    this.push(null);
  }

  // Bytes out. `socket.write` may take part of a chunk; the rest waits for `drain`.
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    this.out = chunk;
    this.at = 0;
    this.done = cb;
    this.drain();
  }
  drain() {
    while (this.out) {
      this.at += this.sock.write(this.out.subarray(this.at));
      if (this.at < this.out.length) return;
      const cb = this.done;
      this.out = undefined;
      this.done = undefined;
      cb?.();
    }
  }
  _final(cb: (e?: Error | null) => void) {
    this.sock.end();
    cb();
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.sock.end();
    cb(err);
  }

  // What `node:http` calls on a socket. A Unix connection has no use for any of them.
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
