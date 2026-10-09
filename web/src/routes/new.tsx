import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { ArrowLeft, History, Server } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { RouteHeader } from "@/components/app-header";
import { useCrew } from "@/components/crew-provider";
import { CommandPicker } from "@/components/new-command-picker";
import { FolderSections } from "@/components/new-space-folders";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { StatusArea } from "@/components/status-area";
import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { OneOf } from "@/components/ui/one-of";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { BandMain } from "@/components/ui/strip-host";
import { Switch } from "@/components/ui/switch";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useNoPromptsGuard } from "@/hooks/use-no-prompts-guard";
import { useSpaceActions } from "@/hooks/use-spaces";
import { checkRun, clearRecentRuns, planWorktree, removeRecentRun, type StartWhat } from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { paneBranchName, startFromChoices } from "@/lib/branch-off";
import { useFolders } from "@/lib/folders";
import { writeRefusal } from "@/lib/host-health";
import { HOST_TEXT_CLASSES, hostSlot, isMultiHost, leadHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { launchersKey, useLaunchers } from "@/lib/launchers";
import { mutate } from "@/lib/mutate";
import { useMuxCapability } from "@/lib/mux-capability";
import { homePath, newAddPath, readNewAt } from "@/lib/nav";
import {
  NEW_PAGE_DOCS,
  agentChoice,
  MAX_RUN_CHARS,
  commandOptions,
  branchAllowed,
  commandChoice,
  commandKey,
  defaultHost,
  defaultKind,
  folderShown,
  itemOf,
  keyToWhat,
  kindOf,
  kindOfKey,
  machineWord,
  memberHealth,
  offerFor,
  offered,
  optionText,
  pickOfKey,
  readAgain,
  readKind,
  rememberAgain,
  rememberKind,
  startFingerprint,
  summaryKey,
  summaryWhat,
  unavailableText,
  whatFor,
  whatKey,
  whatLabel,
  type CommandPick,
  type Kind,
  type Offer,
  type SummaryParts,
  type Unavailable,
} from "@/lib/new-page";
import { useHoldReload } from "@/lib/reload-guard";
import { useRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import { shortenHome } from "@/lib/shorten-home";
import type { WorktreeBaseChoice, WorktreeFolderChoice, WorktreePlanResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { branchOffName, mintRequestId } from "@/lib/worktree-name";

// THE NEW PAGE (M48 spec 01, card 4.3; a page since 1.19.0, it was a bottom sheet before). One screen
// at `/new`, built like a Settings page: the app header with a back arrow, one scrolling column, and
// Start pinned to the foot. From the top: the machine (a crew only), Again, what to start (Agent or
// Shell, one select each; the Command select also holds the machine's Recent one-off lines and
// "Type a command…", ADR 0095), the folder, the "New worktree" switch, and at the foot one line that
// says what Start will do, then Start.
//
// WHERE IT WAS OPENED FROM RIDES IN THE ADDRESS, so a reload keeps it: `?machine=` is the crew member
// it opens on, `?pane=` is the pane whose folder and branch a worktree starts from (a pane's ⋯ "New
// agent in a worktree"), and `?s=` is that pane's named session. The page reads the pane off the root
// snapshot, so it needs no router state.
//
// The lists come from the chosen machine's bridge (ADR 0091): the web app keeps no list of agent
// names. An item that cannot run there is never hidden; it stays in its select, disabled, with its
// reason in brackets after the name. Every appearance in flow is a Collapse (DESIGN.md §1), because
// the answers arrive after the page opened.
//
// THE BODY IS KEYED BY THE ADDRESS, so a different `?machine=` or `?pane=` starts from its own
// defaults (Again, the pane) and a half-typed field never leaks into the next one.
export function NewRoute() {
  const { search } = useLocation();
  useLocale();
  useHoldReload("new-page", true);
  return <NewPage key={search} search={search} />;
}

function NewPage({ search }: { search: string }) {
  useLocale();
  const nav = useNav();
  const data = useRootData();
  const at = useMemo(() => readNewAt(search), [search]);
  const asked: Scope = { host: at.machine, session: at.session };
  const { start, creatingSpace } = useSpaceActions();
  // A pane's own folder and branch, read off the snapshot. A pane that is gone leaves the plain page.
  const paneAgent =
    at.pane === undefined ? undefined : [...data.agents, ...data.shellPanes].find((a) => a.paneId === at.pane);
  const from = paneAgent === undefined ? undefined : { cwd: paneAgent.cwd, branch: paneBranchName(paneAgent) };

  // ── Which machine ─────────────────────────────────────────────────────────────────────────────
  const { servers, health } = useCrew();
  const multiHost = isMultiHost(servers);
  const lead = leadHost(servers);
  // A page opened from a pane stays on that pane's machine: a worktree is the lead's (ADR 0089).
  const [host, setHost] = useState<string | undefined>(() =>
    from !== undefined ? (asked.host ?? lead) : defaultHost(servers, health, asked.host),
  );
  const chosen = multiHost ? host : undefined;
  const chosenServer = servers.find((s) => s.id === chosen);
  const refusal = chosenServer ? writeRefusal(memberHealth(health, chosenServer)) : undefined;
  const target: Scope = multiHost ? { ...asked, host: chosen === lead ? undefined : chosen } : asked;
  const machineName = multiHost ? chosenServer?.name || chosen : undefined;
  const leadName = servers.find((s) => s.id === lead)?.name || lead || "";
  // Again's key: the machine's id on a crew, "" on a solo install.
  const machineKey = chosen ?? "";

  // ── What this machine offers ──────────────────────────────────────────────────────────────────
  const launchers = useLaunchers(target);
  const loaded = launchers.loadedFor === launchersKey(target);
  // Worktrees are the lead's alone, so the lead's multiplexer is the one asked.
  const canWorktree = useMuxCapability("createWorktree").capable;
  const offer: Offer = offerFor({
    harnesses: loaded ? launchers.harnesses : null,
    items: loaded ? launchers.items : null,
    loaded,
    rows: loaded ? launchers.launchers : [],
    // One-off runs (ADR 0095): only a bridge that reports `adding.run` has them to offer.
    run: loaded ? launchers.adding?.run : undefined,
    recentRuns: loaded ? (launchers.recentRuns ?? null) : null,
    refusal,
    canWorktree,
    memberChosen: multiHost && chosen !== lead ? { lead: leadName } : undefined,
  });
  const home = loaded ? launchers.home : "";
  const { folders, star } = useFolders(target, true);
  const again = useMemo(() => readAgain(machineKey), [machineKey]);
  // Again counts only while the machine still offers what it started, and (for a worktree) can still make one.
  const usable = again !== null && loaded && offered(offer, again.what) ? again : null;
  const againOffered = usable !== null && (usable.branch === null || offer.branchBlocked === null);

  // ── The form ──────────────────────────────────────────────────────────────────────────────────
  // Agent or Command is a segment; each half keeps its own pick, so going back and forth loses neither.
  const rememberedKind = useMemo(() => readKind(machineKey), [machineKey]);
  const [kindPick, setKindPick] = useState<Kind | null>(null);
  // `?pick=` is where "Add your own" sends the person back to: the row it just made, chosen. It only
  // stands in for a pick the person has not made on this page.
  const kind = kindPick ?? kindOfKey(offer, at.pick) ?? defaultKind(offer, loaded, rememberedKind, again);
  const [agentPick, setAgentPick] = useState<string | null>(null);
  const [commandPick, setCommandPick] = useState<CommandPick | null>(null);
  // The line in the "Type a command…" field. Kept when the select moves away and back.
  const [typedLine, setTypedLine] = useState("");
  const agentItem = agentChoice(offer, agentPick ?? at.pick ?? null, usable);
  const command = commandChoice(offer, commandPick ?? keyToWhat(at.pick), usable);
  const what: StartWhat | null = whatFor(kind, agentItem, command, typedLine);
  const chosenItem = what === null ? undefined : itemOf(offer, what);
  const [cwd, setCwd] = useState(() => from?.cwd ?? readAgain(machineKey)?.cwd ?? "");
  // Whether the person changed the Folder field on this visit. A Recent pick fills the folder with the
  // entry's own, but never over a folder the person chose.
  const cwdTouched = useRef(false);
  function editCwd(next: string) {
    cwdTouched.current = true;
    setCwd(next);
  }
  // A tap on a Favourite or Recent folder fills the field and moves on to Start, as the sheet did:
  // the field is done, and on a phone the keyboard goes away. After the render, so Start is enabled.
  const startButton = useRef<HTMLButtonElement>(null);
  // Counted, not keyed on the folder: a tap on the folder already in the field changes no value.
  const [folderTaps, setFolderTaps] = useState(0);
  function pickFolder(next: string) {
    editCwd(next);
    setFolderTaps((n) => n + 1);
  }
  useEffect(() => {
    if (folderTaps > 0) startButton.current?.focus({ preventScroll: true });
  }, [folderTaps]);
  const pinned = chosenItem?.cwd;
  // A machine older than 1.19.0 ignores a folder on a row, so it is not offered there.
  const legacy = loaded && !offer.shellById;
  const showWhere = pinned === undefined && !(legacy && what?.kind === "row");

  const [branchOn, setBranchOn] = useState(from !== undefined);
  const [branchName, setBranchName] = useState(() => branchOffName());
  const [basePick, setBasePick] = useState<"default" | "branch" | null>(null);
  const [folderPick, setFolderPick] = useState<WorktreeFolderChoice["kind"] | null>(null);
  const [parentPick, setParentPick] = useState<string | null>(null);
  // The worktree block shows for anything chosen. A command row or a one-off line cannot start in
  // one: the switch is off and disabled there, and its reason line says so. "Type a command…" shows it
  // before the first character, so typing moves nothing.
  const branchShown = what !== null || (kind === "shell" && command.kind === "typed");
  const branchBlocked: Unavailable | null =
    offer.branchBlocked ?? (branchAllowed(offer, what) ? null : { kind: "commandRow" });
  const branchActive = branchShown && branchBlocked === null && branchOn;

  // ── The plan: what the bridge says a branch from this folder would be (ADR 0093) ─────────────
  const [plan, setPlan] = useState<{ key: string; answer: WorktreePlanResponse } | null>(null);
  const remembered = plan?.answer.ok === true ? plan.answer.remembered : undefined;
  const folderKind = folderPick ?? remembered?.folder ?? "default";
  const parent = parentPick ?? remembered?.parent ?? "";
  const planCwd = cwd.trim() === "" ? "~" : cwd.trim();
  const planKey = JSON.stringify([planCwd, branchName.trim(), folderKind === "parent" ? parent.trim() : ""]);
  const targetHost = target.host;
  const targetSession = target.session;
  const planBranch = branchName.trim();
  const planParent = folderKind === "parent" ? parent.trim() : undefined;
  useEffect(() => {
    if (!branchActive) return;
    let live = true;
    // A short wait so a word typed in the field asks once, not once per letter.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const answer = await planWorktree(
            { cwd: planCwd, branch: planBranch, parent: planParent },
            { host: targetHost, session: targetSession },
          );
          if (live) setPlan({ key: planKey, answer });
        } catch {
          // A failed read is no answer: the create checks everything again anyway.
        }
      })();
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [branchActive, planKey, planCwd, planBranch, planParent, targetHost, targetSession]);
  const current = plan !== null && plan.key === planKey ? plan.answer : null;
  const okPlan = current?.ok === true ? current : null;
  const startChoices = okPlan === null ? null : startFromChoices(okPlan.currentBranch, okPlan.defaultBranch);
  const baseShown: "default" | "branch" =
    basePick ?? (from !== undefined || remembered?.base === "current" ? "branch" : "default");
  const base: WorktreeBaseChoice =
    startChoices !== null && baseShown === "branch" ? { kind: "ref", ref: startChoices.paneBranch } : { kind: "default" };
  const baseName =
    startChoices !== null && baseShown === "branch"
      ? startChoices.paneBranch
      : (okPlan?.defaultBranch ?? okPlan?.currentBranch ?? t("newPage.branch.head"));
  const folderChoice: WorktreeFolderChoice =
    folderKind === "parent" ? { kind: "parent", parent: parent.trim() } : { kind: "default" };

  // What stops a branch Start, in the bridge's own words where it gave some.
  let branchProblem: string | null = null;
  let targetPath: string | null = null;
  if (branchActive && current !== null) {
    if (!current.ok) branchProblem = describeApiError(current);
    else if (current.branchValid === false) branchProblem = t("newPage.branch.badName");
    else if (folderKind === "parent" && current.parentTarget !== undefined) {
      if (current.parentTarget.ok) targetPath = current.parentTarget.path;
      else branchProblem = describeApiError(current.parentTarget);
    } else if (folderKind === "default" && current.defaultTarget !== undefined) {
      targetPath = current.defaultTarget.path;
      if (current.defaultTarget.exists) {
        branchProblem = t("apiError.worktree.target_exists", { path: shortenHome(current.defaultTarget.path, home) });
      }
    }
  }
  if (branchActive && branchName.trim() === "") branchProblem = t("apiError.worktree.branch_required");
  if (branchActive && folderKind === "parent" && parent.trim() === "") branchProblem = t("apiError.worktree.folder_invalid");


  // ── The summary line ──────────────────────────────────────────────────────────────────────────
  const shownWhat = what === null ? "" : summaryWhat(what, offer, t("newPage.shell"));
  // The FULL path the bridge will use: a name with no leading / or ~ is a folder under home, and the
  // line says so before Start, so nothing is rewritten silently.
  const folderText = shortenHome(pinned ?? folderShown(cwd, home), home);
  const parts: SummaryParts = { what: shownWhat, folder: folderText };
  if (machineName !== undefined) parts.machine = machineName;
  if (branchActive) parts.branch = { name: branchName.trim(), base: baseName };
  const summary =
    what === null
      ? ""
      : t(`newPage.summary.${summaryKey(parts)}`, {
          what: parts.what,
          folder: parts.folder,
          machine: parts.machine ?? "",
          branch: parts.branch?.name ?? "",
          base: parts.branch?.base ?? "",
        });

  // ── Start ─────────────────────────────────────────────────────────────────────────────────────
  // One request id per ask, kept by a retry of the SAME ask so a lost reply lands on its receipt
  // (ADR 0091); any change to the ask mints a new one.
  const requestId = useRef("");
  const lastAsk = useRef<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "unknown">("idle");
  // A typed line is checked (a read) before the first run, so the no-prompts confirm can come first.
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  // Why the last Start was refused, kept with the ask it belongs to: a different ask shows nothing.
  const [startRefusal, setStartRefusal] = useState<{ print: string; message: string } | null>(null);
  const startingRef = useRef(false);
  const fingerprint =
    what === null
      ? ""
      : startFingerprint({
          machine: machineKey,
          what,
          cwd: showWhere ? cwd.trim() : "",
          branch: branchActive ? { name: branchName.trim(), base: JSON.stringify(base), folder: folderChoice } : null,
        });
  const retrying = phase === "unknown" && lastAsk.current === fingerprint;
  const blocked = what === null || refusal !== undefined || !loaded || branchProblem !== null;

  /** Start `ask`. On `done` the phone has already moved to the new pane (`useSpaceActions`), so the page just remembers it. */
  async function run(ask: { what: StartWhat; cwd: string; branch: boolean }, print: string) {
    if (startingRef.current) return;
    startingRef.current = true;
    if (lastAsk.current !== print) requestId.current = mintRequestId();
    lastAsk.current = print;
    setStartRefusal(null);
    setPhase("starting");
    const sendCwd = ask.cwd === "" ? undefined : ask.cwd;
    const outcome = await start(
      {
        what: ask.what,
        cwd: sendCwd,
        requestId: requestId.current,
        legacyShell: legacy,
        branch: ask.branch ? { cwd: ask.cwd === "" ? "~" : ask.cwd, name: branchName.trim(), base, folder: folderChoice } : undefined,
      },
      multiHost ? target : undefined,
    );
    startingRef.current = false;
    if (outcome.kind === "done") {
      rememberAgain(machineKey, {
        what: ask.what,
        label: whatLabel(ask.what, offer, t("newPage.shell")),
        // A row with a fixed folder remembers none: Again runs it where the operator pinned it.
        cwd: itemOf(offer, ask.what)?.cwd !== undefined ? null : (sendCwd ?? null),
        branch: ask.branch ? { folder: folderChoice } : null,
        at: Date.now(),
      });
      rememberKind(machineKey, kindOf(ask.what, offer));
      setPhase("idle");
      return;
    }
    if (outcome.kind === "refused" && outcome.message !== "") setStartRefusal({ print, message: outcome.message });
    setPhase(outcome.kind === "unknown" ? "unknown" : "idle");
  }

  // EVERY START GOES THROUGH HERE (ADR 0094): Start, and the Again row. An item that skips permission
  // prompts is confirmed once per device, machine and line before anything is sent; the other launch
  // paths (the dashboard's Launch strip, the switcher's) use the same guard. A one-off line has no row
  // to say whether it skips prompts: a history entry carries the bridge's answer from its first run, and
  // a typed line gets it from `checkRun` (`known`), asked BEFORE the first run (ADR 0095, amendment).
  const { guard, sheet: noPromptsSheet } = useNoPromptsGuard();
  function begin(ask: { what: StartWhat; cwd: string; branch: boolean }, print: string, known?: { noPrompts: boolean }) {
    const item = itemOf(offer, ask.what);
    guard({
      item:
        ask.what.kind === "run"
          ? { noPrompts: known?.noPrompts ?? item?.noPrompts ?? false, command: ask.what.line }
          : (item ?? {}),
      // `""` for the lead or a solo install, the member's id otherwise: the same key on every path.
      machine: target.host ?? "",
      folder: shortenHome(item?.cwd ?? folderShown(ask.cwd, home), home),
      go: () => void run(ask, print),
    });
  }

  /** A typed line: ask the machine what it is (a read), then the same guard as every other start. */
  async function checkThenBegin(ask: { what: StartWhat; cwd: string; branch: boolean }, print: string) {
    if (ask.what.kind !== "run" || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setStartRefusal(null);
    let answer: Awaited<ReturnType<typeof checkRun>>;
    try {
      answer = await checkRun(ask.what.line, target);
    } catch (e) {
      checkingRef.current = false;
      setChecking(false);
      setStartRefusal({ print, message: describeThrownError(e) });
      return;
    }
    checkingRef.current = false;
    setChecking(false);
    if (answer.problem !== undefined) {
      // The refusal a run of this line would get, said in the same place.
      const detail = { problem: answer.problem, max: MAX_RUN_CHARS };
      setStartRefusal({ print, message: describeApiError({ code: "launch.bad_line", detail }) });
      return;
    }
    begin(ask, print, { noPrompts: answer.noPrompts });
  }

  function startNow() {
    if (blocked || what === null || busy) return;
    const ask = { what, cwd: showWhere ? cwd.trim() : "", branch: branchActive };
    if (command.kind === "typed" && kind === "shell") void checkThenBegin(ask, fingerprint);
    else begin(ask, fingerprint);
  }

  /** Again: a plain start runs at once; a worktree start fills the form with a fresh name. */
  function useAgain() {
    if (again === null || busy) return;
    setKindPick(kindOf(again.what, offer));
    let typedAgain = false;
    if (kindOf(again.what, offer) === "agent") setAgentPick(whatKey(again.what));
    else if (again.what.kind === "run" && !offer.recent.some((r) => r.key === whatKey(again.what) && r.unavailable === null)) {
      // A line the history no longer holds comes back through the field, and is checked like any typed line.
      typedAgain = true;
      setCommandPick({ kind: "typed" });
      setTypedLine(again.what.line);
    } else setCommandPick(again.what);
    setCwd(again.cwd ?? "");
    if (again.branch !== null) {
      setBranchOn(true);
      setBranchName(branchOffName());
      setFolderPick(again.branch.folder.kind);
      if (again.branch.folder.kind === "parent") setParentPick(again.branch.folder.parent);
      return;
    }
    const print = startFingerprint({ machine: machineKey, what: again.what, cwd: again.cwd ?? "", branch: null });
    const ask = { what: again.what, cwd: again.cwd ?? "", branch: false };
    if (typedAgain) void checkThenBegin(ask, print);
    else begin(ask, print);
  }

  function chooseKind(next: Kind) {
    setKindPick(next);
    rememberKind(machineKey, next);
  }

  /** A Recent pick: the line starts as it is, and its folder fills the field unless the person set one. */
  function chooseCommand(key: string) {
    setCommandPick(pickOfKey(offer, key));
    const entry = offer.recent.find((r) => r.key === key);
    if (entry !== undefined && !cwdTouched.current) setCwd(entry.runCwd ?? "");
  }

  // The history's two writes (ADR 0095). Silent kind (lib/ack-manifest.ts): a refusal is said on the
  // status line, and the list is read again either way. The pick falls back to Shell at once, since the
  // entry it named is gone.
  const [historyBusy, setHistoryBusy] = useState(false);
  async function editHistory(write: () => ReturnType<typeof removeRecentRun>) {
    if (historyBusy) return;
    setHistoryBusy(true);
    const out = await mutate(write);
    setHistoryBusy(false);
    if (out.ok && !out.value.ok) setStatus(describeApiError(out.value), "error");
    if (out.ok) setCommandPick({ kind: "shell" });
    launchers.reload();
  }
  function removeFromHistory() {
    if (what?.kind !== "run") return;
    const line = what.line;
    void editHistory(() => removeRecentRun(line, target));
  }

  const busy = phase === "starting" || creatingSpace || checking;
  const refusedText = startRefusal !== null && startRefusal.print === fingerprint ? startRefusal.message : null;
  const adds = loaded && launchers.adding?.adds === true && refusal === undefined;
  /** "Add your own": a level below this page, on the machine chosen here and the pane it was opened for. */
  function openAdd(next: Kind) {
    // Adding to the second half adds a command row, so there the word is Command.
    nav.down(newAddPath({ machine: target.host, pane: at.pane, session: at.session }, next === "shell" ? "command" : "agent"));
  }
  const backLabel = t("newPage.back");

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(homePath({ host: at.machine, session: at.session }))}
              aria-label={backLabel}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("home.new.label")}</h1>
          </>
        }
      />
      {/* `relative` for the reason SettingsPage gives: an `sr-only` deep in the page would escape the
          scroller and grow the document's own scrollbar. */}
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {multiHost && from === undefined && (
          <MachineSelect
            chosen={chosen}
            refusal={refusal}
            onChoose={(id) => {
              setHost(id);
              setKindPick(null);
              setAgentPick(null);
              setCommandPick(null);
            }}
          />
        )}

        <Collapse open={againOffered}>
          {againOffered && again !== null ? (
            <button
              type="button"
              onClick={useAgain}
              disabled={busy}
              className="flex min-h-14 w-full items-center gap-3 rounded-md border border-border bg-muted px-3 py-2 text-left transition-colors active:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <History className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {again.branch === null
                    ? t("newPage.again", { what: whatLabel(again.what, offer, t("newPage.shell")) })
                    : t("newPage.againBranch", { what: whatLabel(again.what, offer, t("newPage.shell")) })}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {shortenHome(again.cwd ?? (home || "~"), home)}
                  {machineName !== undefined ? ` · ${machineName}` : ""}
                </span>
              </span>
            </button>
          ) : null}
        </Collapse>

        {/* Agent or Command: one segment, one select. Both halves are always listed in full; what
            cannot run on this machine is disabled in its select, with its reason in brackets. */}
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("newPage.what")}
            value={kind}
            onChange={chooseKind}
            options={[
              { value: "agent", label: t("newPage.kind.agent") },
              { value: "shell", label: t("newPage.shell") },
            ]}
          />
          {kind === "agent" ? (
            <Select
              aria-label={t("newPage.kind.agent")}
              value={agentItem?.key ?? ""}
              disabled={offer.agents.length === 0}
              lead={<AgentIcon agent={agentItem?.harness} className="size-4 rounded-sm" />}
              onChange={(event) => setAgentPick(event.target.value)}
            >
              {agentItem === null && <option value="" disabled aria-label={t("newPage.kind.agent")} />}
              {offer.agents.map((a) => (
                <option key={a.key} value={a.key} disabled={a.unavailable !== null}>
                  {optionText(a, t("newPage.shell"))}
                </option>
              ))}
            </Select>
          ) : (
            <CommandPicker
              options={commandOptions(offer, t("newPage.shell.option"))}
              value={commandKey(command)}
              onChoose={chooseCommand}
              typed={command.kind === "typed" ? { line: typedLine, onLine: setTypedLine, onGo: startNow } : null}
              recent={
                command.kind === "run"
                  ? {
                      busy: historyBusy || busy,
                      onRemove: removeFromHistory,
                      onClear: () => void editHistory(() => clearRecentRuns(target)),
                    }
                  : null
              }
            />
          )}
          {/* One note and one link under the select, whichever half is on. The two share a box as big
              as the larger, so the Segmented switch moves nothing (DESIGN.md §2). */}
          <OneOf
            active={kind}
            className="justify-items-start"
            options={[
              {
                key: "agent",
                node: (
                  <DocsNote
                    note={t("newPage.agents.note")}
                    href={NEW_PAGE_DOCS.agent}
                    link={t("newPage.agents.docs")}
                    onAdd={adds ? () => openAdd("agent") : undefined}
                    noPrompts={kind === "agent" && agentItem?.noPrompts === true}
                  >
                    <Collapse open={offer.agentsNote !== null}>
                      {offer.agentsNote !== null ? <Reason reason={offer.agentsNote} /> : null}
                    </Collapse>
                  </DocsNote>
                ),
              },
              {
                key: "shell",
                node: (
                  <DocsNote
                    note={t("newPage.commands.note")}
                    href={NEW_PAGE_DOCS.command}
                    link={t("newPage.commands.docs")}
                    onAdd={adds ? () => openAdd("shell") : undefined}
                    noPrompts={kind === "shell" && command.kind !== "typed" && itemOf(offer, command)?.noPrompts === true}
                  />
                ),
              },
            ]}
          />
        </div>

        {showWhere ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("newPage.where")}</span>
              <input
                value={cwd}
                onChange={(e) => editCwd(e.target.value)}
                placeholder={t("space.new.dir.placeholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
            <FolderSections folders={folders} onUse={pickFolder} onStar={(f, s) => void star(f, s)} />
          </div>
        ) : pinned !== undefined ? (
          <p className="text-xs text-muted-foreground">{t("newPage.where.pinned", { folder: shortenHome(pinned, home) })}</p>
        ) : null}

        <Collapse open={branchShown}>
          {branchShown ? (
            <BranchBlock
              on={branchOn && branchBlocked === null}
              blocked={branchBlocked}
              onToggle={setBranchOn}
              name={branchName}
              onName={setBranchName}
              startChoices={startChoices}
              baseShown={baseShown}
              onBase={setBasePick}
              folderKind={folderKind}
              onFolderKind={setFolderPick}
              parent={parent}
              onParent={setParentPick}
              folders={folders}
              onStar={(f, s) => void star(f, s)}
              checking={branchActive && current === null}
              targetPath={targetPath === null ? null : shortenHome(targetPath, home)}
              problem={branchProblem}
            />
          ) : null}
        </Collapse>
      </BandMain>

      {/* The foot: what Start will do, in one line, then Start. A sibling UNDER the scroller, so it
          stays above the keyboard (the viewport resizes with it) and clear of the home indicator. */}
      <BottomBar className="flex flex-col gap-2 px-4">
        {/* One reserved cell holds the summary and, when a Start was refused, the refusal in its
            place, in the same box, so neither moves anything (DESIGN.md §2). Two summary lines are
            reserved, so a longer sentence moves nothing either. */}
        <OneOf
          active={refusedText === null ? "summary" : "refusal"}
          className="min-h-[42px] justify-items-stretch"
          options={[
            {
              key: "summary",
              node: (
                <p className="line-clamp-2 h-10 text-sm leading-5" data-testid="new-page-summary">
                  {summary}
                </p>
              ),
            },
            {
              key: "refusal",
              node:
                refusedText === null ? null : (
                  <Notice tone="danger" variant="box" announce="alert">
                    <span data-testid="new-page-refusal">{refusedText}</span>
                  </Notice>
                ),
            },
          ]}
        />
        <Collapse open={phase === "unknown"}>
          {phase === "unknown" ? (
            <p role="status" className="text-[11px] leading-tight text-status-blocked">
              {t("newPage.unknown")}
            </p>
          ) : null}
        </Collapse>
        <Button ref={startButton} onClick={startNow} disabled={blocked || busy} aria-busy={busy || undefined} className="h-11">
          {/* All three words share one reserved box, so the button keeps its width (DESIGN.md §2). */}
          <OneOf
            active={busy ? "starting" : retrying ? "retry" : "start"}
            className="justify-items-center"
            options={[
              { key: "start", node: t("newPage.start") },
              { key: "starting", node: t("newPage.starting") },
              { key: "retry", node: t("newPage.retry") },
            ]}
          />
        </Button>
      </BottomBar>

      {/* The status line, for what this page publishes itself (a folder star that failed, a worktree
          whose agent did not start). Every other route with writes mounts one; this one did not, so
          its statuses were published to nothing and showed up on the next screen. Lifted above the
          bottom bar. A refused Start is NOT said here but in the Notice above. */}
      <ToastViewport className="bottom-40">
        <StatusArea />
      </ToastViewport>

      {/* "Start without prompts?", the one question before a launcher that skips permission prompts. */}
      {noPromptsSheet}
    </div>
  );
}

/**
 * The note under the Agent or Command select, then ONE line of small links: how to add one (the docs),
 * "Add your own" when this machine lets a phone add (a page below this one), and the "No prompts"
 * badge when the chosen item skips permission prompts. The badge's cell is always laid out (a
 * `OneOf` with nothing on top when off), so it appearing moves nothing (DESIGN.md §2).
 */
function DocsNote({
  note,
  href,
  link,
  onAdd,
  noPrompts,
  children,
}: {
  note: string;
  href: string;
  link: string;
  onAdd: (() => void) | undefined;
  noPrompts: boolean;
  children?: React.ReactNode;
}) {
  // A text link on its own line owes the same 44px floor as a button (DESIGN.md §6).
  const linkClass =
    "inline-flex min-h-11 items-center text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  return (
    <div className="flex flex-col items-start">
      <p className="text-xs leading-snug text-muted-foreground">{note}</p>
      {children}
      <div className="flex flex-wrap items-center gap-x-4">
        <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
          {link}
        </a>
        {onAdd !== undefined && (
          <button type="button" onClick={onAdd} className={linkClass}>
            {t("newPage.add")}
          </button>
        )}
        <OneOf active={noPrompts ? "badge" : null} options={[{ key: "badge", node: <NoPromptsBadge /> }]} />
      </div>
    </div>
  );
}

/** Why an item cannot be used, as a line of its own (the machine's sentence is said beside its select). */
function Reason({ reason }: { reason: Unavailable }) {
  return <p className="text-xs leading-snug text-muted-foreground">{unavailableText(reason)}</p>;
}

/**
 * The machine select, on a crew only. Its lead is the Server icon in the chosen machine's host colour.
 * A machine that takes no writes stays in the list, disabled, with a word for why in brackets; its
 * full sentence is said under the select when it is the one chosen (CREW_PROTOCOL.md §10.2: listed
 * with its reason, never removed).
 */
function MachineSelect({
  chosen,
  refusal,
  onChoose,
}: {
  chosen: string | undefined;
  refusal: string | undefined;
  onChoose: (id: string) => void;
}) {
  const { servers, health } = useCrew();
  const slot = chosen === undefined ? null : hostSlot(servers, chosen);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("space.new.host.label")}</span>
        <Select
          value={chosen ?? ""}
          lead={<Server className={cn("size-4", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])} />}
          onChange={(event) => onChoose(event.target.value)}
        >
          {servers.map((s) => {
            const word = machineWord(memberHealth(health, s));
            return (
              <option key={s.id} value={s.id} disabled={word !== undefined}>
                {word === undefined ? s.name || s.id : `${s.name || s.id} (${word})`}
              </option>
            );
          })}
        </Select>
      </label>
      <Collapse open={refusal !== undefined}>
        {refusal !== undefined ? <p className="text-xs leading-snug text-muted-foreground">{refusal}</p> : null}
      </Collapse>
    </div>
  );
}

interface BranchBlockProps {
  on: boolean;
  /** Why the switch cannot be turned on here, or `null`. */
  blocked: Unavailable | null;
  onToggle: (on: boolean) => void;
  name: string;
  onName: (name: string) => void;
  startChoices: { defaultBranch: string; paneBranch: string } | null;
  baseShown: "default" | "branch";
  onBase: (base: "default" | "branch") => void;
  folderKind: WorktreeFolderChoice["kind"];
  onFolderKind: (kind: WorktreeFolderChoice["kind"]) => void;
  parent: string;
  onParent: (parent: string) => void;
  folders: Parameters<typeof FolderSections>[0]["folders"];
  onStar: (folder: string, starred: boolean) => void;
  checking: boolean;
  /** The resolved absolute folder, shortened for display. */
  targetPath: string | null;
  problem: string | null;
}

/** "New worktree": the switch, then the name, where it starts, and where its folder goes. */
function BranchBlock(p: BranchBlockProps) {
  const switchId = useId();
  const noteId = useId();
  // The machine's own sentence is said beside the machine select, so it is not said twice here.
  const reason = p.blocked !== null && p.blocked.kind !== "machine" ? p.blocked : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={switchId} className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{t("newPage.branch")}</span>
          <span id={noteId} className="text-[11px] leading-tight text-muted-foreground">
            {t("newPage.branch.note")}
          </span>
        </label>
        <Switch
          id={switchId}
          checked={p.on}
          disabled={p.blocked !== null}
          onCheckedChange={p.onToggle}
          aria-describedby={noteId}
        />
      </div>
      <Collapse open={reason !== null}>{reason !== null ? <Reason reason={reason} /> : null}</Collapse>
      <Collapse open={p.on}>
        {p.on ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("newPage.branch.name")}</span>
              <input
                value={p.name}
                onChange={(e) => p.onName(e.target.value)}
                placeholder={t("worktree.branchPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
            <Collapse open={p.startChoices !== null}>
              {p.startChoices !== null ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">{t("branchOff.startFrom.label")}</span>
                  <Segmented
                    label={t("branchOff.startFrom.label")}
                    value={p.baseShown}
                    onChange={p.onBase}
                    options={[
                      { value: "default", label: p.startChoices.defaultBranch },
                      { value: "branch", label: t("branchOff.startFrom.thisBranch") },
                    ]}
                  />
                  <Collapse open={p.baseShown === "branch"}>
                    {p.baseShown === "branch" ? (
                      <p className="pt-1 text-[11px] leading-tight text-muted-foreground">
                        {t("branchOff.startFrom.note", { branch: p.startChoices.paneBranch })}
                      </p>
                    ) : null}
                  </Collapse>
                </div>
              ) : null}
            </Collapse>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("newPage.branch.folder")}</span>
              <Segmented
                label={t("newPage.branch.folder")}
                value={p.folderKind}
                onChange={p.onFolderKind}
                options={[
                  { value: "default", label: t("newPage.branch.folder.default") },
                  { value: "parent", label: t("newPage.branch.folder.other") },
                ]}
              />
            </div>
            <Collapse open={p.folderKind === "parent"}>
              {p.folderKind === "parent" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{t("newPage.branch.parent")}</span>
                    <input
                      value={p.parent}
                      onChange={(e) => p.onParent(e.target.value)}
                      placeholder="~/src"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    />
                  </label>
                  <FolderSections folders={p.folders} onUse={p.onParent} onStar={p.onStar} />
                </div>
              ) : null}
            </Collapse>
            {/* The resolved absolute folder, always, or the reason there is none (ADR 0093). One
                line whose words swap, so nothing below it moves. */}
            <p
              className={cn(
                "min-h-4 break-all font-mono text-[11px] leading-tight",
                p.problem !== null ? "text-status-blocked" : "text-muted-foreground",
              )}
              data-testid="new-page-target"
            >
              {p.problem ?? (p.targetPath !== null ? t("newPage.branch.target", { path: p.targetPath }) : p.checking ? t("newPage.branch.checking") : "")}
            </p>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}
