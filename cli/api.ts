import { DECLARED, OPERATION_NAMES, type ArgDecl } from "../bridge/api/operations.ts";
import { EXIT, type Io } from "./io.ts";

// `collie api <operation>` (M105 spec 03, decision 19; spec 05, decision 6): the command face of the local
// API. EXPERIMENTAL: the shapes may change in a minor release.
//
// IT READS NOTHING IN THIS RELEASE. The local API answers a trick's own run: a connection is answered only
// after its `hello` names the run token the bridge put in that run's facts (ADR 0155). A person at a
// terminal holds no such token, so `collie api <operation>` prints ONE line, {@link RUN_ONLY}, to stderr and
// exits {@link EXIT.STATE}, the code of "no local API here for this caller". It dials nothing and looks at no
// file. A reader for a person's own scripts comes with the program key (M105 step three), a key a person
// makes on purpose.
//
// GENERATED, NOT WRITTEN. The help lists the operations, their flags and their help from the operation
// table's declarations (`DECLARED` in bridge/api/operations.ts): a row's name is the operation, each declared
// argument is a flag spelled in kebab case, and the summary and the argument help are the help text. So the
// help stays the table's list of what a trick may call with `t.api`.
//
// EXIT CODES:
//   0  EXIT.OK       `collie api` bare, or with `--help`: the help
//   2  EXIT.USAGE    an operation the table does not have
//   3  EXIT.STATE    any operation of the table: the one line, nothing read

/** The one line of `collie api <operation>` in this release (spec 05, decision 6). */
export const RUN_ONLY = "The local API answers a trick's own run in this release. A trick reads it with t.api.";

/** What the command face reads of one operation: the table's own declaration. */
export interface CliOperation {
  readonly name: string;
  readonly summary: string;
  readonly args: readonly ArgDecl[];
}

/** The operations of the table, in table order. */
export function declaredOperations(): readonly CliOperation[] {
  return OPERATION_NAMES.map((name) => DECLARED[name]);
}

export interface ApiDeps {
  readonly io: Io;
  /** The operations to offer. Default: the table's ({@link declaredOperations}); a test passes its own. */
  readonly operations?: readonly CliOperation[];
}

/** `lines` is spelled `--lines`; a camelCase name is spelled `--the-name`. */
export function flagOf(name: string): string {
  return `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

function valueWord(arg: ArgDecl): string {
  return arg.type === "integer" ? "<number>" : "<text>";
}

/** The generated help: what this is, then every operation with its flags. */
export function apiHelp(operations: readonly CliOperation[]): string[] {
  const width = Math.max(...operations.map((one) => one.name.length)) + 2;
  const lines = [
    "usage: collie api <operation> [flags] [--json]",
    "",
    "Experimental: the shapes of the local API may change in a minor release.",
    "The local API is on while tricks are switched on, and it only reads.",
    "It answers a trick's own run in this release: a trick reads it with t.api in its helper.",
    "",
  ];
  for (const one of operations) {
    lines.push(`  ${one.name.padEnd(width)}${one.summary}`);
    for (const arg of one.args) {
      const flag = `${flagOf(arg.name)} ${valueWord(arg)}`;
      lines.push(`  ${"".padEnd(width)}  ${flag}  ${arg.required ? "(required) " : ""}${arg.help}`);
    }
  }
  lines.push("", `  ${"--json".padEnd(width)}print the answer line as the bridge sent it`);
  return lines;
}

/** `collie api`, bare or `--help`: the operations. */
export function cmdApiHelp(deps: ApiDeps): number {
  for (const line of apiHelp(deps.operations ?? declaredOperations())) deps.io.out(line);
  return EXIT.OK;
}

/** `api <operation> ...`: in this release, the one line and {@link EXIT.STATE}; nothing is read (see the header). */
export function cmdApi(deps: ApiDeps, argv: readonly string[]): number {
  const operations = deps.operations ?? declaredOperations();
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") return cmdApiHelp(deps);
  if (!operations.some((one) => one.name === first)) {
    deps.io.err(`error: unknown operation \`${first}\``);
    deps.io.err(`usage: collie api {${operations.map((one) => one.name).join("|")}} [flags] [--json]`);
    return EXIT.USAGE;
  }
  deps.io.err(RUN_ONLY);
  return EXIT.STATE;
}
