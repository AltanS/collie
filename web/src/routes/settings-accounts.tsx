import { useId, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router";

import { Bars, Foot } from "@/components/accounts-meter";
import { AgentIcon } from "@/components/agent-icon";
import { MiddleTruncate } from "@/components/changes-view";
import { SettingsPage } from "@/components/settings-page";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Fab } from "@/components/ui/fab";
import { FoldPanel, MoreToggle } from "@/components/ui/fold-toggle";
import { ListGroup } from "@/components/ui/list-group";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useSpaceActions } from "@/hooks/use-spaces";
import {
  accountName,
  addedCount,
  groupAccounts,
  folderTextInvalid,
  harnessLabel,
  nameFromFolder,
  newFolderFor,
  rememberStartError,
  sameLoginLine,
  seenLine,
  signedInText,
  startLineFor,
  takeStartError,
  useAccounts,
  type AccountHarness,
  type AccountIdentity,
  type AccountRow,
  type AccountsBody,
  type FoundFolder,
} from "@/lib/accounts";
import { addAccount, removeAccount } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { offersChangeLogin } from "@/lib/change-login";
import { accountPath, accountsAddPath, changeLoginPath, settingsSectionPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { mintRequestId } from "@/lib/worktree-name";
import { cn } from "@/lib/utils";

// ACCOUNTS IN SETTINGS (M101): a second login for an agent, kept as a folder the agent already
// understands. Three pages below Settings → Accounts: the list (with the folders found in use), the Add
// form, and one account's page. Look: the design round `accounts`, option 1.
//
// THE LEAD'S OWN MACHINE. These pages read and write the accounts of the machine the phone is connected
// to, never the machine a `?h=` names: an account is a folder on the machine that holds it, and a crew
// member's accounts are its own (the New page reads the chosen machine's, lib/accounts.ts). So the calls
// carry no scope, and the paths keep it only so Back returns to the view the person came from.
//
// OPT IN AND INVISIBLE. The index offers the row only while GET /api/accounts answers 200 (routes/
// settings.tsx). A page opened by address on a machine that offers none says so and draws nothing else.

const FIELD_INPUT =
  "h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * The page's first words: one line, and a More that opens the rest in place. Closed on every visit,
 * nothing of it stored. The toggle takes the line's left edge back (`-ml-3`) so its words, not its
 * padding, sit on the page's gutter. `startOpen` is for the design reference's open card only.
 * Exported for the design reference (playground/sections/accounts.tsx).
 */
export function IntroLines({ startOpen = false }: { startOpen?: boolean }) {
  useLocale();
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return (
    <div className="flex flex-col" data-slot="accounts-intro">
      <Hint>{t("accounts.intro")}</Hint>
      <div>
        <MoreToggle
          open={open}
          onToggle={() => setOpen((was) => !was)}
          controls={id}
          data-slot="accounts-intro-toggle"
          className="-ml-3"
          more={t("accounts.intro.moreToggle")}
          less={t("accounts.intro.lessToggle")}
        />
      </div>
      <FoldPanel id={id} open={open}>
        <Hint>{t("accounts.intro.more")}</Hint>
      </FoldPanel>
    </div>
  );
}

/** What a page says while it has no list: nothing, a machine without accounts, or a failed read. */
function Unavailable({ status }: { status: "loading" | "ready" | "unavailable" | "failed" }) {
  if (status === "unavailable") {
    return (
      <Notice tone="neutral" variant="box">
        {t("apiError.accounts.unavailable")}
      </Notice>
    );
  }
  if (status === "failed") {
    return (
      <Notice tone="danger" variant="box" announce="alert">
        {t("accounts.loadFailed")}
      </Notice>
    );
  }
  return null;
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

export function SettingsAccountsRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const accounts = useAccounts();
  // The floating Add folds to the round "+" once the list scrolls, as the dashboard's New does.
  const [collapsed, setCollapsed] = useState(false);
  const [naming, setNaming] = useState<FoundFolder | null>(null);
  const body = accounts.body;
  const canAdd = body !== null && body.harnesses.some((h) => h.kinds.length > 0);

  return (
    <SettingsPage title="accounts.title" onScroll={(e) => setCollapsed(e.currentTarget.scrollTop > 24)}>
      <IntroLines />
      <Unavailable status={accounts.status} />
      {body !== null && (
        // The last row clears the floating button.
        <div className="flex flex-col gap-4 pb-20">
          {groupAccounts(body).map((group) => (
            <section key={group.harness} aria-label={group.label}>
              <div className="mb-1.5 flex items-center gap-2 px-0.5">
                <AgentIcon agent={group.harness} className="size-4 rounded-sm" />
                <span className="text-xs font-medium text-muted-foreground">{group.label}</span>
              </div>
              <ListGroup as="ul" className="divide-y divide-border">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <AccountListRow row={row} sameLogin={sameLoginLine(body.accounts, row)} onOpen={() => nav.down(accountPath(row.id, scope))} />
                  </li>
                ))}
              </ListGroup>
            </section>
          ))}
          {body.found.length > 0 && <FoundBlock body={body} onAdd={setNaming} />}
          {addedCount(body) > 0 && <Hint>{t("accounts.removeNote")}</Hint>}
        </div>
      )}
      {canAdd && (
        <Fab
          label={t("accounts.add.label")}
          // Nothing sits under the list, so the button stands a gutter above the safe area.
          bottom="bottom-[calc(env(safe-area-inset-bottom)_+_1rem)]"
          collapsed={collapsed}
          onClick={() => nav.down(accountsAddPath(scope))}
        />
      )}
      <NameSheet
        found={naming}
        onClose={() => setNaming(null)}
        onAdded={() => {
          setNaming(null);
          accounts.reload();
        }}
      />
    </SettingsPage>
  );
}

/**
 * One account in the list: its name, who is signed in on the line under it, its windows and its foot.
 * Exported for the design reference (playground/sections/accounts.tsx), which mounts this row as it ships.
 */
export function AccountListRow({ row, sameLogin = null, onOpen }: { row: AccountRow; /** "Same login as Work.", when another profile of the agent shares the login. */ sameLogin?: string | null; onOpen: () => void }) {
  useLocale();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 p-3.5 text-left active:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{accountName(row)}</span>
        <IdentityLine identity={row.identity} />
        {sameLogin !== null && <span className="text-xs text-muted-foreground">{sameLogin}</span>}
      </span>
      <Bars windows={row.windows} />
      <Foot row={row} />
    </button>
  );
}

/** The row's second line: the email, its middle given up when it does not fit, or "Not signed in". */
function IdentityLine({ identity }: { identity: AccountIdentity | undefined }) {
  if (identity === undefined) return null;
  if (!identity.signedIn) return <span className="text-xs text-muted-foreground">{t("accounts.identity.notSignedIn")}</span>;
  if (identity.email === undefined) return null;
  return <MiddleTruncate text={identity.email} className="text-xs text-muted-foreground" />;
}

/**
 * The details row: "Signed in as" with the full email and the plan, or "Not signed in". Unknown draws
 * nothing. Exported for the design reference, as {@link AccountListRow} is.
 */
export function SignedInRow({ identity, sameLogin = null }: { identity: AccountIdentity | undefined; /** "Same login as Work.", under the address. */ sameLogin?: string | null }) {
  useLocale();
  if (identity === undefined) return null;
  if (!identity.signedIn) return <p className="text-sm text-muted-foreground">{t("accounts.identity.notSignedIn")}</p>;
  const text = signedInText(identity);
  if (text === null) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{t("accounts.identity.signedInAs")}</p>
      <p className="break-all text-sm">{text}</p>
      {sameLogin !== null && <Hint>{sameLogin}</Hint>}
    </div>
  );
}

/** Folders in use, found without reading any login, each with its own Add. */
function FoundBlock({ body, onAdd }: { body: AccountsBody; onAdd: (found: FoundFolder) => void }) {
  useLocale();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold">{tnFound(body.found.length)}</p>
        <Hint>{t("accounts.found.hint")}</Hint>
      </div>
      <ListGroup as="ul" className="divide-y divide-border">
        {body.found.map((f) => (
          <li key={`${f.harness}\u0000${f.path}`} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs">{f.folder}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {t("accounts.found.row", { agent: harnessLabel(body, f.harness), why: t(f.why === "reported" ? "accounts.found.reported" : "accounts.found.name") })}
              </p>
            </div>
            <Button variant="outline" className="h-11 shrink-0" onClick={() => onAdd(f)}>
              {t("accounts.add.label")}
            </Button>
          </li>
        ))}
      </ListGroup>
    </section>
  );
}

function tnFound(count: number): string {
  return count === 1 ? t("accounts.found.title.one", { count }) : t("accounts.found.title.other", { count });
}

/** "Add" on a found folder: it asks only for the name, prefilled from the folder's, and adopts the folder as it is. */
function NameSheet({ found, onClose, onAdded }: { found: FoundFolder | null; onClose: () => void; onAdded: () => void }) {
  useLocale();
  // The sheet keeps its field per folder: a new folder starts from its own prefilled name.
  const [typed, setTyped] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<{ print: string; id: string } | null>(null);
  const key = found === null ? "" : `${found.harness}\u0000${found.path}`;
  const text = typed !== null && typed.key === key ? typed.text : found === null ? "" : nameFromFolder(found.folder, found.harness);

  async function save() {
    if (found === null || busy) return;
    const label = text.trim();
    if (label === "") return;
    setBusy(true);
    setError(null);
    const ask = { harness: found.harness, label, kind: "own", path: found.path } as const;
    const print = JSON.stringify(ask);
    if (requestId.current === null || requestId.current.print !== print) requestId.current = { print, id: mintRequestId() };
    try {
      await addAccount(ask, requestId.current.id);
      setBusy(false);
      onAdded();
    } catch (e) {
      setBusy(false);
      setError(describeThrownError(e));
    }
  }

  return (
    <BottomSheet
      open={found !== null}
      onClose={onClose}
      title={t("accounts.name.title")}
    >
      <div className="flex flex-col gap-3">
        <p className="break-all font-mono text-xs text-muted-foreground">{found?.folder}</p>
        <Field label={t("accounts.add.name")}>
          <input
            value={text}
            maxLength={24}
            onChange={(e) => setTyped({ key, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            autoCapitalize="words"
            className={FIELD_INPUT}
          />
        </Field>
        {error !== null && (
          <Notice tone="danger" variant="box" announce="alert">
            {error}
          </Notice>
        )}
        <Button className="h-11 w-full" disabled={busy || text.trim() === ""} aria-busy={busy || undefined} onClick={() => void save()}>
          {t("accounts.add.label")}
        </Button>
      </div>
    </BottomSheet>
  );
}

// ── Add ──────────────────────────────────────────────────────────────────────────────────────────

export function SettingsAccountAddRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const accounts = useAccounts();
  const { start } = useSpaceActions();
  const body = accounts.body;
  const harnesses = (body?.harnesses ?? []).filter((h) => h.kinds.length > 0);

  const [harnessPick, setHarnessPick] = useState<string | null>(null);
  const harness: AccountHarness | undefined = harnesses.find((h) => h.id === harnessPick) ?? harnesses[0];
  const [label, setLabel] = useState("");
  const [kindPick, setKindPick] = useState<"shared" | "own" | null>(null);
  const kind = harness === undefined ? "own" : kindPick !== null && harness.kinds.includes(kindPick) ? kindPick : harness.kinds.includes("shared") ? "shared" : "own";
  const [folderText, setFolderText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<{ print: string; id: string } | null>(null);

  const found = (body?.found ?? []).filter((f) => harness !== undefined && f.harness === harness.id);
  const typedFound = found.find((f) => f.folder === folderText.trim() || f.path === folderText.trim());
  const folderShown = harness === undefined ? "" : kind === "shared" ? newFolderFor(harness, label) : folderText.trim() || newFolderFor(harness, "alt");
  const folderInvalid = kind === "own" && folderTextInvalid(folderText.trim());
  const ready = harness !== undefined && label.trim() !== "" && (kind === "shared" || folderText.trim() !== "");

  async function create() {
    if (harness === undefined || !ready || busy) return;
    setBusy(true);
    setError(null);
    const ask =
      kind === "shared"
        ? ({ harness: harness.id, label: label.trim(), kind } as const)
        : ({ harness: harness.id, label: label.trim(), kind, path: typedFound?.path ?? folderText.trim() } as const);
    const print = JSON.stringify(ask);
    if (requestId.current === null || requestId.current.print !== print) requestId.current = { print, id: mintRequestId() };
    let row: AccountRow;
    try {
      row = (await addAccount(ask, requestId.current.id)).account;
    } catch (e) {
      setBusy(false);
      setError(describeThrownError(e));
      return;
    }
    // The account exists now. A sign-in that cannot start leaves it in place and opens its page with the reason.
    const outcome = await start({ what: { kind: "harness", id: harness.id }, account: row.id, signIn: true, requestId: mintRequestId() }, {});
    setBusy(false);
    if (outcome.kind === "done") return;
    rememberStartError(row.id, outcome.kind === "refused" && outcome.message !== "" ? outcome.message : t("accounts.signIn.unknown"));
    nav.side(accountPath(row.id, scope));
  }

  return (
    <SettingsPage
      title="accounts.add.title"
      parent={settingsSectionPath("accounts", scope)}
      foot={
        <BottomBar className="px-4">
          <Button className="h-11 w-full" disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void create()}>
            {t("accounts.add.create")}
          </Button>
        </BottomBar>
      }
    >
      <Unavailable status={accounts.status} />
      {harness !== undefined && (
        <>
          <Field label={t("accounts.add.agent")}>
            <Select
              value={harness.id}
              onChange={(e) => {
                setHarnessPick(e.target.value);
                setKindPick(null);
                setFolderText("");
              }}
              lead={<AgentIcon agent={harness.id} className="size-4 rounded-sm" />}
            >
              {harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("accounts.add.name")}>
            <input
              className={FIELD_INPUT}
              value={label}
              maxLength={24}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("accounts.add.namePlaceholder")}
              autoCapitalize="words"
            />
          </Field>
          {harness.kinds.length > 1 && (
            <Segmented
              label={t("accounts.add.kind")}
              value={kind}
              onChange={setKindPick}
              options={[
                { value: "shared", label: t("accounts.add.kind.shared") },
                { value: "own", label: t("accounts.add.kind.own") },
              ]}
            />
          )}
          {kind === "own" && (
            <>
              <Field label={t("accounts.add.folder")}>
                <input
                  className={cn(FIELD_INPUT, "font-mono")}
                  value={folderText}
                  onChange={(e) => setFolderText(e.target.value)}
                  placeholder={newFolderFor(harness, "alt")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </Field>
              <Hint>{t("accounts.add.folderMadeIfMissing")}</Hint>
              {found.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("accounts.add.found")}</p>
                  <div role="radiogroup" aria-label={t("accounts.add.found")} className="flex flex-wrap gap-1">
                    {found.map((f) => (
                      <Chip key={f.path} radio label={f.folder} active={typedFound?.path === f.path} onClick={() => setFolderText(f.folder)} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{kind === "shared" ? t("accounts.add.makes") : t("accounts.add.uses")}</p>
            <p className="break-all font-mono text-xs leading-5">{folderShown}</p>
            <Hint>{kind === "shared" ? t("accounts.kind.shared.body") : t("accounts.kind.own.body")}</Hint>
          </div>
          {!folderInvalid && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">{t("accounts.add.terminal")}</p>
              <p className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs leading-5">{startLineFor(harness, folderShown)}</p>
            </div>
          )}
        </>
      )}
      {error !== null && (
        <Notice tone="danger" variant="box" announce="alert">
          {error}
        </Notice>
      )}
    </SettingsPage>
  );
}

// ── One account ──────────────────────────────────────────────────────────────────────────────────

export function SettingsAccountRoute() {
  useLocale();
  const { id = "" } = useParams();
  const nav = useNav();
  const scope = useScope();
  const accounts = useAccounts();
  const { start } = useSpaceActions();
  const body = accounts.body;
  const row = body?.accounts.find((a) => a.id === id);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Why the sign-in start failed, kept from the Add page (the account exists) or from a tap here.
  const [startError, setStartError] = useState<string | null>(() => takeStartError(id));
  const list = settingsSectionPath("accounts", scope);

  async function signIn(target: AccountRow) {
    if (busy) return;
    setBusy(true);
    setStartError(null);
    const isDefault = target.kind === "default";
    const outcome = await start(
      {
        what: { kind: "harness", id: target.harness },
        account: isDefault ? undefined : target.id,
        signIn: true,
        requestId: mintRequestId(),
      },
      {},
    );
    setBusy(false);
    if (outcome.kind === "done") return;
    setStartError(outcome.kind === "refused" && outcome.message !== "" ? outcome.message : t("accounts.signIn.unknown"));
  }

  async function confirmRemove(target: AccountRow) {
    if (busy) return;
    setBusy(true);
    const out = await mutate(() => removeAccount(target.id, mintRequestId()));
    setBusy(false);
    setRemoving(false);
    if (out.ok) nav.up(list);
  }

  if (row === undefined) {
    return (
      <SettingsPage title="accounts.title" parent={list}>
        <Unavailable status={accounts.status} />
        {accounts.status === "ready" && (
          <Notice tone="neutral" variant="box">
            {t("accounts.gone")}
          </Notice>
        )}
      </SettingsPage>
    );
  }

  const select = body?.harnesses.find((h) => h.id === row.harness)?.select;
  const isDefault = row.kind === "default";
  const seen = seenLine(row);

  return (
    <SettingsPage title="accounts.title" heading={accountName(row)} parent={list}>
      <div className="flex items-center gap-3">
        <AgentIcon agent={row.harness} className="size-9 rounded-md" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{accountName(row)}</p>
          <p className="text-xs text-muted-foreground">{[harnessLabel(body, row.harness), seen].filter((x) => x !== null).join(" · ")}</p>
        </div>
      </div>
      <SignedInRow identity={row.identity} sameLogin={sameLoginLine(body?.accounts ?? [], row)} />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{t(`accounts.kind.${row.kind}.title`)}</p>
        <Hint>{t(`accounts.kind.${row.kind}.body`)}</Hint>
      </div>
      {row.unlinked !== undefined && row.unlinked.length > 0 && (
        <Notice tone="caution" variant="box">
          {t("accounts.unlinked", { names: row.unlinked.join(", ") })}
        </Notice>
      )}
      {row.hooks === "missing" && select !== undefined && (
        <div className="flex flex-col gap-2">
          <Notice tone="caution" variant="box">
            {t("accounts.hooksMissing")}
          </Notice>
          <HooksLine text={`${select}=${row.folder} collie hooks install ${row.harness}`} />
        </div>
      )}
      <Bars windows={row.windows} long />
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">{t("accounts.detail.folder")}</p>
        <p className="break-all font-mono text-xs leading-5">
          {isDefault ? t("accounts.detail.folderDefault", { folder: row.folder }) : row.folder}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">{t("accounts.detail.terminal")}</p>
        <HooksLine text={row.startLine} />
        <Hint>{t("accounts.detail.terminalHint")}</Hint>
      </div>
      {startError !== null && (
        <Notice tone="danger" variant="box" announce="alert">
          {t("accounts.signIn.failed", { reason: startError })}
        </Notice>
      )}
      <div className="flex gap-2">
        {/* Where the account reads signed in, the action is Change login: its own page says what happens to
            the sessions that run, then starts the same sign-in (routes/settings-change-login.tsx). */}
        {offersChangeLogin(row) ? (
          <Button variant="outline" className="h-11 flex-1" disabled={busy} onClick={() => nav.down(changeLoginPath(row.id, scope))}>
            {t("accounts.changeLogin.action")}
          </Button>
        ) : (
          <Button variant="outline" className="h-11 flex-1" disabled={busy} onClick={() => void signIn(row)}>
            {t("accounts.detail.signIn")}
          </Button>
        )}
        {!isDefault && (
          <Button variant="ghost" className="h-11" disabled={busy} onClick={() => setRemoving(true)}>
            {t("accounts.detail.remove")}
          </Button>
        )}
      </div>
      <BottomSheet open={removing} onClose={() => setRemoving(false)} title={t("accounts.remove.title", { label: row.label })}>
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("accounts.removeNote")}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => setRemoving(false)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" variant="destructive" className="h-11 flex-1" disabled={busy} onClick={() => void confirmRemove(row)}>
              {t("accounts.detail.remove")}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </SettingsPage>
  );
}

/** A line to copy: mono on the muted ground, the copy button at the end. */
function HooksLine({ text }: { text: string }) {
  return (
    <CopyableBlock text={text}>
      <p className="break-all rounded-md bg-muted py-2 pl-2 pr-10 font-mono text-xs leading-5">{text}</p>
    </CopyableBlock>
  );
}
