// The composer's attachments for ONE pane: the chip list and the upload flow (ADR 0060). A port of the
// attachment half of web/src/components/composer.tsx, as a controller with no component state. The
// pure grammar (markers, accept lists, refusals, the line Send types) is web/'s own
// `@web/lib/attachments`, reused read-only; this file is the part that was React state there.
//
// AN ATTACHMENT IS A CHIP AND ITS MARKER HOLDS ITS PLACE. The draft carries `[Image #N]` or
// `[File #N]` where the caret stood, the chip row shows what each one is, and `resolve()` swaps each
// marker for its host path at Send. A chip whose marker the operator deleted by hand is not lost: its
// path goes in front of the words (`composeLine`), and the chip says so before Send
// (`isMarkerMissing`).
//
// THE TWO LOCAL REFUSALS ARE AN ECONOMY, NEVER A GATE. The bridge asks the same two questions again on
// arrival and its answer counts (it can read the bytes). Spending a phone's uplink on 40 MB to be told
// 10 is the limit is the thing worth not doing.
//
// What differs from web/: a chip exists from the moment its upload starts, in state `uploading`, so
// the row shows the work (web/ spun the attach button instead). Its number is taken then and its
// marker lands in the draft only on success, at the caret, so a picked batch lays its markers down in
// pick order. A failed upload leaves no chip and no marker, as in web/; its number is given back when
// it was the newest.
import {
  acceptAttribute,
  attachmentKind,
  composeLine,
  limitMb,
  markerFor,
  offersFiles as limitsOfferFiles,
  PHOTO_ACCEPT,
  rejectAttachment,
  uploadLimits,
} from "@web/lib/attachments";
import { uploadFile } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import type { DraftAttachment } from "@web/lib/drafts";
import { t } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import type { BridgeConfig, UploadCapability, UploadResponse } from "@web/lib/types";

import { bridgeWrite, writeRefusal } from "../chips/writes";
import { config } from "../lib/data";
import { setStatus } from "../lib/status";
import { createStore, type Store } from "../lib/store";

export { PHOTO_ACCEPT };

export interface PendingAttachment {
  /** Unique for the page's life, so a late upload can never land on a newer chip with the same number. */
  id: string;
  kind: "image" | "file";
  name: string;
  /** `[Image #N]` or `[File #N]`: what the draft carries in the chip's place. */
  marker: string;
  /** The host path the bridge saved it under. Set once `state` is `ready`. */
  path?: string;
  /**
   * `failed` is part of the shape, but this controller never leaves one in the list: like web/, a
   * failed upload is a status line and no chip.
   */
  state: "uploading" | "ready" | "failed";
  /** The `N` of the marker. */
  n?: number;
  /** A blob URL for an image picked in this page session. A restored chip has none and draws a tile. */
  previewUrl?: string;
}

/** Everything the controller reaches outside itself for, so a test can stand in for the network. */
export interface AttachmentOptions {
  /** Revokes previews when it aborts: pass the route's `handle.signal`. */
  signal?: AbortSignal;
  /** Default: `uploadFile` from web/'s api. */
  uploader?: (paneId: string, file: File, scope: Scope | undefined) => Promise<UploadResponse>;
  /** Default: the bridge's published `upload` block from the config store. */
  limits?: () => UploadCapability | undefined;
  /** Default: `writeRefusal` (read-only device, not paired). A string refuses the add. */
  refusal?: () => string | undefined;
  /** Default: object URLs where the browser has them. */
  preview?: { create(file: File): string | undefined; revoke(url: string): void };
}

export interface Attachments {
  readonly list: Store<readonly PendingAttachment[]>;
  /**
   * Validate, upload and chip each file in turn. `insert` receives the marker once its upload
   * succeeds; the composer places it at the caret (`insertMarker` from `@web/lib/attachments`).
   * Never rejects: every refusal and failure is published through `setStatus`.
   */
  add(files: FileList | readonly File[], insert: (marker: string) => void): Promise<void>;
  /** The chip's x: the chip goes, and `removeMarker` is asked to take its marker out of the draft. */
  remove(id: string, removeMarker: (marker: string) => void): void;
  /** The line Send types: each marker becomes its path (`composeLine`). Chips still uploading are not in it. */
  resolve(text: string): string;
  /** After a verified send or the belt's X: every chip and preview goes, and numbering restarts at 1. */
  clear(): void;
  /** True while any upload is in flight. The composer holds Send and a self-update reload on it. */
  uploading(): boolean;
  /** The stored shape of the ready chips (`saveDraft`'s `attachments` and `next`). */
  snapshot(): { attachments: DraftAttachment[]; next: number };
  /** Put a stored draft's chips back (`loadDraftEntry`). They draw as tiles, with no preview. */
  restore(attachments: readonly DraftAttachment[], next: number): void;
}

/** The picker's `accept` for the full list, off what the bridge says it takes. */
export function fileAccept(cfg: BridgeConfig | undefined): string {
  return acceptAttribute(uploadLimits(cfg?.upload ?? null));
}

/** Whether the attach button ASKS (photos or files). False on a host that takes images and nothing else. */
export function offersFiles(cfg: BridgeConfig | undefined): boolean {
  return limitsOfferFiles(uploadLimits(cfg?.upload ?? null));
}

/** Whether the chip's marker is gone from the draft, so Send will put its path in front of the words. */
export function isMarkerMissing(text: string, attachment: PendingAttachment): boolean {
  return attachment.state === "ready" && !text.includes(attachment.marker);
}

const browserPreview: NonNullable<AttachmentOptions["preview"]> = {
  create(file) {
    if (!("createObjectURL" in URL)) return undefined;
    try {
      return URL.createObjectURL(file);
    } catch {
      return undefined;
    }
  },
  revoke(url) {
    if ("revokeObjectURL" in URL) URL.revokeObjectURL(url);
  },
};

let nextId = 1;

export function createAttachments(
  paneId: string,
  scope: Scope | undefined,
  options: AttachmentOptions = {},
): Attachments {
  const upload = options.uploader ?? uploadFile;
  const currentLimits = options.limits ?? ((): UploadCapability | undefined => config.get().data?.upload);
  const refusalNow = options.refusal ?? writeRefusal;
  const preview = options.preview ?? browserPreview;
  const list = createStore<readonly PendingAttachment[]>([]);
  // Numbers are never reused inside a draft (a removed chip keeps its number spent), so this outlives
  // a removed chip. Only `clear()` takes it back to 1.
  let next = 1;

  const revoke = (entry: PendingAttachment): void => {
    if (entry.previewUrl !== undefined) preview.revoke(entry.previewUrl);
  };
  const find = (id: string): PendingAttachment | undefined => list.get().find((entry) => entry.id === id);
  const replace = (id: string, change: (entry: PendingAttachment) => PendingAttachment): void =>
    list.update((entries) => entries.map((entry) => (entry.id === id ? change(entry) : entry)));

  options.signal?.addEventListener("abort", () => list.get().forEach(revoke), { once: true });

  /** Returns after one file is done, so a batch uploads in pick order. */
  async function addOne(file: File, insert: (marker: string) => void): Promise<void> {
    const blocked = refusalNow();
    if (blocked !== undefined) {
      setStatus(blocked, "error");
      return;
    }
    const limits = uploadLimits(currentLimits() ?? null);
    const refusal = rejectAttachment(file, limits);
    if (refusal === "tooLarge") {
      setStatus(t("composer.upload.tooLarge", { max: limitMb(limits) }), "error");
      return;
    }
    if (refusal === "badType") {
      setStatus(t("composer.upload.badType", { name: file.name }), "error");
      return;
    }
    const n = next++;
    const kind = attachmentKind(file, limits);
    const pending: PendingAttachment = {
      id: `att-${nextId++}`,
      n,
      kind,
      name: file.name,
      marker: markerFor({ n, kind }),
      state: "uploading",
    };
    const url = kind === "image" ? preview.create(file) : undefined;
    if (url !== undefined) pending.previewUrl = url;
    list.update((entries) => [...entries, pending]);

    const giveUp = (): void => {
      revoke(pending);
      list.update((entries) => entries.filter((entry) => entry.id !== pending.id));
      if (next === n + 1) next = n;
    };

    let res: UploadResponse;
    try {
      res = await bridgeWrite(() => upload(paneId, file, scope));
    } catch (error) {
      if (find(pending.id) === undefined) return; // removed or cleared mid-flight: nobody is waiting
      giveUp();
      setStatus(describeThrownError(error), "error");
      return;
    }
    // The chip's x, a send's clear, or the pane being left may have run while the bytes were in flight.
    // The file stays on the host and nothing in the draft points at it.
    if (find(pending.id) === undefined) return;
    if (!res.ok) {
      giveUp();
      setStatus(describeApiError(res), "error");
      return;
    }
    replace(pending.id, (entry) => ({ ...entry, path: res.path, state: "ready" }));
    insert(pending.marker);
    setStatus(t("composer.upload.success"), "success");
  }

  return {
    list,
    async add(files, insert) {
      for (const file of Array.from(files)) {
        if (options.signal?.aborted) return;
        await addOne(file, insert);
      }
    },
    remove(id, removeMarker) {
      const entry = find(id);
      if (entry === undefined) return;
      revoke(entry);
      list.update((entries) => entries.filter((e) => e.id !== id));
      // An uploading chip has no marker in the draft yet; a hand-typed look-alike must be left alone.
      if (entry.state === "ready") removeMarker(entry.marker);
    },
    resolve(text) {
      const ready = list
        .get()
        .flatMap((entry) =>
          entry.state === "ready" && entry.path !== undefined && entry.n !== undefined
            ? [{ n: entry.n, path: entry.path, kind: entry.kind }]
            : [],
        );
      return composeLine(text, ready);
    },
    clear() {
      list.get().forEach(revoke);
      list.set([]);
      next = 1;
    },
    uploading: () => list.get().some((entry) => entry.state === "uploading"),
    snapshot() {
      const attachments = list
        .get()
        .flatMap((entry) =>
          entry.state === "ready" && entry.path !== undefined && entry.n !== undefined
            ? [{ n: entry.n, path: entry.path, name: entry.name, kind: entry.kind }]
            : [],
        );
      return { attachments, next };
    },
    restore(attachments, restoredNext) {
      list.get().forEach(revoke);
      list.set(
        attachments.map((a) => {
          const entry: PendingAttachment = {
            id: `att-${nextId++}`,
            n: a.n,
            kind: a.kind,
            name: a.name,
            marker: markerFor(a),
            path: a.path,
            state: "ready",
          };
          return entry;
        }),
      );
      next = Math.max(restoredNext, 1, ...attachments.map((a) => a.n + 1));
    },
  };
}
