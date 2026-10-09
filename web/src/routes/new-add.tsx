import { useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { ArrowLeft, Lock } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { RouteHeader } from "@/components/app-header";
import { useCrew } from "@/components/crew-provider";
import { LauncherAddedList } from "@/components/launcher-added-list";
import { LauncherHowSheet } from "@/components/launcher-how-sheet";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { StatusArea } from "@/components/status-area";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { OneOf } from "@/components/ui/one-of";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { BandMain } from "@/components/ui/strip-host";
import { Switch } from "@/components/ui/switch";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { addLauncher, type AddLauncherAsk } from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { leadHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import {
  recipeLine,
  recipeSkipsPrompts,
  recipesWithOptions,
  rowKey,
  togglePick,
} from "@/lib/launcher-add";
import { launchersKey, useLaunchers } from "@/lib/launchers";
import { newPath, readNewAddKind, readNewAt } from "@/lib/nav";
import { visibleLine } from "@/lib/no-prompts";
import { useHoldReload } from "@/lib/reload-guard";
import type { Scope } from "@/lib/scope";
import type { Recipe } from "@/lib/types";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

// "ADD YOUR OWN" (M48 spec 02, ADR 0094): a page below the New page, for a launcher this phone adds
// on ONE machine. Agent has two ways, a recipe (a harness and chips, the line built for you) and a
// written command (off until the operator turns it on); Command is the written way only. On success
// the page goes back to /new with the new row chosen. Where it was opened from rides in the query
// (`?kind=`, `?machine=`, `?pane=`, `?s=`), like the New page's own, so a reload keeps it.
//
// The body is keyed by its address, so a different machine starts from its own empty form.
export function NewAddRoute() {
  const { search } = useLocation();
  useLocale();
  useHoldReload("new-add-page", true);
  return <NewAddPage key={search} search={search} />;
}

type Way = "recipe" | "text";
type Kind = "agent" | "command";

const FIELD =
  "h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function NewAddPage({ search }: { search: string }) {
  useLocale();
  const nav = useNav();
  const at = useMemo(() => readNewAt(search), [search]);
  const scope: Scope = { host: at.machine, session: at.session };
  const { servers } = useCrew();
  const machineId = at.machine ?? leadHost(servers);
  const named = servers.find((s) => s.id === machineId);
  // Said only on a crew: a solo install has one machine and needs no name for it.
  const machine = servers.length > 1 && named !== undefined ? named.name || named.id : t("launcherAdd.thisMachine");

  const launchers = useLaunchers(scope);
  const loaded = launchers.loadedFor === launchersKey(scope);
  const adding = loaded ? launchers.adding : null;
  const recipes = useMemo(() => (adding === null ? [] : recipesWithOptions(adding)), [adding]);
  const harnesses = useMemo(
    () =>
      launchers.harnesses !== null && launchers.harnesses.length > 0
        ? launchers.harnesses.map((h) => ({ id: h.id, label: h.label }))
        : (adding?.recipes ?? []).map((r) => ({ id: r.harness, label: r.label })),
    [launchers.harnesses, adding],
  );

  // ── The form ──────────────────────────────────────────────────────────────────────────────────
  const [kind, setKind] = useState<Kind>(() => readNewAddKind(search));
  const [way, setWay] = useState<Way>("recipe");
  const [harnessPick, setHarnessPick] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [textHarness, setTextHarness] = useState<string | null>(null);
  const [skips, setSkips] = useState(false);
  const [checkedLine, setCheckedLine] = useState<string | null>(null);

  const recipe: Recipe | undefined = recipes.find((r) => r.harness === harnessPick) ?? recipes[0];
  const writing = kind === "command" || way === "text";
  const freeTextOff = adding !== null && !adding.freeText;
  const addsOff = adding !== null && !adding.adds;
  const agentForText = textHarness ?? harnesses[0]?.id ?? null;
  const line = text.trim();
  const hasChecked = checkedLine !== null && checkedLine === line;
  const shown = hasChecked ? visibleLine(line) : null;

  /** What Add would send, or `null` while the form cannot be sent. */
  const ask: AddLauncherAsk | null = (() => {
    if (adding === null || addsOff) return null;
    const label = name.trim();
    if (!writing) {
      if (recipe === undefined) return null;
      const options = recipe.options.filter((o) => picked.includes(o.id)).map((o) => o.id);
      const built: AddLauncherAsk = { recipe: { harness: recipe.harness, options } };
      if (label !== "") built.label = label;
      return built;
    }
    if (freeTextOff || line === "" || !hasChecked) return null;
    if (kind === "agent" && agentForText === null) return null;
    const typed: AddLauncherAsk = { text: line, kind };
    if (kind === "agent" && agentForText !== null) typed.harness = agentForText;
    if (skips) typed.noPrompts = true;
    if (label !== "") typed.label = label;
    return typed;
  })();

  // ── Adding ────────────────────────────────────────────────────────────────────────────────────
  // ONE request id per form, kept across retries: a retry is a replay and adds nothing twice. It is
  // minted again only when what is sent changes, because the bridge answers a replayed id with the
  // row it already stored, whatever this form says now.
  const requestId = useRef("");
  const lastAsk = useRef<string | null>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ print: string; message: string } | null>(null);
  const print = ask === null ? "" : JSON.stringify(ask);
  const errorText = error !== null && error.print === print ? error.message : null;

  async function add() {
    if (ask === null || sending.current) return;
    sending.current = true;
    if (lastAsk.current !== print) requestId.current = mintRequestId();
    lastAsk.current = print;
    setBusy(true);
    setError(null);
    try {
      const res = await addLauncher(ask, requestId.current, scope);
      if (!res.ok) {
        setError({ print, message: describeApiError(res) });
        return;
      }
      // Back to the New page, the new row chosen. `side` replaces this entry, so Back from there
      // lands on the page that opened the New page, not on this form again.
      nav.side(newPath({ machine: at.machine, pane: at.pane, session: at.session, pick: rowKey(res.row) }));
    } catch (e) {
      setError({ print, message: describeThrownError(e) });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const [howOpen, setHowOpen] = useState(false);
  const noPrompts = writing ? skips : recipe !== undefined && recipeSkipsPrompts(recipe, picked);
  const backLabel = t("newPage.back");
  const offReason = freeTextOff && writing;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={() => nav.up(newPath({ machine: at.machine, pane: at.pane, session: at.session }))}
              aria-label={backLabel}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("newPage.add")}</h1>
          </>
        }
      />
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Segmented
          label={t("launcherAdd.what")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "agent", label: t("newPage.kind.agent") },
            { value: "command", label: t("newPage.kind.command") },
          ]}
        />

        {addsOff ? (
          <Notice tone="caution" variant="box" announce="none">
            {t("launcherAdd.addsOff", { machine })}
          </Notice>
        ) : null}

        {/* Agent has two ways. A command has the written one only, so there is nothing to choose. */}
        <OneOf
          active={kind === "agent" ? "way" : null}
          className="justify-items-stretch"
          options={[
            {
              key: "way",
              node: (
                <Segmented
                  label={t("launcherAdd.way")}
                  value={way}
                  onChange={setWay}
                  options={[
                    { value: "recipe", label: t("launcherAdd.way.recipe") },
                    { value: "text", label: t("launcherAdd.mode.text") },
                  ]}
                />
              ),
            },
          ]}
        />

        {/* Every form this page can show shares one box, as big as the biggest, so choosing between
            them moves nothing (DESIGN.md §2). */}
        <OneOf
          active={offReason ? "off" : writing ? "text" : "recipe"}
          className="justify-items-stretch"
          options={[
            {
              key: "recipe",
              node: (
                <RecipeForm
                  recipes={recipes}
                  recipe={recipe}
                  picked={picked}
                  name={name}
                  onHarness={(id) => {
                    setHarnessPick(id);
                    setPicked([]);
                  }}
                  onPick={(id) => recipe !== undefined && setPicked((p) => togglePick(recipe, p, id))}
                  onName={setName}
                  loaded={loaded}
                />
              ),
            },
            {
              key: "text",
              node: (
                <TextForm
                  kind={kind}
                  harnesses={harnesses}
                  harness={agentForText}
                  text={text}
                  name={name}
                  skips={skips}
                  checked={shown}
                  onHarness={setTextHarness}
                  onText={(v) => {
                    setText(v);
                    setCheckedLine(null);
                  }}
                  onName={setName}
                  onSkips={setSkips}
                  onCheck={() => setCheckedLine(line)}
                  canCheck={line !== ""}
                />
              ),
            },
            {
              key: "off",
              node: (
                <div
                  data-testid="launcher-add-off"
                  className="flex items-start gap-3 rounded-md border border-dashed border-border px-3 py-3 text-muted-foreground"
                >
                  <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-foreground">{t("launcherAdd.off.title", { machine })}</span>
                    <span className="text-xs leading-snug">{t("launcherAdd.off.reason")}</span>
                  </div>
                </div>
              ),
            },
          ]}
        />

        <div className="flex min-h-11 items-center">
          <OneOf
            active={noPrompts ? "badge" : null}
            className="justify-items-start"
            options={[{ key: "badge", node: <NoPromptsBadge /> }]}
          />
        </div>

        <button
          type="button"
          onClick={() => setHowOpen(true)}
          className="inline-flex min-h-11 w-fit items-center text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("launcherAdd.how.link")}
        </button>

        <LauncherAddedList items={loaded ? launchers.items : null} scope={scope} machine={machine} onChanged={launchers.reload} />
      </BandMain>

      <BottomBar className="flex flex-col gap-2 px-4">
        {/* The summary, and a refusal in its place in the same box, so neither moves anything. */}
        <OneOf
          active={errorText === null ? "summary" : "error"}
          className="min-h-[42px] justify-items-stretch"
          options={[
            {
              key: "summary",
              node: (
                <p className="line-clamp-2 h-10 text-sm leading-5 text-muted-foreground" data-testid="launcher-add-summary">
                  {t("launcherAdd.summary", { machine })}
                </p>
              ),
            },
            {
              key: "error",
              node:
                errorText === null ? null : (
                  <Notice tone="danger" variant="box" announce="alert">
                    <span data-testid="launcher-add-error">{errorText}</span>
                  </Notice>
                ),
            },
          ]}
        />
        <Button onClick={() => void add()} disabled={ask === null || busy} aria-busy={busy || undefined} className="h-11">
          <OneOf
            active={busy ? "adding" : "add"}
            className="justify-items-center"
            options={[
              { key: "add", node: t("launcherAdd.add") },
              { key: "adding", node: t("launcherAdd.adding") },
            ]}
          />
        </Button>
      </BottomBar>

      <ToastViewport className="bottom-40">
        <StatusArea />
      </ToastViewport>

      <LauncherHowSheet open={howOpen} onClose={() => setHowOpen(false)} file={adding?.file} />
    </div>
  );
}

/** The recipe way: a harness, its option chips, the line they build, and an optional name. */
function RecipeForm({
  recipes,
  recipe,
  picked,
  name,
  onHarness,
  onPick,
  onName,
  loaded,
}: {
  recipes: readonly Recipe[];
  recipe: Recipe | undefined;
  picked: readonly string[];
  name: string;
  onHarness: (id: string) => void;
  onPick: (id: string) => void;
  onName: (v: string) => void;
  loaded: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("newPage.kind.agent")}</span>
        <Select
          value={recipe?.harness ?? ""}
          disabled={recipes.length === 0}
          lead={<AgentIcon agent={recipe?.harness} className="size-4 rounded-sm" />}
          onChange={(e) => onHarness(e.target.value)}
        >
          {recipe === undefined && <option value="" disabled aria-label={t("newPage.kind.agent")} />}
          {recipes.map((r) => (
            <option key={r.harness} value={r.harness}>
              {r.label}
            </option>
          ))}
        </Select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("launcherAdd.options")}</span>
        {/* One layer per harness in one cell: the box is the biggest harness's chips, so choosing
            another harness moves nothing. */}
        <OneOf
          active={recipe?.harness ?? null}
          className="justify-items-stretch"
          options={recipes.map((r) => ({
            key: r.harness,
            node: (
              <div className="flex flex-wrap content-start gap-2" role="group" aria-label={t("launcherAdd.options")}>
                {r.options.map((o) => {
                  const on = r === recipe && picked.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onPick(o.id)}
                      className={cn(
                        "min-h-11 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            ),
          }))}
        />
        {loaded && recipes.length === 0 ? <p className="text-xs text-muted-foreground">{t("launcherAdd.noRecipes")}</p> : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("launcherAdd.line")}</span>
        <p
          data-testid="launcher-add-line"
          className="h-[3.25rem] overflow-y-auto break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs"
        >
          {recipe === undefined ? "" : recipeLine(recipe, picked)}
        </p>
      </div>

      <NameField value={name} onChange={onName} />
    </div>
  );
}

/** The written way: the line, a name, which agent reads it, the skips-prompts switch, and the check. */
function TextForm({
  kind,
  harnesses,
  harness,
  text,
  name,
  skips,
  checked,
  onHarness,
  onText,
  onName,
  onSkips,
  onCheck,
  canCheck,
}: {
  kind: Kind;
  harnesses: readonly { id: string; label: string }[];
  harness: string | null;
  text: string;
  name: string;
  skips: boolean;
  checked: ReturnType<typeof visibleLine> | null;
  onHarness: (id: string) => void;
  onText: (v: string) => void;
  onName: (v: string) => void;
  onSkips: (v: boolean) => void;
  onCheck: () => void;
  canCheck: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("launcherAdd.text.command")}</span>
        <input
          value={text}
          onChange={(e) => onText(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn(FIELD, "font-mono")}
        />
      </label>

      <NameField value={name} onChange={onName} />

      {/* A command has no agent to pick; the slot stays so Agent and Command are the same height. */}
      <OneOf
        active={kind === "agent" ? "harness" : null}
        className="justify-items-stretch"
        options={[
          {
            key: "harness",
            node: (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t("launcherAdd.text.harness")}</span>
                <Select
                  value={harness ?? ""}
                  disabled={harnesses.length === 0}
                  lead={<AgentIcon agent={harness} className="size-4 rounded-sm" />}
                  onChange={(e) => onHarness(e.target.value)}
                >
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </Select>
              </label>
            ),
          },
        ]}
      />

      <div className="flex min-h-11 items-center justify-between gap-3">
        <span id="launcher-skips-label" className="text-sm font-medium">
          {t("launcherAdd.text.skips")}
        </span>
        <Switch checked={skips} onCheckedChange={onSkips} aria-labelledby="launcher-skips-label" />
      </div>

      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" className="h-11" disabled={!canCheck} onClick={onCheck}>
          {t("launcherAdd.check")}
        </Button>
        <OneOf
          active={checked === null ? "hint" : "line"}
          className="min-h-24 justify-items-stretch"
          options={[
            {
              key: "hint",
              node: <p className="text-xs leading-snug text-muted-foreground">{t("launcherAdd.check.hint")}</p>,
            },
            {
              key: "line",
              node:
                checked === null ? null : (
                  <div className="flex flex-col gap-2">
                    <p
                      data-testid="launcher-checked-line"
                      className="break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs"
                    >
                      {checked.text}
                    </p>
                    {checked.nonAscii ? (
                      <Notice tone="caution" variant="box" announce="none">
                        {t("launcherAdd.nonAscii")}
                      </Notice>
                    ) : null}
                  </div>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{t("launcherAdd.name")}</span>
      <input value={value} maxLength={60} onChange={(e) => onChange(e.target.value)} className={FIELD} />
    </label>
  );
}
