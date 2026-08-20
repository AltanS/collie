// The tool search moved to `bridge/tools.ts` when the BRIDGE gained a reason to spawn `tailscale`:
// a machine that heals to `peer` takes its own managed front door down at boot (ADR 0001,
// `bridge/front-door.ts`), and it has to resolve that binary under systemd's minimal PATH exactly
// the way every CLI verb does. Two implementations that agree today are not that guarantee — and
// the bridge does not import from `cli/`, so the shared half lives on the bridge side.
//
// Nothing about the CLI's use of it moved: every existing caller keeps importing it from here.
export {
  fallbackDirs,
  findIn,
  findTool,
  isExecutableFile,
  searchDirs,
} from "../bridge/tools.ts";
