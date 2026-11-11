// THE TRICK CONTRACT NUMBER: the one version of everything a trick and Collie exchange (the manifest
// keys, the facts on stdin, the output document, the places and the node kinds). A trick's
// `trick.toml` names the number it was written for (`contract = 1`, the default); the facts carry it
// (`"contract": 1`); the output's `"v"` is it. The bridge (through schema.ts), the CLI and the helper's
// tests read it from here, and the helper (cli/trick-kit/trick.ts, a self-contained file a trick folder
// copies) carries the same literal, held to this one by cli/trick-kit/trick.test.ts.
//
// WHAT MOVES IT. Inside one number Collie only adds: a new optional manifest key, a new facts field, a
// new node kind, place or attribute. A trick written for a newer Collie at the same number still runs on
// an older one, which leaves out what it does not know (schema.ts, "strict at write, tolerant at read").
// A change that a trick must answer (a field removed or renamed, a meaning changed) is the next number.
// A bridge refuses a trick that asks for a number above this one, naming both.
//
// THE NUMBERS. Contract 1 is the first. Contract 2 (M99) adds the manifest key `inputs`: files a trick
// reads from its agent sessions' folders, on every machine of a crew. A trick that leaves `contract` out
// is a contract 1 trick and runs exactly as before; the facts it gets say `"contract": 1`. A trick names
// `contract = 2` to use `inputs`, and its facts say 2. A document's `"v"` may be any number from 1 to
// this Collie's.

/** The newest trick contract this Collie speaks. */
export const TRICK_CONTRACT = 2;

/** The contract of a `trick.toml` that names none, and the one `collie trick init` writes. */
export const TRICK_CONTRACT_DEFAULT = 1;

/** The first contract that takes the manifest key `inputs`. */
export const INPUTS_CONTRACT = 2;
