import { useEffect, useId, useMemo, useRef, useState } from "react";
import { History, Server, TerminalSquare } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { useCrew } from "@/components/crew-provider";
import { FolderSections } from "@/components/new-space-folders";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Segmented } from "@/components/ui/segmented";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { useSpaceActions } from "@/hooks/use-spaces";
import { planWorktree, type StartWhat } from "@/lib/api";
import { describeApiError } from "@/lib/api-error-message";
import { startFromChoices } from "@/lib/branch-off";
import { useFolders } from "@/lib/folders";
import { writeRefusal } from "@/lib/host-health";
import { HOST_TEXT_CLASSES, hostSlot, isMultiHost, leadHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { launchersKey, useLaunchers } from "@/lib/launchers";
import { useMuxCapability } from "@/lib/mux-capability";
import {
  branchAllowed,
  defaultHost,
  firstWhat,
  memberHealth,
  offerFor,
  offered,
  readAgain,
  rememberAgain,
  sameWhat,
  startFingerprint,
  summaryKey,
  whatKey,
  whatLabel,
  type Offer,
  type OffItem,
  type SummaryParts,
} from "@/lib/new-sheet";
import { useHoldReload } from "@/lib/reload-guard";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import type { WorktreeBaseChoice, WorktreeFolderChoice, WorktreePlanResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { branchOffName, mintRequestId } from "@/lib/worktree-name";

/**
 * Where a sheet opened from a pane starts (a pane's ⋯ "New agent on a branch"): that pane's folder,
 * the branch switch on, and the pane's own branch as "This branch". Absent is the dashboard's sheet.
 */
export interface NewSheetFrom {
  cwd: string;
  /** The branch the pane is on, when it is a named one. */
  branch: string | null;
}

interface NewSheetProps {
  open: boolean;
  onClose: () => void;
  /** The scope of the view the sheet opens over; absent is the lead's primary session. Its machine is picked first. */
  scope?: Scope;
  from?: NewSheetFrom;
  /** The caller's own liveness gate for a write, as `useSpaceActions` takes it (the pane view's). */
  canWrite?: () => boolean;
}

// THE ONE NEW SHEET (M48 spec 01, card 4.3). One level, no second sheet: from the top, the machine
// (a crew only), a block that lists what cannot run there and why, Again, the agents this machine
// found, the commands (Shell and the operator's `launchers.toml` rows), the folder, the "On a new
// branch" switch, one line that says what Start will do, and Start.
//
// The lists come from the chosen machine's bridge (ADR 0091): the web app keeps no list of agent
// names. An item that cannot run there is never simply hidden; it moves to the top block with its
// reason. Every appearance in flow is a Collapse (DESIGN.md §1), because the answers arrive after the
// sheet opened.
//
// THE BODY IS KEYED PER OPENING, so every opening starts from its own defaults (Again, the pane it was
// opened from) and a half-typed field never leaks into the next one.
export function NewSheet({ open, onClose, scope, from, canWrite }: NewSheetProps) {
  useLocale();
  const [opening, setOpening] = useState(0);
  useEffect(() => {
    if (open) setOpening((n) => n + 1);
  }, [open]);
  useHoldReload("new-sheet", open);
  return (
    <BottomSheet open={open} onClose={onClose} title={t("home.new.label")}>
      {opening > 0 && <NewSheetBody key={opening} open={open} onClose={onClose} scope={scope} from={from} canWrite={canWrite} />}
    </BottomSheet>
  );
}

function NewSheetBody({ open, onClose, scope: asked, from, canWrite }: NewSheetProps) {
  useLocale();
  const scope: Scope = asked ?? {};
  const { start, creatingSpace } = useSpaceActions(canWrite);

  // ── Which machine ─────────────────────────────────────────────────────────────────────────────
  const { servers, health } = useCrew();
  const multiHost = isMultiHost(servers);
  const lead = leadHost(servers);
  // A sheet opened from a pane stays on that pane's machine: a branch is the lead's (ADR 0089).
  const [host, setHost] = useState<string | undefined>(() =>
    from !== undefined ? (scope.host ?? lead) : defaultHost(servers, health, scope.host),
  );
  const chosen = multiHost ? host : undefined;
  const chosenServer = servers.find((s) => s.id === chosen);
  const refusal = chosenServer ? writeRefusal(memberHealth(health, chosenServer)) : undefined;
  const target: Scope = multiHost ? { ...scope, host: chosen === lead ? undefined : chosen } : scope;
  const machineName = multiHost ? chosenServer?.name || chosen : undefined;
  const leadName = servers.find((s) => s.id === lead)?.name || lead || "";
  // Again's key: the machine's id on a crew, "" on a solo install.
  const machineKey = chosen ?? "";

  // ── What this machine offers ──────────────────────────────────────────────────────────────────
  const launchers = useLaunchers(target, open);
  const loaded = launchers.loadedFor === launchersKey(target);
  // Worktrees are the lead's alone, so the lead's multiplexer is the one asked.
  const canWorktree = useMuxCapability("createWorktree").capable;
  const offer: Offer = offerFor({
    harnesses: loaded ? launchers.harnesses : null,
    loaded,
    rows: loaded ? launchers.launchers : [],
    refusal,
    canWorktree,
    memberChosen: multiHost && chosen !== lead ? { lead: leadName } : undefined,
  });
  const home = loaded ? launchers.home : "";
  const { folders, star } = useFolders(target, open);
  const again = useMemo(() => readAgain(machineKey), [machineKey]);
  const againOffered =
    again !== null && loaded && offered(offer, again.what) && (again.branch === null || offer.branch);

  // ── The form ──────────────────────────────────────────────────────────────────────────────────
  const [picked, setPicked] = useState<StartWhat | null>(null);
  const fallback = again !== null && loaded && offered(offer, again.what) ? again.what : firstWhat(offer);
  const what: StartWhat = picked !== null && offered(offer, picked) ? picked : fallback;
  const [cwd, setCwd] = useState(() => from?.cwd ?? readAgain(machineKey)?.cwd ?? "");
  const pinned = what.kind === "row" ? offer.rows.find((r) => r.command === what.command)?.cwd : undefined;
  // A machine older than 1.19.0 ignores a folder on a row, so it is not offered there.
  const legacy = loaded && !offer.shellById;
  const showWhere = pinned === undefined && !(legacy && what.kind === "row");

  const [branchOn, setBranchOn] = useState(from !== undefined);
  const [branchName, setBranchName] = useState(() => branchOffName());
  const [basePick, setBasePick] = useState<"default" | "branch" | null>(null);
  const [folderPick, setFolderPick] = useState<WorktreeFolderChoice["kind"] | null>(null);
  const [parentPick, setParentPick] = useState<string | null>(null);
  const branchShown = offer.branch && branchAllowed(what);
  const branchActive = branchShown && branchOn;

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
    if (!open || !branchActive) return;
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
  }, [open, branchActive, planKey, planCwd, planBranch, planParent, targetHost, targetSession]);
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
      : (okPlan?.defaultBranch ?? okPlan?.currentBranch ?? t("newSheet.branch.head"));
  const folderChoice: WorktreeFolderChoice =
    folderKind === "parent" ? { kind: "parent", parent: parent.trim() } : { kind: "default" };

  // What stops a branch Start, in the bridge's own words where it gave some.
  let branchProblem: string | null = null;
  let targetPath: string | null = null;
  if (branchActive && current !== null) {
    if (!current.ok) branchProblem = describeApiError(current);
    else if (current.branchValid === false) branchProblem = t("newSheet.branch.badName");
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
  const shownWhat = whatLabel(what, offer, t("newSheet.shell"));
  const folderText = shortenHome(pinned ?? (cwd.trim() === "" ? home || "~" : cwd.trim()), home);
  const parts: SummaryParts = { what: shownWhat, folder: folderText };
  if (machineName !== undefined) parts.machine = machineName;
  if (branchActive) parts.branch = { name: branchName.trim(), base: baseName };
  const summary = t(`newSheet.summary.${summaryKey(parts)}`, {
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
  const startingRef = useRef(false);
  const fingerprint = startFingerprint({
    machine: machineKey,
    what,
    cwd: showWhere ? cwd.trim() : "",
    branch: branchActive ? { name: branchName.trim(), base: JSON.stringify(base), folder: folderChoice } : null,
  });
  const retrying = phase === "unknown" && lastAsk.current === fingerprint;
  const blocked = refusal !== undefined || !loaded || branchProblem !== null;

  async function run(ask: { what: StartWhat; cwd: string; branch: boolean }, print: string) {
    if (startingRef.current) return;
    startingRef.current = true;
    if (lastAsk.current !== print) requestId.current = mintRequestId();
    lastAsk.current = print;
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
    if (outcome === "done") {
      rememberAgain(machineKey, {
        what: ask.what,
        label: whatLabel(ask.what, offer, t("newSheet.shell")),
        cwd: ask.what.kind === "row" ? null : (sendCwd ?? null),
        branch: ask.branch ? { folder: folderChoice } : null,
        at: Date.now(),
      });
      setPhase("idle");
      onClose();
      return;
    }
    setPhase(outcome === "unknown" ? "unknown" : "idle");
  }

  function startNow() {
    if (blocked) return;
    void run({ what, cwd: showWhere ? cwd.trim() : "", branch: branchActive }, fingerprint);
  }

  /** Again: a plain start runs at once; a branch start fills the form with a fresh name. */
  function useAgain() {
    if (again === null) return;
    setPicked(again.what);
    setCwd(again.cwd ?? "");
    if (again.branch !== null) {
      setBranchOn(true);
      setBranchName(branchOffName());
      setFolderPick(again.branch.folder.kind);
      if (again.branch.folder.kind === "parent") setParentPick(again.branch.folder.parent);
      return;
    }
    const print = startFingerprint({ machine: machineKey, what: again.what, cwd: again.cwd ?? "", branch: null });
    void run({ what: again.what, cwd: again.cwd ?? "", branch: false }, print);
  }

  const busy = phase === "starting" || creatingSpace;
  const whatGroup = useId();

  return (
    <div className="flex flex-col gap-4">
      {multiHost && from === undefined && (
        <MachinePicker
          chosen={chosen}
          onChoose={(id) => {
            setHost(id);
            setPicked(null);
          }}
        />
      )}

      {/* What cannot run here, and why: at the TOP, in one block, never hidden (spec M48/01). */}
      <Collapse open={offer.off.length > 0}>
        {offer.off.length > 0 ? <OffBlock items={offer.off} machine={machineName} /> : null}
      </Collapse>

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
                  ? t("newSheet.again", { what: whatLabel(again.what, offer, t("newSheet.shell")) })
                  : t("newSheet.againBranch", { what: whatLabel(again.what, offer, t("newSheet.shell")) })}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {shortenHome(again.cwd ?? (home || "~"), home)}
                {machineName !== undefined ? ` · ${machineName}` : ""}
              </span>
            </span>
          </button>
        ) : null}
      </Collapse>

      {/* Agents and Commands are ONE choice: one radio group, two headings. */}
      <div role="radiogroup" aria-label={t("newSheet.what")} className="flex flex-col gap-4">
        <Collapse open={offer.agents.length > 0}>
          {offer.agents.length > 0 ? (
            <section className="flex flex-col gap-2" aria-labelledby={`${whatGroup}-agents`}>
              <div className="flex flex-col">
                <span id={`${whatGroup}-agents`} className="text-xs font-medium text-muted-foreground">
                  {t("newSheet.agents")}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">{t("newSheet.agents.note")}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {offer.agents.map((h) => (
                  <WhatChip
                    key={h.id}
                    label={h.label}
                    icon={<AgentIcon agent={h.id} className="size-6 rounded-md" />}
                    selected={sameWhat(what, { kind: "harness", id: h.id })}
                    onSelect={() => setPicked({ kind: "harness", id: h.id })}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </Collapse>
        <section className="flex flex-col gap-2" aria-labelledby={`${whatGroup}-commands`}>
          <div className="flex flex-col">
            <span id={`${whatGroup}-commands`} className="text-xs font-medium text-muted-foreground">
              {t("newSheet.commands")}
            </span>
            <span className="text-[11px] leading-tight text-muted-foreground">{t("newSheet.commands.note")}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[{ kind: "shell" } as const, ...offer.rows.map((r) => ({ kind: "row" as const, command: r.command }))].map((w) => (
              <WhatChip
                key={whatKey(w)}
                label={whatLabel(w, offer, t("newSheet.shell"))}
                icon={<TerminalSquare className="size-5 text-muted-foreground" aria-hidden />}
                selected={sameWhat(what, w)}
                onSelect={() => setPicked(w)}
              />
            ))}
          </div>
        </section>
      </div>

      {showWhere ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("newSheet.where")}</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t("space.new.dir.placeholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </label>
          <FolderSections folders={folders} onUse={setCwd} onStar={(f, s) => void star(f, s)} />
        </div>
      ) : pinned !== undefined ? (
        <p className="text-xs text-muted-foreground">{t("newSheet.where.pinned", { folder: shortenHome(pinned, home) })}</p>
      ) : null}

      <Collapse open={branchShown}>
        {branchShown ? (
          <BranchBlock
            on={branchOn}
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

      {/* The footer: what Start will do, in one line, then Start. Sticky, so it stays under the thumb. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background px-4 pt-3 pb-1">
        <p className="text-sm" data-testid="new-sheet-summary">
          {summary}
        </p>
        <Collapse open={phase === "unknown"}>
          {phase === "unknown" ? (
            <p role="status" className="text-[11px] leading-tight text-status-blocked">
              {t("newSheet.unknown")}
            </p>
          ) : null}
        </Collapse>
        <Button onClick={startNow} disabled={blocked || busy} aria-busy={busy || undefined} className="h-11">
          {/* All three words share one reserved box, so the button keeps its width (DESIGN.md §2). */}
          <OneOf
            active={busy ? "starting" : retrying ? "retry" : "start"}
            className="justify-items-center"
            options={[
              { key: "start", node: t("newSheet.start") },
              { key: "starting", node: t("newSheet.starting") },
              { key: "retry", node: t("newSheet.retry") },
            ]}
          />
        </Button>
      </div>
    </div>
  );
}

/** One choice in the Agents or Commands group: a radio with the house 2px corner and a 44px floor. */
function WhatChip({
  label,
  icon,
  selected,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        // The ring marks the pick and takes no room, so a pick moves nothing (DESIGN.md §2).
        "flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected ? "bg-muted text-foreground ring-2 ring-inset ring-foreground" : "bg-background text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The top block: what cannot run on this machine, one line each with its reason. */
function OffBlock({ items, machine }: { items: readonly OffItem[]; machine: string | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2" data-testid="new-sheet-off">
      <span className="text-xs font-medium text-muted-foreground">
        {machine === undefined ? t("newSheet.off.titleHere") : t("newSheet.off.title", { machine })}
      </span>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.key} className="text-xs leading-snug">
            {item.reason.kind === "machine" ? (
              item.reason.sentence
            ) : (
              <>
                <span className="font-medium">
                  {item.label ?? (item.group === "branch" ? t("newSheet.off.branch") : t("newSheet.off.agents"))}
                </span>
                {": "}
                <span className="text-muted-foreground">{offReason(item)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function offReason(item: OffItem): string {
  switch (item.reason.kind) {
    case "notFound":
      return t("newSheet.off.notFound");
    case "olderCollie":
      return t("newSheet.off.olderCollie");
    case "needsHerdr":
      return t("newSheet.off.needsHerdr");
    case "onlyOnLead":
      return t("newSheet.off.onlyOnLead", { lead: item.reason.lead });
    case "machine":
      return item.reason.sentence;
  }
}

/** The machine row, on a crew only: the same radio row the space create always had. */
function MachinePicker({ chosen, onChoose }: { chosen: string | undefined; onChoose: (id: string) => void }) {
  const { servers, health } = useCrew();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {t("space.new.host.label")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex gap-1 overflow-x-auto rounded-md bg-muted p-1">
        {servers.map((s) => {
          const reason = writeRefusal(memberHealth(health, s));
          const slot = hostSlot(servers, s.id);
          const selected = chosen === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={selected}
              // Listed with its reason, never removed (CREW_PROTOCOL.md §10.2).
              aria-disabled={reason !== undefined}
              aria-label={reason}
              title={reason}
              onClick={() => {
                if (reason === undefined) onChoose(s.id);
              }}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                reason !== undefined && "opacity-50",
              )}
            >
              <Server
                className={cn("size-3.5 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])}
                aria-hidden
              />
              <span className="truncate">{s.name || s.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface BranchBlockProps {
  on: boolean;
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

/** "On a new branch": the switch, then the name, where it starts, and where its folder goes. */
function BranchBlock(p: BranchBlockProps) {
  const switchId = useId();
  const noteId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={switchId} className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{t("newSheet.branch")}</span>
          <span id={noteId} className="text-[11px] leading-tight text-muted-foreground">
            {t("newSheet.branch.note")}
          </span>
        </label>
        <Switch id={switchId} checked={p.on} onCheckedChange={p.onToggle} aria-describedby={noteId} />
      </div>
      <Collapse open={p.on}>
        {p.on ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("newSheet.branch.name")}</span>
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
              <span className="text-xs font-medium text-muted-foreground">{t("newSheet.branch.folder")}</span>
              <Segmented
                label={t("newSheet.branch.folder")}
                value={p.folderKind}
                onChange={p.onFolderKind}
                options={[
                  { value: "default", label: t("newSheet.branch.folder.default") },
                  { value: "parent", label: t("newSheet.branch.folder.other") },
                ]}
              />
            </div>
            <Collapse open={p.folderKind === "parent"}>
              {p.folderKind === "parent" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{t("newSheet.branch.parent")}</span>
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
              data-testid="new-sheet-target"
            >
              {p.problem ?? (p.targetPath !== null ? t("newSheet.branch.target", { path: p.targetPath }) : p.checking ? t("newSheet.branch.checking") : "")}
            </p>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}
