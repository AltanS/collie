// The environment of a self-hosted run, set before durable-harness reads it. Import this file first.
// Erasable TypeScript only, so Node 24 runs it as it is.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// World-local keeps the whole log in a folder. Two programs that share the folder share the sessions.
// Left out, the folder is `.workflow-data` next to this example, whatever the working directory is.
process.env.WORKFLOW_LOCAL_DATA_DIR ??= fileURLToPath(new URL("../.workflow-data", import.meta.url));
process.env.WORKFLOW_TARGET_WORLD ??= "local";

/** The folder of the World's log. */
export const DATA_DIR: string = process.env.WORKFLOW_LOCAL_DATA_DIR;
/** Where the `ship` tool writes: beside the log, so one folder holds everything a run made. */
export const SHIPPED_FILE: string = `${dirname(DATA_DIR)}/shipped.txt`;
