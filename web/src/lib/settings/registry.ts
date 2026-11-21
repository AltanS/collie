import type { DashPrefs } from "@/hooks/use-dash-prefs";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import type { DesignPrefs } from "@/lib/design";
import type { HarnessPref } from "@/lib/harness-prefs";
import type { MessageKey } from "@/lib/i18n";

import type { SettingDef, Store, StorageKey } from "./types";

// THE ONE DECLARED LIST OF SETTINGS (ADR 0170). Every switch, choice, field, action, link and info line a person
// meets in Settings, in the pane's own sheets and beside the thing it changes, declared once. The Settings pages
// draw their rows with today's components and mark each with the id it draws (`components/setting-slot.tsx`); the
// search reads this list; `registry.test.ts` and `settings-marks.test.tsx` keep it complete.
//
// The order is page order, then group order, then the order on the page. A row shown only in a state names the state
// (`when`); a row of one pane, of one view or of the New page names its place as its page and is found by the search
// with the words of where it is.

const DESIGN: StorageKey = "collie:design:v1";
const DASH: StorageKey = "collie:dash-prefs:v1";
const DISPLAY: StorageKey = "collie:display-prefs:v4";

const local = (key: StorageKey): Store => ({ kind: "local", key });
const blob = (key: StorageKey, field: string): Store => ({ kind: "blob", key, field });
const route = (path: `/api/${string}`, per?: "machine" | "trick" | "pane" | "profile" | "device"): Store =>
  per === undefined ? { kind: "route", route: path } : { kind: "route", route: path, per };
const none: Store = { kind: "none" };

/** Search words of a row, beyond its label and hint. */
const words = (...keys: MessageKey[]): readonly MessageKey[] => keys;

const LIST = [
  // ── 1. Look and feel ──────────────────────────────────────────────────────────────────────────────
  { id: "look.intro", label: "settings.appearance.intro.title", hint: "settings.appearance.intro.body", kind: "info", scope: "device", page: "look", group: "theme", store: none, find: false },
  { id: "look.themesDocs", label: "settings.appearance.intro.docs", kind: "link", scope: "device", page: "look", group: "theme", store: none, find: false },
  { id: "look.theme", label: "theme.title", hint: "theme.description", kind: "choice", scope: "device", page: "look", group: "theme", store: blob(DESIGN, "theme"), words: words("settings.words.colours") },
  { id: "look.theme.about", label: "theme.about.title", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:themes:v1"), each: "theme", find: false },
  { id: "look.theme.browse", label: "theme.browse", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:themes:v1") },
  { id: "look.theme.import", label: "theme.import", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:themes:v1") },
  { id: "look.theme.paste", label: "theme.paste", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:themes:v1") },
  { id: "look.theme.export", label: "theme.export", kind: "action", scope: "device", page: "look", group: "theme", store: { kind: "browser", what: "clipboard" } },
  { id: "look.theme.remove", label: "theme.remove", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:themes:v1"), words: words("settings.words.delete") },
  { id: "look.theme.trial", label: "theme.trial.try", kind: "action", scope: "device", page: "look", group: "theme", store: local("collie:theme-trial:v1"), find: false },
  { id: "look.lightDark", label: "settings.lightDark.title", hint: "settings.theme.description", kind: "choice", scope: "device", page: "look", group: "theme", store: local("collie:theme:v1"), words: words("settings.words.darkMode") },
  { id: "look.character", label: "settings.character.title", hint: "settings.character.description", kind: "choice", scope: "device", page: "look", below: "character", group: "character", store: blob(DESIGN, "mark") },
  { id: "look.characterMoves", label: "settings.character.moves", hint: "settings.character.movesHint", kind: "switch", scope: "device", page: "look", below: "character", group: "character", store: blob(DESIGN, "markMoves") },
  { id: "look.language", label: "settings.language.title", hint: "settings.language.description", kind: "choice", scope: "device", page: "look", group: "text", store: local("collie:locale:v1") },
  { id: "look.typeface", label: "settings.typeface.title", hint: "settings.typeface.description", kind: "choice", scope: "device", page: "look", group: "text", store: blob(DESIGN, "font"), words: words("settings.words.font") },
  { id: "look.terminalFont", label: "settings.fonts.title", hint: "settings.fonts.description", kind: "choice", scope: "device", page: "look", group: "text", store: blob(DISPLAY, "fontFamily"), words: words("settings.words.font") },
  { id: "look.textSize.chat", label: "settings.textSize.chat", kind: "number", scope: "device", page: "look", group: "text", store: blob(DISPLAY, "chatFontSize"), also: ["pane-display"], words: words("settings.words.bigger") },
  { id: "look.textSize.terminal", label: "settings.textSize.terminal", kind: "number", scope: "device", page: "look", group: "text", store: blob(DISPLAY, "fontSize"), also: ["pane-display"], words: words("settings.words.bigger") },
  { id: "look.textSize.draft", label: "settings.textSize.draft", hint: "settings.fonts.draftSize.hint", kind: "number", scope: "device", page: "look", group: "text", store: blob(DISPLAY, "draftFontSize"), words: words("settings.words.bigger") },
  { id: "look.math", label: "settings.math.title", hint: "settings.math.description", kind: "choice", scope: "device", page: "look", group: "math", store: blob(DESIGN, "math"), words: words("settings.words.formula") },
  { id: "look.math.download", label: "settings.math.title", kind: "action", scope: "machine", page: "look", group: "math", store: route("/api/math"), find: false },
  { id: "look.math.remove", label: "settings.appearance.math.remove", kind: "action", scope: "machine", page: "look", group: "math", store: route("/api/math"), when: "math-ready", words: words("settings.words.delete", "settings.words.storage") },
  { id: "look.beltSize", label: "settings.beltSize.label", hint: "settings.beltSize.description", kind: "choice", scope: "device", page: "look", group: "layout", store: blob(DASH, "beltScale") },
  { id: "look.largeScreen", label: "settings.wideLayout.title", hint: "settings.wideLayout.hint", kind: "choice", scope: "device", page: "look", group: "layout", store: local("collie:wide-layout-mode:v1"), words: words("settings.words.desktop") },
  { id: "look.projectPictures", label: "settings.projectPictures.title", hint: "settings.projectPictures.hint", kind: "switch", scope: "device", page: "look", group: "layout", store: local("collie:project-pictures:v1") },
  { id: "look.floatingThings", label: "settings.floatingThings.label", hint: "settings.floatingThings.description", kind: "switch", scope: "device", page: "look", group: "layout", store: blob(DASH, "floatingThings") },

  // ── 2. Chat and terminal ──────────────────────────────────────────────────────────────────────────
  { id: "chat.view", label: "chat.mode.view.label", kind: "choice", scope: "device", page: "chat", group: "both", store: blob(DASH, "paneView"), also: ["pane-display", "pane-menu"] },
  { id: "chat.shortForm", label: "settings.display.shortForm.label", hint: "settings.display.shortForm.hint", kind: "switch", scope: "device", page: "chat", group: "both", store: blob(DISPLAY, "stretchText"), also: ["pane-display"], words: words("settings.words.stretchtext") },
  { id: "chat.toolCalls", label: "settings.tools.title", hint: "settings.tools.description", kind: "switch", scope: "device", page: "chat", group: "chat", store: blob(DASH, "showToolCalls"), also: ["pane-display"] },
  { id: "chat.compactions", label: "settings.compactions.title", hint: "settings.compactions.description", kind: "switch", scope: "device", page: "chat", group: "chat", store: blob(DASH, "showCompactions"), also: ["pane-display"] },
  { id: "chat.wrap", label: "settings.display.wrap.label", hint: "settings.display.wrap.hint", kind: "switch", scope: "device", page: "chat", group: "terminal", store: blob(DISPLAY, "wrap"), also: ["pane-display"] },
  { id: "chat.wholeReply", label: "settings.display.wholeReply.label", hint: "settings.display.fullReply.hint", kind: "switch", scope: "device", page: "chat", group: "terminal", store: blob(DISPLAY, "expandClippedReply"), also: ["pane-display"] },
  { id: "chat.rawTerminal", label: "settings.display.rawTerminal.label", hint: "settings.display.rawTerminal.hint", kind: "switch", scope: "device", page: "chat", group: "terminal", store: blob(DISPLAY, "rawTerminal"), also: ["pane-display"] },
  { id: "chat.zoomButton", label: "settings.zoomButton.title", hint: "settings.zoomPill.description", kind: "choice", scope: "device", page: "chat", group: "terminal", store: blob(DASH, "zoomPill") },
  { id: "chat.contextLimits", label: "settings.contextLimits.title", hint: "settings.contextLimits.hint", kind: "choice", scope: "device", page: "chat", group: "status", store: blob(DASH, "usageRow"), words: words("settings.words.usage") },
  { id: "chat.statusLine", label: "settings.harnesses.statusLine.label", hint: "settings.harnesses.statusLine.description", kind: "switch", scope: "device", page: "chat", group: "status", store: blob("collie:harness-prefs:v1", "statusLine"), each: "harness" },

  // ── 3. Keys and touch ─────────────────────────────────────────────────────────────────────────────
  { id: "keys.enterSends", label: "settings.enterSends.title", hint: "settings.enterSends.hint", kind: "switch", scope: "device", page: "keys", group: "typing", store: local("collie:enter-sends:v1"), words: words("settings.words.keyboard") },
  { id: "keys.sentSuggestions", label: "settings.sentSuggestions.title", hint: "settings.sentSuggestions.description", kind: "switch", scope: "device", page: "keys", group: "typing", store: blob(DISPLAY, "sentSuggestions") },
  { id: "keys.harnessShortcuts", label: "settings.harnessBar.title", hint: "settings.harnessBar.description", kind: "switch", scope: "device", page: "keys", group: "typing", store: local("collie:harness-bar:v1") },
  { id: "keys.shortcuts", label: "shortcuts.list.title", hint: "shortcuts.settings.description", kind: "action", scope: "device", page: "keys", group: "typing", store: none, when: "keyboard-seen", words: words("settings.words.keyboard") },
  { id: "keys.pad.edit", label: "keys.editor.title", hint: "keys.editor.intro", kind: "action", scope: "device", page: "keys", group: "pad", store: local("collie:key-board:v1"), also: ["keys-tray"] },
  { id: "keys.pad.presets", label: "keys.editor.presetsTitle", kind: "choice", scope: "device", page: "keys", group: "pad", store: local("collie:key-board:v1"), also: ["keys-tray"] },
  { id: "keys.pad.copy", label: "keys.editor.copy", kind: "action", scope: "device", page: "keys", group: "pad", store: { kind: "browser", what: "clipboard" }, also: ["keys-tray"] },
  { id: "keys.tapToType", label: "settings.display.tapToType.label", hint: "settings.display.tapToType.hint", kind: "switch", scope: "device", page: "keys", group: "touch", store: blob(DISPLAY, "tapToFocus"), also: ["pane-display"] },
  { id: "keys.hand", label: "settings.hand.title", hint: "settings.hand.description", kind: "choice", scope: "device", page: "keys", group: "touch", store: blob(DISPLAY, "hand"), words: words("settings.words.leftHanded") },
  { id: "keys.pinchZoom", label: "settings.pageZoom.title", hint: "settings.pageZoom.description", kind: "switch", scope: "device", page: "keys", group: "touch", store: blob(DASH, "pageZoom") },
  { id: "keys.paneNav", label: "settings.paneNav.title", hint: "settings.paneNav.hint", kind: "choice", scope: "device", page: "keys", group: "touch", store: blob(DISPLAY, "paneNav"), words: words("settings.words.gesture") },
  { id: "keys.haptics", label: "settings.haptics.title", hint: "settings.haptics.description", kind: "switch", scope: "device", page: "keys", group: "touch", store: local("collie:haptics:v1"), when: "can-vibrate", words: words("settings.words.vibrate") },
  { id: "keys.zen", label: "settings.zen.title", hint: "settings.zen.description", kind: "switch", scope: "device", page: "keys", group: "zen", store: local("collie:zen-enabled:v1") },
  { id: "keys.zenTurn", label: "settings.zen.turn.label", hint: "settings.zen.auto.hint", kind: "switch", scope: "device", page: "keys", group: "zen", store: local("collie:auto-zen-enabled:v1"), words: words("settings.words.landscape") },

  // ── 4. Notifications ──────────────────────────────────────────────────────────────────────────────
  { id: "notifications.push", label: "settings.push.title", hint: "settings.push.description", kind: "switch", scope: "device", page: "notifications", group: "device", store: { kind: "browser", what: "push-subscription" }, when: "push-server" },
  { id: "notifications.needsYou", label: "settings.notify.blocked.label", hint: "settings.notify.blocked.hint", kind: "switch", scope: "machine", page: "notifications", group: "when", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.finished", label: "settings.notify.done.label", hint: "settings.notify.done.hint", kind: "switch", scope: "machine", page: "notifications", group: "when", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.perAgent", label: "settings.notify.individual.label", hint: "settings.notify.individual.hint", kind: "switch", scope: "machine", page: "notifications", group: "when", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.newVersion", label: "settings.notify.newVersion.label", hint: "settings.notify.updates.hint", kind: "switch", scope: "machine", page: "notifications", group: "when", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.decisions", label: "settings.notify.decisionNow.label", hint: "settings.notify.decisionNow.hint", kind: "switch", scope: "machine", page: "notifications", group: "when", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.cacheCold", label: "settings.notify.cache.label", hint: "settings.notify.cache.hint", kind: "switch", scope: "machine", page: "notifications", group: "cache", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.cacheWatch", label: "settings.notify.watched.title", hint: "paneSettings.cacheWatch.hint", kind: "list", scope: "pane", page: "notifications", group: "cache", store: route("/api/notifications/cache-watch", "pane"), each: "pane", also: ["pane-settings"], when: "push-server" },
  { id: "notifications.machineLoad", label: "settings.notify.machines.label", hint: "settings.notify.machines.hint", kind: "switch", scope: "machine", page: "notifications", group: "load", store: route("/api/notifications/prefs"), when: "push-server" },
  { id: "notifications.load.cpu", label: "machines.alerts.cpu", hint: "machines.alerts.description", kind: "switch", scope: "machine", page: "notifications", below: "load/:machine", group: "load", store: route("/api/machines", "machine"), each: "machine", also: ["machine-page"], words: words("settings.words.load") },
  { id: "notifications.load.memory", label: "machines.alerts.mem", hint: "machines.alerts.description", kind: "switch", scope: "machine", page: "notifications", below: "load/:machine", group: "load", store: route("/api/machines", "machine"), each: "machine", also: ["machine-page"], words: words("settings.words.load") },
  { id: "notifications.load.disk", label: "machines.alerts.disk", hint: "machines.alerts.description", kind: "switch", scope: "machine", page: "notifications", below: "load/:machine", group: "load", store: route("/api/machines", "machine"), each: "machine", also: ["machine-page"], words: words("settings.words.load") },
  { id: "notifications.load.above", label: "machines.alerts.overLabel", kind: "choice", scope: "machine", page: "notifications", below: "load/:machine", group: "load", store: route("/api/machines", "machine"), each: "machine", also: ["machine-page"], find: false },
  { id: "notifications.load.for", label: "machines.alerts.forLabel", kind: "choice", scope: "machine", page: "notifications", below: "load/:machine", group: "load", store: route("/api/machines", "machine"), each: "machine", also: ["machine-page"], find: false },
  { id: "notifications.doNotDisturb", label: "settings.snooze.title", hint: "settings.snooze.description.idle", kind: "choice", scope: "machine", page: "notifications", group: "quiet", store: route("/api/notifications/snooze"), when: "push-server", words: words("settings.words.quiet") },
  { id: "notifications.clear", label: "settings.clearNotifications.title", hint: "settings.clearNotifications.description", kind: "action", scope: "machine", page: "notifications", group: "quiet", store: route("/api/notifications/clear"), when: "push-server" },

  // ── 5. Voice ──────────────────────────────────────────────────────────────────────────────────────
  { id: "voice.status", label: "settings.voice.status.label", kind: "info", scope: "device", page: "voice", group: "mic", store: none },
  { id: "voice.audio", label: "settings.voice.audio.label", kind: "info", scope: "device", page: "voice", group: "mic", store: none, find: false },
  { id: "voice.change", label: "settings.voice.change", kind: "action", scope: "device", page: "voice", group: "mic", store: none },
  { id: "voice.fix", label: "settings.voice.fix", kind: "action", scope: "machine", page: "voice", group: "mic", store: route("/api/stt"), find: false },
  { id: "voice.phone", label: "settings.voice.phoneSpeech.label", hint: "settings.voice.phoneSpeech.hint", kind: "choice", scope: "device", page: "voice", group: "phone", store: local("collie:stt-engine:v1"), words: words("settings.words.dictation") },
  { id: "voice.handsFree", label: "settings.handsFree.title", hint: "settings.handsFree.description", kind: "switch", scope: "device", page: "voice", group: "after", store: local("collie:stt-hands-free:v1"), when: "hands-free-offered" },
  { id: "voice.host", label: "settings.voice.host.label", hint: "settings.voice.host.hint", kind: "link", scope: "machine", page: "voice", group: "host", store: none, words: words("settings.words.dictation") },
  { id: "voice.model", label: "settings.voice.model.title", kind: "link", scope: "machine", page: "voice", group: "model", store: none },
  { id: "voice.host.uses", label: "settings.voice.hostPage.group", hint: "settings.voice.hostPage.intro", kind: "choice", scope: "machine", page: "voice", below: "host", group: "hostPage", store: route("/api/stt/host") },
  { id: "voice.host.useOnHost", label: "settings.voice.setup.whistle.useAction", kind: "action", scope: "machine", page: "voice", below: "host", group: "hostPage", store: route("/api/stt/host"), find: false },
  { id: "voice.host.useChatgpt", label: "settings.voice.setup.codex.useAction", kind: "action", scope: "machine", page: "voice", below: "host", group: "hostPage", store: route("/api/stt/host"), find: false },
  { id: "voice.host.useWhistle", label: "settings.voice.wrapper.switch", kind: "action", scope: "machine", page: "voice", below: "host", group: "hostPage", store: route("/api/stt/host"), find: false },
  { id: "voice.host.changeForAll", label: "settings.voice.confirm.action", kind: "action", scope: "machine", page: "voice", below: "host", group: "hostPage", store: route("/api/stt/host"), find: false },
  { id: "voice.model.setUp", label: "settings.voice.copy.setup", hint: "settings.voice.copy.setup.note", kind: "action", scope: "machine", page: "voice", below: "model", group: "model", store: route("/api/stt/whistle"), words: words("settings.words.whistle") },
  { id: "voice.model.removeHost", label: "settings.speech.host.remove", kind: "action", scope: "machine", page: "voice", below: "model", group: "model", store: route("/api/stt/whistle"), find: false },
  { id: "voice.model.copyToPhone", label: "settings.voice.copy.toPhone", kind: "action", scope: "device", page: "voice", below: "model", group: "model", store: { kind: "browser", what: "indexeddb-model" }, find: false },
  { id: "voice.model.removePhone", label: "settings.speech.phone.remove", kind: "action", scope: "device", page: "voice", below: "model", group: "model", store: { kind: "browser", what: "indexeddb-model" }, words: words("settings.words.delete", "settings.words.storage") },
  { id: "voice.model.restore", label: "settings.voice.restore", kind: "action", scope: "device", page: "voice", below: "model", group: "model", store: { kind: "browser", what: "indexeddb-model" }, find: false },
  { id: "voice.model.details", label: "settings.voice.details", kind: "info", scope: "machine", page: "voice", below: "model", group: "model", store: route("/api/stt/whistle"), find: false },

  // ── 6. Dashboard and projects ─────────────────────────────────────────────────────────────────────
  { id: "dashboard.paneOrder", label: "paneOrder.aria", hint: "settings.paneOrder.description", kind: "choice", scope: "device", page: "dashboard", group: "dashboard", store: blob(DASH, "paneOrder"), also: ["dashboard"] },
  { id: "dashboard.worktreeFolder", label: "settings.worktreeFolder.title", hint: "settings.worktreeFolder.description", kind: "text", scope: "machine", page: "dashboard", group: "projects", store: route("/api/worktree/folder", "machine"), each: "machine" },
  { id: "dashboard.changes.nested", label: "settings.changes.nested.label", hint: "settings.changes.nested.hint", kind: "switch", scope: "device", page: "dashboard", group: "changes", store: blob(DASH, "changesNested"), words: words("settings.words.repos") },
  { id: "dashboard.changes.depth", label: "settings.changes.depth.label", hint: "settings.changes.depth.hint", kind: "choice", scope: "device", page: "dashboard", group: "changes", store: blob(DASH, "changesDepth"), words: words("settings.words.repos") },

  // ── 7. Profiles ───────────────────────────────────────────────────────────────────────────────────
  { id: "accounts.intro", label: "accounts.intro", kind: "info", scope: "profile", page: "accounts", group: "profiles", store: none, when: "accounts-offered", find: false },
  { id: "accounts.profiles", label: "accounts.title", hint: "accounts.row.none", kind: "list", scope: "profile", page: "accounts", group: "profiles", store: route("/api/accounts", "profile"), each: "profile", when: "accounts-offered", words: words("settings.words.login") },
  { id: "accounts.add", label: "settings.group.accounts.add", kind: "link", scope: "profile", page: "accounts", group: "profiles", store: none, when: "accounts-offered" },
  { id: "accounts.removeNote", label: "accounts.removeNote", kind: "info", scope: "profile", page: "accounts", group: "profiles", store: none, when: "accounts-offered", find: false },
  { id: "accounts.found", label: "accounts.found.hint", kind: "info", scope: "profile", page: "accounts", group: "found", store: none, when: "accounts-offered", find: false },
  { id: "accounts.found.add", label: "accounts.found.addLabel", kind: "action", scope: "profile", page: "accounts", group: "found", store: route("/api/accounts"), when: "accounts-offered", find: false },
  { id: "accounts.add.harness", label: "accounts.add.agent", kind: "choice", scope: "profile", page: "accounts", below: "add", group: "add", store: route("/api/accounts"), find: false },
  { id: "accounts.add.name", label: "accounts.add.name", kind: "text", scope: "profile", page: "accounts", below: "add", group: "add", store: route("/api/accounts"), find: false },
  { id: "accounts.add.kind", label: "accounts.add.kind", kind: "choice", scope: "profile", page: "accounts", below: "add", group: "add", store: route("/api/accounts"), find: false },
  { id: "accounts.add.folder", label: "accounts.add.folder", kind: "text", scope: "profile", page: "accounts", below: "add", group: "add", store: route("/api/accounts"), find: false },
  { id: "accounts.add.create", label: "accounts.add.create", kind: "action", scope: "profile", page: "accounts", below: "add", group: "add", store: route("/api/accounts"), find: false },
  { id: "accounts.changeLogin", label: "accounts.changeLogin.action", hint: "accounts.changeLogin.what", kind: "action", scope: "profile", page: "accounts", below: ":id", group: "profile", store: none, each: "profile", also: ["pane-settings"], when: "has-profile" },
  { id: "accounts.signInAgain", label: "accounts.detail.signIn", kind: "action", scope: "profile", page: "accounts", below: ":id", group: "profile", store: none, each: "profile", words: words("settings.words.login") },
  { id: "accounts.remove", label: "accounts.detail.remove", kind: "action", scope: "profile", page: "accounts", below: ":id", group: "profile", store: route("/api/accounts/remove", "profile"), each: "profile", words: words("settings.words.delete", "settings.words.forget") },
  { id: "accounts.terminal", label: "accounts.detail.terminal", hint: "accounts.detail.terminalHint", kind: "info", scope: "profile", page: "accounts", below: ":id", group: "profile", store: none, find: false },
  { id: "accounts.login.start", label: "accounts.changeLogin.action", kind: "action", scope: "profile", page: "accounts", below: ":id/login", group: "login", store: none, find: false },
  { id: "accounts.login.open", label: "accounts.changeLogin.open", kind: "action", scope: "profile", page: "accounts", below: ":id/login", group: "login", store: none, find: false },
  { id: "accounts.login.finish", label: "accounts.changeLogin.finish", hint: "accounts.changeLogin.finishHint", kind: "action", scope: "profile", page: "accounts", below: ":id/login", group: "login", store: none, find: false },

  // ── 8. Tricks and the Hill ────────────────────────────────────────────────────────────────────────
  { id: "tricks.enabled", label: "settings.section.tricks.title", hint: "settings.tricks.switch.about", kind: "switch", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks"), experiment: true, words: words("settings.words.experiment") },
  { id: "tricks.waiting", label: "settings.tricks.waiting.title", kind: "info", scope: "machine", page: "tricks", group: "tricks", store: none, find: false },
  { id: "tricks.list", label: "settings.tricks.detail.on", kind: "switch", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks/switch", "trick"), each: "trick", when: "tricks-on", find: false },
  { id: "tricks.addRepo", label: "settings.tricks.repo.rowTrick", kind: "action", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks/repo/add"), when: "tricks-on" },
  { id: "tricks.addRepo.link", label: "settings.tricks.repo.linkLabel", kind: "text", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks/repo/add"), find: false },
  { id: "tricks.official.add", label: "settings.tricks.official.add", kind: "action", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks/official"), each: "trick", when: "official-newer", find: false },
  { id: "tricks.official.update", label: "settings.tricks.official.update", kind: "action", scope: "machine", page: "tricks", group: "tricks", store: route("/api/tricks/official"), each: "trick", when: "official-newer", find: false },
  { id: "tricks.hill", label: "settings.hill.label", hint: "settings.hill.hint", kind: "switch", scope: "machine", page: "tricks", group: "hill", store: route("/api/hill/switch"), experiment: true, words: words("settings.words.experiment", "settings.words.decisions") },
  { id: "tricks.trick.autoUpdate", label: "settings.tricks.about.autoUpdate.label", hint: "settings.tricks.about.auto.hint", kind: "switch", scope: "machine", page: "tricks", below: ":key", group: "trick", store: route("/api/tricks", "trick"), each: "trick" },
  { id: "tricks.trick.undo", label: "settings.tricks.undo", kind: "action", scope: "machine", page: "tricks", below: ":key", group: "trick", store: route("/api/tricks", "trick"), each: "trick", find: false },
  { id: "tricks.trick.fields", label: "settings.tricks.about.settingsHeading", hint: "settings.tricks.fields.noSecrets", kind: "text", scope: "machine", page: "tricks", below: ":key", group: "trick", store: route("/api/tricks", "trick"), each: "trick" },
  { id: "tricks.trick.about", label: "settings.tricks.detail.about", kind: "info", scope: "machine", page: "tricks", below: ":key", group: "trick", store: none, each: "trick", find: false },
  { id: "tricks.trick.code", label: "settings.tricks.about.code.title", kind: "action", scope: "machine", page: "tricks", below: ":key", group: "trick", store: route("/api/tricks", "trick"), each: "trick", find: false },
  { id: "tricks.trick.rules", label: "settings.tricks.about.rulesOpen", kind: "action", scope: "machine", page: "tricks", below: ":key", group: "trick", store: none, each: "trick", find: false },
  { id: "tricks.trick.repo", label: "settings.tricks.about.repoOpen", kind: "link", scope: "machine", page: "tricks", below: ":key", group: "trick", store: none, each: "trick", find: false },
  { id: "tricks.trick.remove", label: "settings.tricks.remove.button", hint: "settings.tricks.remove.line", kind: "action", scope: "machine", page: "tricks", below: ":key", group: "trick", store: route("/api/tricks", "trick"), each: "trick", words: words("settings.words.delete") },

  // ── 9. Devices and machines ───────────────────────────────────────────────────────────────────────
  { id: "devices.pair", label: "settings.devices.pair.title", hint: "settings.devices.pair.hint", kind: "action", scope: "device", page: "devices", group: "device", store: route("/api/pair"), words: words("settings.words.pairing") },
  { id: "devices.pair.code", label: "settings.devices.pair.codeLabel", kind: "text", scope: "device", page: "devices", group: "device", store: route("/api/pair"), find: false },
  { id: "devices.pair.name", label: "settings.devices.pair.nameLabel", kind: "text", scope: "device", page: "devices", group: "device", store: route("/api/pair"), find: false },
  { id: "devices.unpair", label: "settings.devices.unpairSelf", kind: "action", scope: "device", page: "devices", group: "device", store: route("/api/devices/revoke"), words: words("settings.words.signOut", "settings.words.forget", "settings.words.pairing") },
  { id: "devices.paired", label: "settings.devices.title", kind: "list", scope: "machine", page: "devices", group: "paired", store: route("/api/devices", "device"), each: "device", words: words("settings.words.pairing", "settings.words.unpair") },
  { id: "devices.revoke", label: "settings.devices.revoke", kind: "action", scope: "machine", page: "devices", group: "paired", store: route("/api/devices/revoke", "device"), each: "device", find: false },
  { id: "devices.machines", label: "machines.entry.title", hint: "machines.entry.description", kind: "link", scope: "machine", page: "devices", group: "machines", store: none, words: words("settings.words.load") },
  { id: "devices.crew", label: "crew.entry.title", hint: "crew.entry.description", kind: "link", scope: "machine", page: "devices", group: "machines", store: none, when: "crew" },
  { id: "devices.connection", label: "settings.connection.title", hint: "settings.connection.description", kind: "info", scope: "device", page: "devices", group: "connection", store: none },
  { id: "devices.connection.endpoint", label: "settings.connection.row.endpoint", kind: "info", scope: "device", page: "devices", group: "connection", store: none, find: false },
  { id: "devices.connection.secure", label: "settings.connection.row.secure", kind: "info", scope: "device", page: "devices", group: "connection", store: none, find: false },
  { id: "devices.connection.bridge", label: "settings.connection.row.bridge", kind: "info", scope: "machine", page: "devices", group: "connection", store: none, find: false },
  { id: "devices.connection.access", label: "settings.connection.row.deviceAccess", kind: "info", scope: "machine", page: "devices", group: "connection", store: none, find: false },
  { id: "devices.connection.masking", label: "settings.connection.row.secretMasking", kind: "info", scope: "machine", page: "devices", group: "connection", store: none },
  { id: "devices.connection.serverBuild", label: "settings.connection.row.serverBuild", kind: "info", scope: "machine", page: "devices", group: "connection", store: none, find: false },

  // ── 10. Privacy and data ──────────────────────────────────────────────────────────────────────────
  { id: "privacy.keepChat", label: "settings.keepChat.title", hint: "settings.keepChat.description", kind: "choice", scope: "device", page: "privacy", group: "phone", store: blob(DISPLAY, "keepChat"), words: words("settings.words.storage") },
  { id: "privacy.keepChat.clear", label: "settings.keepChat.clearNow", kind: "action", scope: "device", page: "privacy", group: "phone", store: { kind: "browser", what: "chat-store" }, words: words("settings.words.delete", "settings.words.storage") },
  { id: "privacy.telemetry", label: "telemetry.card.title", hint: "telemetry.card.description", kind: "switch", scope: "machine", page: "privacy", group: "leaves", store: route("/api/telemetry"), words: words("settings.words.installCount") },
  { id: "privacy.telemetry.next", label: "telemetry.card.next.show", kind: "action", scope: "machine", page: "privacy", below: "install-count", group: "installCount", store: route("/api/telemetry"), find: false },
  { id: "privacy.telemetry.docs", label: "telemetry.card.more", kind: "link", scope: "machine", page: "privacy", below: "install-count", group: "installCount", store: none, find: false },

  // ── 11. Updates and about ─────────────────────────────────────────────────────────────────────────
  { id: "updates.status", label: "settings.update.title", kind: "info", scope: "machine", page: "updates", group: "updates", store: route("/api/update/check"), find: false },
  { id: "updates.check", label: "settings.update.action", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update/check"), words: words("settings.words.version") },
  { id: "updates.offer", label: "settings.updateCard.title", kind: "info", scope: "machine", page: "updates", group: "updates", store: route("/api/update/check"), when: "update-waiting", find: false },
  { id: "updates.install", label: "settings.updateCard.action", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update"), when: "update-waiting", find: false },
  { id: "updates.crossMajor", label: "settings.updateCard.majorAction", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update"), when: "update-waiting", find: false },
  { id: "updates.remindLater", label: "settings.updateCard.dismiss", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update/dismiss"), when: "update-waiting", find: false },
  { id: "updates.rollBack", label: "settings.updateCard.rollback.action", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update/rollback"), find: false },
  { id: "updates.retry", label: "settings.updateCard.retry", kind: "action", scope: "machine", page: "updates", group: "updates", store: route("/api/update/check"), find: false },
  { id: "updates.crew", label: "settings.updateCard.peers.label", kind: "info", scope: "machine", page: "updates", group: "updates", store: route("/api/update/check"), when: "crew", find: false },
  { id: "updates.notes", label: "settings.updateCard.notes.page", kind: "link", scope: "machine", page: "updates", group: "updates", store: none, find: false },
  { id: "updates.releaseLine", label: "updates.line.title", hint: "updates.line.description", kind: "choice", scope: "machine", page: "updates", group: "line", store: route("/api/update/line"), words: words("settings.words.edge") },
  { id: "updates.releaseLine.goBack", label: "updates.line.back.goNow", kind: "action", scope: "machine", page: "updates", group: "line", store: route("/api/update/back"), when: "release-line-skew", find: false },
  { id: "updates.releaseLine.wait", label: "updates.line.back.wait", kind: "action", scope: "machine", page: "updates", group: "line", store: none, when: "release-line-skew", find: false },
  { id: "updates.installApp", label: "settings.install.title", hint: "settings.install.description", kind: "action", scope: "device", page: "updates", group: "app", store: { kind: "browser", what: "install-prompt" }, when: "install-offered", also: ["settings-index"] },
  { id: "updates.version", label: "settings.version.label", kind: "info", scope: "device", page: "updates", group: "app", store: none, also: ["settings-index"] },
  { id: "updates.firstScreen", label: "settings.tour.title", hint: "settings.tour.description", kind: "action", scope: "device", page: "updates", group: "app", store: local("collie:tour:v1"), words: words("settings.words.tour", "settings.words.help") },
  { id: "updates.reportOffer", label: "settings.report.title", hint: "settings.report.description", kind: "switch", scope: "device", page: "updates", group: "help", store: blob(DISPLAY, "reportOffer"), words: words("settings.words.feedback") },
  { id: "updates.report", label: "settings.report.open", kind: "action", scope: "device", page: "updates", group: "help", store: local("collie:report-episodes:v1"), also: ["pane-menu"], words: words("settings.words.bug", "settings.words.feedback") },

  // ── Only where it is used ─────────────────────────────────────────────────────────────────────────
  { id: "pane.rename", label: "paneActions.rename.label", kind: "action", scope: "pane", page: "pane", group: "settings", store: none, also: ["pane-settings", "pane-menu"] },
  { id: "pane.hooks", label: "paneSettings.hooks.live", kind: "info", scope: "pane", page: "pane", group: "settings", store: none, find: false },
  { id: "pane.recentSends", label: "sendReceipts.title", kind: "info", scope: "pane", page: "pane", group: "settings", store: none },
  { id: "pane.ownColours", label: "settings.display.ownColours.label", hint: "settings.display.ownColours.hint", kind: "switch", scope: "pane", page: "pane", group: "display", store: { kind: "per-key", prefix: "collie:mirror-native:", keyOf: "pane-scope" }, also: ["pane-display"], words: words("settings.words.colours") },
  { id: "pane.zen", label: "chat.zen.label", kind: "action", scope: "pane", page: "pane", group: "menu", store: none, when: "zen-on" },
  { id: "pane.pinToTop", label: "paneActions.pin.label", kind: "action", scope: "device", page: "pane", group: "menu", store: local("collie:pins:v1"), each: "pane" },
  { id: "pane.settings", label: "paneActions.settings.label", kind: "link", scope: "pane", page: "pane", group: "menu", store: none },
  { id: "pane.walkyTalky", label: "walky.off.label", hint: "walky.off.hint", kind: "switch", scope: "pane", page: "pane", group: "messages", store: route("/api/walky/off") },
  { id: "pane.trickView", label: "view.switch.hint", kind: "switch", scope: "pane", page: "pane", group: "menu", store: route("/api/trick-views/switch", "trick"), each: "trick", find: false },
  { id: "files.which", label: "files.mode.aria", kind: "choice", scope: "device", page: "files", group: "view", store: blob(DASH, "changesOnly") },
  { id: "files.showIgnored", label: "files.ignored.toggleAria", kind: "switch", scope: "device", page: "files", group: "view", store: blob(DASH, "filesShowIgnored") },
  { id: "files.layout", label: "files.view.aria", kind: "choice", scope: "device", page: "files", group: "view", store: blob(DASH, "changesLayout"), find: false },
  { id: "files.diffLayout", label: "files.diffLayout.label", kind: "choice", scope: "device", page: "files", group: "diff", store: local("collie:diff-layout:v1"), words: words("settings.words.diffLayout") },
  { id: "new.kind", label: "newPage.kind.agent", kind: "choice", scope: "device", page: "new", group: "page", store: local("collie:new-page:kind:v1"), find: false },
  { id: "new.again", label: "newPage.again", kind: "info", scope: "device", page: "new", group: "page", store: local("collie:new-sheet:again:v1"), find: false },
  { id: "new.favourite", label: "space.new.folders.star", kind: "action", scope: "machine", page: "new", group: "page", store: route("/api/folders/star"), find: false },
  { id: "new.launchers", label: "newPage.add", kind: "action", scope: "machine", page: "new", group: "page", store: route("/api/launchers/added") },
  { id: "dashboard-bar.needsYouOnly", label: "home.needsYouOnly", kind: "switch", scope: "device", page: "dashboard-bar", group: "bar", store: blob(DASH, "needsYouOnly") },
  { id: "dashboard-bar.machinesShown", label: "connection.server.show", hint: "connection.server.showLocked", kind: "switch", scope: "device", page: "dashboard-bar", group: "machines", store: local("collie:hidden-machines:v1"), each: "machine", when: "crew" },
  { id: "dashboard-bar.view", label: "home.tabs.aria", kind: "choice", scope: "device", page: "dashboard-bar", group: "bar", store: blob(DASH, "dashView"), find: false },
] as const satisfies readonly SettingDef[];

/** Every id the registry declares: a page marks its rows with these, and a typo does not compile. */
export type RegisteredId = (typeof LIST)[number]["id"];

export const SETTINGS: readonly SettingDef[] = LIST;

/**
 * Saved keys of the app that are not a setting a person sets, each with its reason. The completeness test reads
 * every key literal under `web/src` and fails one that no setting stores into and this list does not explain.
 */
export const NOT_SETTINGS: ReadonlyMap<string, string> = new Map([
  ["collie:draft:", "unsent words, not a choice"],
  ["collie:draft:v2:", "unsent words, not a choice"],
  ["collie:draft:back~", "unsent words waiting on Put back"],
  ["collie:device-token", "the pairing credential; Pair this device writes it"],
  ["collie:push-endpoint", "names this phone's push endpoint; the Push switch writes it"],
  ["collie:push-disabled", "the Push switch's memory of an Off, part of notifications.push"],
  ["collie:pairing-expires", "the pairing's expiry"],
  ["collie:shape:", "remembered page shapes for a calm first frame"],
  ["collie:derived:v1", "a cache of the colours derived from the applied theme: applyTheme rebuilds it, theme-init.js reads it for the first frame"],
  ["collie:session-later", "trick proposals closed with Not now"],
  ["collie:recent-panes:v1", "the panes this device opened last"],
  ["collie:slot:v1:", "a pane's reserved layout slot"],
  ["collie:wipe-pending", "an unpair's unfinished wipe"],
  ["collie:wipe-last", "when the last wipe ran"],
  ["collie:project-picture-copies:v1", "cached project pictures"],
  ["collie:project-picture-panes:v1", "which pane shows which picture"],
  ["collie:strips-collapsed:v1", "a strip folded on the Dashboard: a view's state"],
  ["collie:trouble-signalled:v1", "trouble already reported"],
  ["collie:wide-layout:v1", "the large screen's remembered layout: a view's state"],
  ["collie:wide-sidebar:v1", "the large screen's sidebar width: a view's state"],
  ["collie:pin-hint:v1", "a hint seen once"],
  ["collie:masked-hint:v1", "a hint seen once"],
  ["collie:pane-nav-hint:v1", "a hint seen once"],
  ["collie:keyboard-hint-done:v1", "a hint seen once"],
  ["collie.telemetryNotice.v1", "the Telemetry notice seen once"],
  ["collie:hardware-keyboard-seen:v2", "the condition of Keyboard shortcuts, not a value"],
  ["collie:diff-comments:v1:", "comments typed on a diff"],
  ["collie:tab-pane:v1:", "the pane a tab showed last"],
  ["collie:chat-silhouette:v1:", "a Chat view's remembered height"],
  ["collie:send-intent:", "a send in flight"],
  ["collie:create-intent:", "a start in flight"],
  ["collie:no-prompts-confirmed:v1", "a confirmation seen once"],
  ["collie:update-mode:closed:v1", "the update screen closed once"],
  ["collie:update-mode:v1", "the update screen in progress"],
  ["collie:auto-reloaded-for=", "a reload already done for a build"],
  ["collie:pwa:guardReload:v1", "a reload guard"],
  ["collie:math-reload:v1", "a reload after the math engines landed"],
  ["collie.slot.tab", "this tab's slot"],
  ["collie:preload-reload", "a reload after a failed chunk"],
  ["collie.nav.booted", "navigation memory"],
  ["collie.nav.seeded", "navigation memory"],
  ["collie.nav.pendingOpen", "a notification's target waiting for the app"],
  ["collie.nav.trail", "navigation memory"],
  ["collie:last-snapshot:", "dropped at boot by an older build's cleanup"],
  ["collie:last-pane:", "dropped at boot by an older build's cleanup"],
  ["collie:send-again:", "dropped at boot by an older build's cleanup"],
]);

/**
 * Every field of each JSON blob a setting stores into, from the blob's own type (ADR 0170). A key of the blob is one
 * storage key holding many values, so the storage-key check alone would pass a new field undeclared. `satisfies`
 * makes a field added to the type fail typecheck here until it is listed; `registry.test.ts` then fails a listed
 * field that no row stores into and `NOT_SETTING_FIELDS` does not explain. Types only: nothing of the hooks loads.
 */
export const BLOB_FIELDS = {
  [DISPLAY]: {
    wrap: true,
    fontSize: true,
    draftFontSize: true,
    chatFontSize: true,
    fontFamily: true,
    rawTerminal: true,
    tapToFocus: true,
    expandClippedReply: true,
    stretchText: true,
    keepChat: true,
    hand: true,
    sentSuggestions: true,
    paneNav: true,
    reportOffer: true,
  } satisfies Record<keyof DisplayPrefs, true>,
  [DASH]: {
    spacesOpen: true,
    shellsOpen: true,
    launchOpen: true,
    recentDir: true,
    isolatedSpaces: true,
    hiddenSpaces: true,
    changesNested: true,
    changesDepth: true,
    changesLayout: true,
    filesShowIgnored: true,
    changesOnly: true,
    beltScale: true,
    dashView: true,
    needsYouOnly: true,
    showToolCalls: true,
    showCompactions: true,
    paneOrder: true,
    paneView: true,
    zoomPill: true,
    pageZoom: true,
    usageRow: true,
    floatingThings: true,
  } satisfies Record<keyof DashPrefs, true>,
  [DESIGN]: { font: true, operatorFont: true, theme: true, math: true, mark: true, markMoves: true } satisfies Record<keyof DesignPrefs, true>,
  "collie:harness-prefs:v1": { statusLine: true } satisfies Record<keyof HarnessPref, true>,
} as const satisfies Partial<Record<StorageKey, Readonly<Record<string, true>>>>;

/** Fields of a blob that are no setting, by `<key>#<field>`, and why. */
export const NOT_SETTING_FIELDS: ReadonlyMap<string, string> = new Map([
  [`${DASH}#spacesOpen`, "whether the Spaces section is open, remembered from its header's tap"],
  [`${DASH}#shellsOpen`, "whether the Shells section of the pane switcher is open, remembered from its header's tap"],
  [`${DASH}#launchOpen`, "whether the Launch section is open, remembered from its header's tap"],
  [`${DASH}#recentDir`, "no screen sets or reads it now; the field stays so an older device's blob still parses"],
  [`${DASH}#isolatedSpaces`, "the dashboard's workspace filter, chosen in its own sheet: what the list shows now, not a preference"],
  [`${DASH}#hiddenSpaces`, "workspaces an older build hid; the workspace filter's sheet shows them and clears them"],
  [`${DESIGN}#operatorFont`, "a cache of the machine's own font faces (/api/config), never a choice on this device"],
]);
