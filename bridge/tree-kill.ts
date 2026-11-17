import { systemTool } from "./icacls.ts";

// THE WINDOWS TREE KILL: one module for every child Collie must end on Windows with all it started.
//
// Windows has no process group to kill by a negative pid, so the kill goes by PROCESS TREE:
// `taskkill /PID <pid> /T /F`, by its absolute `%SystemRoot%\System32` path and as argv, ends the
// child and every live process below it; then one PowerShell pass ends what the child left behind
// after it exited, found by parent pid and by a start time inside the child's own window (so a
// reused pid is never taken for ours). Both run in the background, each with a time limit, and
// never throw. The one gap: a process whose own parent had already exited, and was not the child
// itself, has no parent left to be found by.
//
// Never a bare `taskkill`: a bare name is looked up on PATH and in the current folder, and the
// current folder of a trick's run is the trick's own folder, so a trick could ship its own
// `taskkill.exe` and have the bridge run it. Never `spawnSync`: a kill that hangs must not hold the
// bridge. bridge/stt/local-cli.ts (a transcription command) and bridge/tricks/run.ts (a trick's
// program at its timeout or cap) both kill this way.

/** How long each of the two Windows kill programs may run before it is itself ended. */
export const WINDOWS_KILL_TIMEOUT_MS = 15_000;

/** Milliseconds since the epoch as a Windows FILETIME (100 ns ticks since 1601), for PowerShell. */
const fileTime = (ms: number): string => ((BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n).toString();

/**
 * The PowerShell pass that ends what the child left behind. One snapshot of the process table,
 * taken before anything is killed; from it, every process whose parent is `pid` and that started
 * between `fromMs` and the moment of the snapshot (the call's own window, so a process of a later
 * owner of a reused pid is never taken), then their children, and theirs, each started after its
 * parent. The upper bound is the snapshot's own time (review D, item 3): a process started after it
 * is not in the snapshot anyway, so no slack past it is needed. Numbers only are spliced in, so
 * nothing from the operator's settings or a trick reaches the script.
 */
export function windowsOrphanScript(pid: number, fromMs: number): string {
  return [
    `$from = [datetime]::FromFileTimeUtc(${fileTime(fromMs)}); $to = [datetime]::UtcNow`,
    "$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; At = $_.CreationDate.ToUniversalTime() } })",
    `$queue = New-Object System.Collections.Queue; $queue.Enqueue(@(${pid}, $from, $to)); $found = @{}`,
    "while ($queue.Count -gt 0) { $q = $queue.Dequeue(); foreach ($p in $all) { if ($p.Parent -eq $q[0] -and $p.At -ge $q[1] -and $p.At -le $q[2] -and -not $found.ContainsKey($p.Id)) { $found[$p.Id] = $true; $queue.Enqueue(@($p.Id, $p.At, [datetime]::MaxValue)) } } }",
    "foreach ($id in $found.Keys) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
}

/**
 * The two programs that end a Windows child's tree, as argv with absolute paths (never a PATH
 * lookup): `taskkill /T /F` for the live tree, then the orphan pass, bounded by the start of the
 * child (one second of slack before it) and the time of its own snapshot.
 */
export function windowsKillCommands(pid: number, startedAt: number, env: Readonly<Record<string, string | undefined>>): string[][] {
  return [
    [systemTool(env, "taskkill.exe"), "/PID", String(pid), "/T", "/F"],
    [
      systemTool(env, "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsOrphanScript(pid, startedAt - 1_000),
    ],
  ];
}

/** How a kill program is started: argv, no shell, no stdio, ended after `timeoutMs`. A seam for tests. */
export type KillSpawn = (argv: string[], opts: { readonly timeoutMs: number }) => { readonly exited: Promise<unknown> };

const bunKillSpawn: KillSpawn = (argv, opts) => Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: opts.timeoutMs });

/** What {@link windowsTreeKill} needs besides the pid. */
export interface TreeKillOptions {
  /** When the child was spawned, ms since the epoch: the orphan pass takes only processes started after it. */
  readonly startedAt: number;
  /** Where `SystemRoot` is read from, for the absolute paths. The bridge's own environment, never a trick's. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Kills the child itself; called right after taskkill, as the POSIX path kills the leader after its group. */
  readonly leader: () => void;
  readonly spawn?: KillSpawn;
  /**
   * The child has exited already. Then its pid may belong to a new process, and `taskkill /PID <pid> /T`
   * would end that process's tree: only the orphan pass runs, which takes a process by parent pid AND a
   * start time inside the child's window, so a new owner of the pid is never taken.
   */
  readonly exited?: boolean;
}

/**
 * Run {@link windowsKillCommands} one after the other, in the background, each with
 * {@link WINDOWS_KILL_TIMEOUT_MS}, and kill the child itself (`leader`) right after taskkill. Never
 * throws; the caller need not wait for the promise.
 */
export function windowsTreeKill(pid: number, opts: TreeKillOptions): Promise<void> {
  const spawn = opts.spawn ?? bunKillSpawn;
  const [taskkill, orphans] = windowsKillCommands(pid, opts.startedAt, opts.env);
  const run = async (argv: string[] | undefined): Promise<void> => {
    if (argv === undefined) return;
    try {
      await spawn(argv, { timeoutMs: WINDOWS_KILL_TIMEOUT_MS }).exited;
    } catch {
      /* no taskkill or no PowerShell: the child itself is still killed */
    }
  };
  if (opts.exited === true) return run(orphans).catch(() => {});
  return run(taskkill)
    .then(opts.leader)
    .then(() => run(orphans))
    .catch(() => {});
}
