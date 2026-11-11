// THE NUMBERS THE BRIDGE KEEPS FOR TRICKS AND THE HILL, in one file with no node import.
//
// The tricks catalogue (`catalogue.ts`) names these numbers on the reference page, and it must load in
// the web app, the bridge, the CLI and the scripts alike. The bridge modules that own them import node
// built-ins, so the numbers live here and the bridge modules re-export them under their old names.
// Change a number here and every reader, the reference page included, moves with it.

import { HILL_GROUP_PARTS } from "../hill/wire";

// ── A run (bridge/tricks/run.ts, service.ts) ─────────────────────────────────────────────────

/** How long one run may take. */
export const RUN_TIMEOUT_MS = 10_000;
/** The most stdout a run may print. The document cap of the schema, so the parser never sees more. */
export const STDOUT_CAP_BYTES = 64 * 1024;
/** The most stderr kept for the error line. */
export const STDERR_CAP_BYTES = 8 * 1024;
/** The most trick programs running at once, across all tricks. */
export const RUNS_MAX = 4;
/** The most decision answers waiting for one trick. One more is refused as busy. */
export const HILL_QUEUE_MAX = 32;
/** The wait after the first, second and third failure in a row. The fourth stops the trick. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

/** The variables every program gets, when the bridge has them (bridge/tricks/env.ts). */
export const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "NVM_DIR",
  "BUN_INSTALL",
] as const;

// ── The approved copy and the skill file (bridge/tricks/approved.ts, cli/trick.ts) ──────────

/** The most files seeded into `media/` and `captures/` together. */
export const SEED_FILES_MAX = 500;
/** The most bytes seeded into `media/` and `captures/` together. */
export const SEED_BYTES_MAX = 64 * 1024 * 1024;
/** The most `collie trick skill <id>` reads and prints. A larger file is refused, never cut. */
export const SKILL_BYTES_MAX = 32 * 1024;

// ── Inputs (bridge/tricks/inputs.ts) ─────────────────────────────────────────────────────────

/** The most bytes of one text file an input reads. */
export const INPUT_TEXT_MAX_BYTES = 256 * 1024;
/** The most bytes of one picture (PNG, JPEG or WebP, sniffed off its bytes) an input reads. */
export const INPUT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** The most file bytes one answer carries (one member, every pane). */
export const INPUT_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
/** The most file bytes one run takes in all. */
export const INPUT_RUN_MAX_BYTES = 24 * 1024 * 1024;

// ── Proposals (bridge/tricks/propose-wire.ts, proposals.ts, card-group.ts) ───────────────────

/** Every cap of a proposal that the person-facing words name. The file and byte caps are `collie trick add`'s. */
export const PROPOSE_LIMITS = {
  files: 300,
  bytes: 5 * 1024 * 1024,
  /** Folder levels inside the trick's folder. */
  depth: 8,
  /** Characters of one relative path. */
  pathChars: 256,
  /** Bytes of one step of a path, the common file system limit. */
  stepBytes: 255,
} as const;

/** Open proposals one sender may have. */
export const PROPOSALS_SENDER_OPEN_MAX = 2;
/** Proposals one sender may make in an hour, replacements included. */
export const PROPOSALS_SENDER_HOUR_MAX = 6;
/** Open proposals from one crew machine, its sessions and its terminal together. */
export const PROPOSALS_MEMBER_OPEN_MAX = 4;
/** Proposals one crew machine may make in an hour, its sessions and its terminal together. */
export const PROPOSALS_MACHINE_HOUR_MAX = 12;
/** Open proposals on this lead. */
export const PROPOSALS_OPEN_MAX = 8;
/** How long a proposal card waits for an answer before it closes `expired` and its copy goes. */
export const PROPOSAL_EXPIRY_MS = 3 * 24 * 60 * 60_000;

/** Cards of code in a group: every card but card 1. */
export const GROUP_CODE_CARDS = HILL_GROUP_PARTS.max - 1;
/** Bytes of code text one card holds, as the view's JSON text counts them (a quote or a backslash twice). */
export const GROUP_CARD_CODE_BYTES = 6 * 1024;
/** The most code a group shows: {@link GROUP_CODE_CARDS} cards of {@link GROUP_CARD_CODE_BYTES}. */
export const GROUP_CODE_BYTES = GROUP_CODE_CARDS * GROUP_CARD_CODE_BYTES;
/** The most files a group shows; each needs its own diff, and card 1 lists them all. */
export const GROUP_FILES_MAX = 64;

// ── The Hill (bridge/hill/service.ts) ────────────────────────────────────────────────────────

/** The days a decision posted with no expiry stays open; `collie hill post --help` says so. */
export const HILL_DEFAULT_EXPIRY_DAYS = 14;
/** {@link HILL_DEFAULT_EXPIRY_DAYS} in milliseconds: a post with no `expiresAt` gets `at` plus this. */
export const HILL_DEFAULT_EXPIRY_MS = HILL_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
/**
 * The most days any decision stays open, a crew member's too: a later `expiresAt` is held to `at` plus
 * this (never refused, so a trick's long expiry still posts). `collie hill post --expires` refuses more.
 */
export const HILL_MAX_EXPIRY_DAYS = 30;
/** {@link HILL_MAX_EXPIRY_DAYS} in milliseconds. */
export const HILL_MAX_EXPIRY_MS = HILL_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
