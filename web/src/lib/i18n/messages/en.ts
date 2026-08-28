// The English dictionary — the source of truth for every string and every key.
//
// Shape rules, because the whole layer's type safety rests on them:
//   * FLAT object, dot-namespaced keys (`area.thing.part`). No nesting: a flat map is what makes
//     `keyof typeof en` a finite union of literals, which is what makes a missing translation a
//     compile error rather than a blank label at runtime.
//   * `as const` so the keys stay literal. Only English is `as const` — the other locales carry
//     different VALUES for the same keys, so they are typed `Record<MessageKey, string>`.
//   * `{name}` marks an interpolation slot; `t()` fills it. Slots are named, never positional,
//     because a translator re-orders a sentence and positions do not survive that.
//   * A plural comes as a `.one` / `.other` PAIR and is read through `tn()`, never `t()`.
//
// Seeded with the language-selector copy only — the full string sweep lands separately.

export const en = {
  "settings.language.title": "Language",
  "settings.language.description": "The terminal mirror is never translated.",

  // --- settings (page chrome) ---
  "settings.title": "Settings",
  "settings.nav.back": "Back",

  // --- settings.theme ---
  "settings.theme.title": "Appearance",
  "settings.theme.description": "Follow your phone, or pin one.",
  "settings.theme.option.system": "System",
  "settings.theme.option.light": "Light",
  "settings.theme.option.dark": "Dark",

  // --- settings.haptics ---
  "settings.haptics.title": "Haptics",
  "settings.haptics.description": "A short buzz when you press a key or a quick reply.",


  // --- settings.handsFree ---
  "settings.handsFree.title": "Hands-free voice",
  "settings.handsFree.description":
    "Send the transcript immediately instead of putting it in the message box. Off by default — you normally read what was heard before it reaches the terminal.",
  "settings.handsFree.ariaLabel": "Hands-free voice: send transcript immediately",

  // --- settings.push ---
  "settings.push.title": "Push notifications",
  "settings.push.description": "Get a notification when an agent needs you.",
  "settings.push.reason.insecure": "Push needs an HTTPS connection.",
  "settings.push.reason.serverOff": "Push isn't configured on the bridge (no VAPID keys).",
  "settings.push.reason.denied":
    "Notifications are blocked — enable them in your browser settings.",
  "settings.push.reason.unsupported": "This browser doesn't support push notifications.",
  "settings.push.reason.default": "Couldn't enable push notifications.",
  "settings.push.availability.insecure":
    "Unavailable over plain HTTP — serve Collie over HTTPS to enable push.",
  "settings.push.availability.serverOff":
    "The bridge has no VAPID keys configured, so push is disabled server-side.",
  "settings.push.availability.denied":
    "Notifications are blocked for this site. Re-enable them in your browser settings.",
  "settings.push.availability.unsupported": "This browser doesn't support push notifications.",

  // --- settings.notify ---
  "settings.notify.title": "Notify when",
  "settings.notify.description": "Applies to all devices.",
  "settings.notify.blocked.label": "Needs input",
  "settings.notify.blocked.hint": "an agent is waiting on you",
  "settings.notify.done.label": "Finished",
  "settings.notify.done.hint": "an agent completes its task",
  "settings.notify.updates.label": "App updates",
  "settings.notify.updates.hint": "a new Collie version is available",

  // --- settings.snooze ---
  "settings.snooze.title": "Do not disturb",
  "settings.snooze.description.idle": "Pause all push notifications for a while.",
  "settings.snooze.description.active": "Snoozed until {time} — no pushes until then.",
  "settings.snooze.resume": "Resume now",
  "settings.snooze.preset.min30": "30m",
  "settings.snooze.preset.hour1": "1h",
  "settings.snooze.preset.hour4": "4h",

  // --- settings.devices ---
  "settings.devices.title": "Paired devices",
  "settings.devices.description.enforced": "Every write needs a paired device. Reading stays open.",
  "settings.devices.description.open":
    "Nothing is paired, so writes are ungated. Pair a device to require a credential.",
  "settings.devices.pairedAs": "This device is paired as {device}.",
  "settings.devices.loadError": "Couldn’t load the paired devices from the bridge.",
  "settings.devices.thisDevice": "This device",
  "settings.devices.row.meta": "Paired {paired} · last seen {lastSeen}",
  "settings.devices.revokeError": "Couldn’t revoke that device.",
  "settings.devices.cancel": "Cancel",
  "settings.devices.unpairSelf": "Unpair this phone",
  "settings.devices.revoke": "Revoke",
  "settings.devices.revokeAria": "Revoke {label}",
  "settings.devices.pair.title": "Pair this device",
  "settings.devices.pair.hint": "Run {command} on the host and type the code it prints.",
  "settings.devices.pair.codeLabel": "Pairing code",
  "settings.devices.pair.codePlaceholder": "8 characters",
  "settings.devices.pair.nameLabel": "Name for this device",
  "settings.devices.pair.namePlaceholder": "e.g. my phone",
  "settings.devices.pair.networkError":
    "Couldn’t reach the bridge to pair. Check the connection and try again.",
  "settings.devices.pair.failure.noPending":
    "No pairing code is waiting. Run `bin/collie pair` on the host to mint one.",
  "settings.devices.pair.failure.expired":
    "That code has expired. Run `bin/collie pair` on the host for a fresh one.",
  "settings.devices.pair.failure.exhausted":
    "Too many wrong codes, so that pairing was destroyed. Run `bin/collie pair` on the host to mint a new one.",
  "settings.devices.pair.failure.badCode":
    "That code doesn’t match. Check it and try again — a few more wrong tries and it’s destroyed.",
  "settings.devices.pair.failure.duplicateLabel":
    "A device is already using that name. Pick a different one — the code is still good.",
  "settings.devices.pair.failure.badRequest":
    "The code or the name wasn’t usable. A name is 1–48 characters.",

  // --- settings.connection ---
  "settings.connection.title": "Connection",
  "settings.connection.description": "Diagnostics for this device.",
  "settings.connection.row.endpoint": "Endpoint",
  "settings.connection.row.secure": "Secure context",
  "settings.connection.row.bridge": "Bridge",
  "settings.connection.row.deviceAccess": "Device access",
  "settings.connection.row.serverBuild": "Server build",
  "settings.connection.secure.yes": "Yes",
  "settings.connection.secure.no": "No (plain HTTP)",
  "settings.connection.bridge.connected": "Connected",
  "settings.connection.bridge.offline": "Herdr offline",
  "settings.connection.bridge.connecting": "Connecting…",
  "settings.connection.device.notEnforced": "Not enforced",
  "settings.connection.device.fullAccessNamed": "Full access · {device}",
  "settings.connection.device.fullAccessLocal": "Full access (local)",
  "settings.connection.device.readOnlyNamed": "Read-only · {device}",
  "settings.connection.device.readOnly": "Read-only",

  // --- settings.update (update-check-control + footer update banner) ---
  "settings.update.title": "Updates",
  "settings.update.check.prompt": "Check whether a new Collie version is available.",
  "settings.update.check.running": "Running v{current}",
  "settings.update.check.runningChecked": "Running v{current} · checked {checked}",
  "settings.update.action": "Check for updates",
  "settings.update.checking": "Checking…",
  "settings.update.error": "Couldn't check.",
  "settings.update.upToDate": "Up to date",
  "settings.updateBanner.restart": "Bridge restart needed",
  "settings.updateBanner.releaseAvailable": "Collie {version} available",
  "settings.updateBanner.majorAvailable": "Collie {version} — a new major",
  "settings.updateBanner.copyAria": "Copy command: {command}",

  // --- settings.display (mirror display prefs, behind the composer's ⚙ dock) ---
  "settings.display.wrap.label": "Wrap lines",
  "settings.display.wrap.hint":
    "Off shows column-faithful output for TUI tables — you pan instead.",
  "settings.display.tapToType.label": "Tap to type",
  "settings.display.tapToType.hint":
    "On, tapping the mirror anywhere opens the keyboard. Off, the mirror behaves like a document — taps land on the text and only the composer opens the keyboard.",
  "settings.display.rawTerminal.label": "Raw terminal",
  "settings.display.rawTerminal.hint":
    "Shows the plain mirror — no tappable prompt buttons, no chrome or status strips. Use it when a dialog renders wrong and you want to drive it by hand from Keys.",
  "settings.display.textSize.label": "Text size",
  "settings.display.textSize.decrease": "Decrease font size",
  "settings.display.textSize.increase": "Increase font size",

  // --- settings.buildStamp ---
  "settings.buildStamp.tapToUpdate": "new build — tap to update",
  "settings.buildStamp.updating": "updating…",

  // --- composer (the reply box + its Keys/Quick/Display docks) ---
  "composer.dock.closeAria": "Close {title}",
  "composer.controls.label": "Controls",
  "composer.controls.keys": "Keys",
  "composer.controls.typeAria": "Type into terminal",
  "composer.controls.type": "Type",
  "composer.controls.quick": "Quick",
  "composer.controls.agent": "Agent",
  "composer.controls.displayAria": "Display settings",
  "composer.controls.display": "Display",
  "composer.sentPreview.label": "You sent:",
  "composer.placeholder.gone": "Pane is gone",
  "composer.placeholder.readOnly": "Read-only — device not authorised",
  "composer.placeholder.noMuxSend": "This terminal can't be typed into from here",
  "composer.placeholder.direct": "Type into the terminal…",
  "composer.placeholder.shell": "Type a shell command…",
  "composer.placeholder.reply": "Type a reply…",
  "composer.mic.unavailable": "Voice input is unavailable",
  "composer.mic.stopAria": "Stop recording",
  "composer.mic.recordAria": "Record a voice message",
  "composer.mic.transcribing": "Transcribing…",
  "composer.mic.recording": "Recording {elapsed}",
  "composer.mic.handsFreeHint": "will send when you stop",
  "composer.mic.manualHint": "lands in the message box",
  "composer.mic.stop": "Stop",
  "composer.mic.discardAria": "Discard recording",
  "composer.attach.aria": "Attach image",
  "composer.send.typeAnyway": "Type anyway?",
  "composer.send.reallySend": "Really send?",
  "composer.send.stopTypingAria": "Stop typing into terminal",
  "composer.send.sendAria": "Send",
  "composer.draft.tooLong":
    "Too long to keep as a saved draft — it survives switching panes, but not closing the app.",
  "composer.status.dialogWaiting": "A dialog is waiting — answer it first, then send.",
  "composer.status.paneNotWritable": "Pane is no longer writable — nothing was sent",
  "composer.status.inputChanged":
    "The input box changed while clearing it — nothing was typed. Check the pane.",
  "composer.status.clearFailed": "Couldn't clear the terminal input",
  "composer.status.sent": "Sent ✓",
  "composer.status.tapAgainToType": "{error} Tap Send again to type anyway.",
  "composer.discard.confirmKeys.one": "Tap again to discard {count} queued key",
  "composer.discard.confirmKeys.other": "Tap again to discard {count} queued keys",
  "composer.destructive.confirm": "Destructive: {reason} — tap Send again to confirm",
  "composer.destructive.confirmOnHost": "Destructive: {reason} on {host} — tap Send again to confirm",
  "composer.upload.success": "Image added — path in message",
  "composer.noEcho.title": "Password prompt — nothing echoes",
  "composer.noEcho.noLiveTyped":
    "What you typed is already in the pane, unsubmitted — but this view isn't live, so nothing can be sent from here. Answer it at the terminal.",
  "composer.noEcho.noLiveUntyped":
    "Nothing was typed. This view isn't live, so the keys that would work can't be sent from here.",
  "composer.noEcho.liveTyped":
    "What you typed is already in the pane — it just can't be confirmed, so it wasn't submitted. Press Enter in Type, and don't send it again.",
  "composer.noEcho.liveUntyped":
    "Send confirms what it typed, and this prompt shows nothing to confirm. Type sends your keys straight through, Enter included.",
  "composer.noEcho.useType": "Use Type",
  "composer.noEcho.dismissAria": "Dismiss password-prompt notice",
  "composer.draftPreview.title": "Draft in terminal",
  "composer.draftPreview.takeOver": "Take over",

  // --- sendMode (the armed "typing straight through" indicator) ---
  "sendMode.armed.title": "Typing into terminal",
  "sendMode.armed.hint": "keys go straight through",
  "sendMode.armed.stop": "Stop",

  // --- chat (the pane view shell: header, mirror, switcher) ---
  "chat.find.aria": "Find in output",
  "chat.history.aria": "Conversation history",
  "chat.header.openOverviewAria": "Open {workspace} overview",
  "chat.header.agentGone": "(agent gone)",
  "chat.scrollback.showHistory": "Show entire history",
  "chat.scrollback.loadOlder": "Load older",
  "chat.scrollback.loading": "Loading…",
  "chat.scrollback.noSessionReported":
    "{agent} has not reported a session to Herdr. Install or update the Herdr integration for it, then restart the agent in this pane.",
  "chat.output.empty": "(no recent output)",
  "chat.switcher.aria": "Switch pane",
  "chat.switcher.title": "Switch pane",
  "chat.status.feedbackSent": "Feedback sent",
  "chat.status.sent": "Sent",
  "chat.status.menuChanged": "Menu changed — refreshing",
  "chat.status.sendFailed": "Send failed",
  "chat.status.wizardChanged": "Wizard changed — refreshing",
  "chat.status.noteSaved": "Note saved",
  "chat.status.noteRemoved": "Note removed",
  "chat.status.dialogChanged": "Dialog changed — refreshing",
  "chat.status.selectionChanged": "Selection changed — refreshing",
  "chat.status.screenChanged": "The screen changed — refreshing",
  "chat.status.readOnly": "Read-only — device not authorised",

  // --- prompt (the native prompt-select / plan-feedback block) ---
  "prompt.family.select": "Choose an option",
  "prompt.family.permission": "Permission required",
  "prompt.family.trust": "Trust this folder?",
  "prompt.family.plan": "Review the plan",
  "prompt.sendingAria": "Sending",
  "prompt.feedback.cancel": "Cancel",
  "prompt.feedback.typedAria": "Feedback in the terminal",
  "prompt.feedback.planChange.offer": "Tell Claude what to change",
  "prompt.feedback.planChange.editorLabel": "What should Claude change?",
  "prompt.feedback.planChange.textAria": "Feedback text",
  "prompt.feedback.planChange.placeholder": "Say what to do differently…",
  "prompt.feedback.planChange.help":
    "Sends the plan back with your notes — Claude keeps planning instead of starting work.",
  "prompt.feedback.planChange.send": "Send feedback",
  "prompt.feedback.planChange.sending": "Sending feedback…",
  "prompt.feedback.planChange.focused":
    "The feedback box has the keyboard in the terminal — these buttons would type into it instead of answering. They resume when it closes.",
  "prompt.feedback.planChange.typedPrefix": "Feedback is being written in the terminal: ",
  "prompt.feedback.freeText.focused":
    "The free-text row has the keyboard in the terminal — these buttons would type into it instead of answering. They resume when it closes.",
  "prompt.feedback.freeText.typedPrefix": "A custom answer is being written in the terminal: ",

  // --- paneActions (long-press sheet: rename / close a pane) ---
  "paneActions.title.fallback": "Pane",
  "paneActions.readOnly": "Read-only — this device isn't authorised to rename or close panes.",
  "paneActions.hostBlockSuffix": "{hostBlock} — rename and close are unavailable until it answers.",
  "paneActions.rename.label": "Rename",
  "paneActions.rename.placeholder": "name this pane",
  "paneActions.close.label": "Close pane",
  "paneActions.close.confirm": "Tap again to close",
  "paneActions.close.closing": "Closing…",
  "paneActions.showInTerminal.label": "Show in terminal",
  "paneActions.showInTerminal.done": "Shown in the terminal",
  "paneActions.showInTerminal.failed": "Couldn't show it in the terminal",
  "paneActions.empty.fallback": "This multiplexer offers no actions for a pane.",
  "paneActions.status.renamed": "Renamed",
  "paneActions.status.labelCleared": "Label cleared",
  "paneActions.status.renameFailed": "Rename failed",
  "paneActions.status.closeFailed": "Close failed",

  // --- keys (the inline Keys tray + its staging strip) ---
  "keys.tab.keys": "Keys",
  "keys.presets.label": "Presets",
  "keys.fkeys.label": "F keys",
  "keys.confirm.label": "Confirm?",
  "keys.queue.removeAria": "Remove {label}",
  "keys.queue.charPlaceholder": "key",
  "keys.queue.charAria": "Type a key to combine",
  "keys.queue.send": "Send",
  "keys.queue.clearAria": "Clear queued keys",

  // --- nav (app header, Collie mark, settings gear) ---
  "nav.settings.aria": "Settings",
  "nav.home.aria.default": "Collie home",
  "nav.home.aria.lost": "Collie home — not connected",
  "nav.home.aria.reconnecting": "Collie home — reconnecting",
  "nav.mux.onPrefix": "on",
  "nav.prereleaseTitle": "Pre-release build — {version}",

  // --- home (dashboard herd list) ---
  "home.empty.disconnected": "Disconnected",
  "home.empty.disconnectedAt": "Disconnected — last seen {time}",
  "home.empty.noAgents": "No agents running.",
  "home.empty.waiting": "Waiting for Herdr…",
  "home.empty.panesHint": "Your panes are under Spaces.",
  "home.allClear": "Nothing needs you",
  "home.sort.newest": "Newest",
  "home.sort.oldest": "Oldest",
  "home.sort.aria.newest": "Sorted by most recently used first — switch to oldest first",
  "home.sort.aria.oldest": "Sorted by oldest first — switch to most recently used first",
  "home.sidebar.shells": "Shells",
  "home.sidebar.paneActionsTitle": "Tap for pane actions",

  // --- status (triage sections, status labels, counts) ---
  "status.section.needsYou": "Needs you",
  "status.section.readyUnseen": "Ready · unseen",
  "status.section.working": "Working",
  "status.section.recent": "Recent",
  "status.label.blocked": "needs you",
  "status.label.working": "working",
  "status.label.idle": "idle",
  "status.label.done": "done",
  "status.label.unknown": "unknown",
  "status.count.needsYou.one": "{count} needs you",
  "status.count.needsYou.other": "{count} needs you",
  "status.count.working.one": "{count} working",
  "status.count.working.other": "{count} working",
  "status.shellBadge": "shell",
  "status.dismissAria": "Dismiss",

  // --- space (spaces overview/strip/view, tabs, panes, new-space) ---
  "space.overview.title": "Spaces",
  "space.overview.new.aria": "New space",
  "space.overview.filter.placeholder": "Filter spaces…",
  "space.overview.filter.aria": "Filter spaces",
  "space.overview.empty.none": "No spaces yet.",
  "space.overview.empty.noMatch": "No space matches “{query}”.",
  "space.overview.needsYou.one": "{count} space needs you",
  "space.overview.needsYou.other": "{count} spaces need you",
  "space.overview.paneCount.one": "{count} pane",
  "space.overview.paneCount.other": "{count} panes",
  "space.strip.back": "Back",
  "space.strip.title": "Spaces",
  "space.strip.all": "All",
  "space.view.tabCount.one": "{count} tab",
  "space.view.tabCount.other": "{count} tabs",
  "space.view.paneCount.one": "{count} pane",
  "space.view.paneCount.other": "{count} panes",
  "space.view.emptyTab": "(empty tab)",
  "space.view.noPanesInTab": "This tab has no panes.",
  "space.view.noPanesInSpace": "This space has no panes.",
  "space.tabStrip.title": "Tabs",
  "space.tabStrip.all": "All",
  "space.tabStrip.new.aria": "New tab",
  "space.paneStrip.title": "Panes",
  "space.new.title": "New space",
  "space.new.dir.label": "Directory (optional)",
  "space.new.dir.placeholder": "~ (home dir)",
  "space.new.label.label": "Label (optional)",
  "space.new.label.placeholder": "name this space",
  "space.new.create": "Create space & open shell",
  "space.tab.titleFallback": "Tab",
  "space.tab.titleWithLabel": "Tab {label}",
  "space.tab.readOnly": "Read-only — this device isn't authorised to rename or close tabs.",
  "space.tab.hostBlockSuffix": "{hostBlock} — rename and close are unavailable until it answers.",
  "space.tab.rename": "Rename",
  "space.tab.close": "Close tab",
  "space.tab.closing": "Closing…",
  "space.tab.closeConfirm.one": "Tap again to close {count} pane",
  "space.tab.closeConfirm.other": "Tap again to close {count} panes",
  "space.tab.closeConfirmPlain": "Tap again to close",
  "space.tab.empty.fallback": "This multiplexer offers no actions for a tab.",
  "space.tab.placeholder": "name this tab",
  "space.tab.renamed": "Renamed",
  "space.tab.renameFailed": "Rename failed",
  "space.tab.closeFailed": "Close failed",
  "space.readOnly.notPaired": "Not paired — pair this device in Settings",
  "space.readOnly.deviceUnauthorised": "Read-only — device not authorised",
  "space.create.ready": "New {what} ready — launch your agent",
  "space.noun.tab": "tab",
  "space.noun.space": "space",

  // --- actionSheet (shared rename/back/save rows behind pane + tab long-press sheets) ---
  "actionSheet.back": "Back",
  "actionSheet.label": "Label",
  "actionSheet.save": "Save",

  // --- commands (agent command palette) ---
  "commands.title": "Agent commands",
  "commands.search.placeholder": "Search {count} commands…",
  "commands.common.hint": "Common · type to search all {count}",
  "commands.empty": "No commands match “{query}”.",
  "commands.confirm": "Confirm?",

  // --- quickActions (one-tap reply dock) ---
  "quickActions.group.confirm": "confirm",
  "quickActions.group.common": "common",

  // --- find (the in-mirror / in-history find bar) ---
  "find.placeholder": "Find in {subject}…",
  "find.aria": "Find in {subject}",
  "find.prevAria": "Previous match",
  "find.nextAria": "Next match",
  "find.closeAria": "Close find",
  "find.subject.output": "output",
  "find.subject.history": "history",

  // --- connection (banner, read-only strip, host chip/stale banner, session/server switchers) ---
  "connection.auth.message": "Access refused. This is not a connection problem.",
  "connection.auth.signIn": "Sign in",
  "connection.reload.aria": "Reload",
  "connection.retry": "Retry",
  "common.closeAria": "Close",
  "common.scrollToLatestAria": "Scroll to latest",
  "connection.connected": "Connected",
  "connection.reconnecting": "Reconnecting…",
  "connection.herdrDown": "Herdr is down on the host",
  "connection.offlineCantReach": "Offline — can't reach Collie",
  "connection.cantReach": "Can't reach Collie",
  "connection.withLastSeen": "{cause} — last seen {time}",
  "connection.readOnly.notPaired": "Not paired — pair this device in Settings to type into agents.",
  "connection.readOnly.device": "Read-only — this device isn’t authorised to type into agents{deviceSuffix}.",
  "connection.host.lastSeen": "last seen {time}",
  "connection.host.neverSeen": "never seen",
  "connection.host.unreachablePlain": "unreachable",
  "connection.host.unreachableSuffix": "unreachable · {label}",
  "connection.host.incompatible": "incompatible",
  "connection.host.lead": "lead",
  "connection.host.onPrefix": "on",
  "connection.host.ariaSends": "Sends to host: {name}{unreachable}",
  "connection.host.ariaHost": "Host: {name}{unreachable}",
  "connection.host.ariaUnreachableSuffix": " (unreachable)",
  "connection.stale.incompatible": "{name} is running an incompatible Collie",
  "connection.stale.unreachable": "{name} is unreachable · {label}",
  "connection.stale.nothingCached": "Nothing cached for this machine yet.",
  "connection.stale.showingLastKnown":
    "Showing the last known screen — replies and keys are refused until it answers.",
  "connection.stale.waitingFirst": "Nothing from {name} yet — waiting for its first answer.",
  "connection.stale.messageTemplate": "{reason}. {detail}",
  "connection.session.title": "Sessions",
  "connection.session.aria": "Session: {name}. Switch session",
  "connection.session.primary": "primary",
  "connection.session.unreachable": "unreachable",
  "connection.server.title": "Machines",
  "connection.server.aria": "Host: {name}. Switch host",

  // --- pack (the read-only /pack census; role names stay English, ADR 0030) ---
  "pack.title": "Pack",
  "pack.nav.back": "Back",
  "pack.entry.title": "Pack overview",
  "pack.entry.description": "How every machine in the pack is doing.",
  "pack.footer.label": "Pack · {machines} · {reachable}",
  "pack.footer.aria": "Open the pack overview",
  "pack.summary.counts": "{machines} · {reachable}",
  "pack.summary.machines.one": "{count} machine",
  "pack.summary.machines.other": "{count} machines",
  "pack.summary.reachable": "{count} reachable",
  "pack.summary.deputy": "Deputy",
  "pack.summary.noDeputy": "no deputy named",
  "pack.summary.warrant": "warrant {generation}",
  "pack.summary.secret": "Secret",
  "pack.summary.secretValue": "generation {generation} · rotated {time}",
  "pack.member.health": "State",
  "pack.member.reason": "Reason",
  "pack.member.conflict": "Conflict",
  "pack.member.conflictValue": "{lead} also leads · warrant {generation}",
  "pack.member.conflictNoWarrant": "{lead} also leads · no warrant",
  "pack.member.version": "Version",
  "pack.member.versionDiffers": "differs from lead",
  "pack.member.address": "Address",
  "pack.member.enrolled": "Enrolled",
  "pack.member.secretBehind": "Has not picked up the current secret.",
  "pack.member.provisional": "Enrolled but never reached.",
  "pack.health.reachable": "reachable",
  "pack.health.unreachable": "unreachable",
  "pack.health.incompatible": "incompatible",
  "pack.health.conflicted": "conflicted",
  "pack.role.deputy": "deputy",
  "pack.sheet.goTo": "Go to this machine",
  "pack.formation.aria": "Pack formation: {machines}",
  "pack.node.aria": "{name}, {role}, {health}",
  "pack.node.ariaPlain": "{name}, {health}",
  "pack.solo.title": "This collie is not leading a pack",
  "pack.solo.description": "A pack is created and changed from the command line.",
  "pack.error.title": "Could not load pack status",
  "pack.error.description": "The bridge did not answer. Collie tries again on the next poll.",

  // --- error (boot splash, route-level error recovery) ---
  "error.boot.connecting": "Connecting to the herd…",
  "error.boot.title": "Not connected",
  "error.boot.body": "Can’t reach Collie — check your connection to the host, then try again.",
  "error.boot.retry": "Retry",
  "error.root.title": "Something went wrong",
  "error.root.unknown": "Unknown error",
  "error.root.reload": "Reload",

  // --- idle (the idle-pause cover) ---
  "idle.dialogAria": "Collie paused",
  "idle.catchingUp.title": "Catching up",
  "idle.catchingUp.body": "Fetching the herd's current state.",
  "idle.paused.title": "Paused",
  "idle.paused.body":
    "Live updates stopped while this screen sat idle — what's behind this is frozen. Resuming picks up right where you left off.",
  "idle.resume": "Tap to resume",

  // --- pwa (self-update banner) ---
  "pwa.updateAvailable": "New version — tap to update",

  // --- history (pane transcript route) ---
  "history.unavailable.disabled": "Transcript history is switched off on this bridge (COLLIE_TRANSCRIPT).",
  "history.unavailable.noSession": "This pane has no agent session, so there's no transcript to read.",
  "history.unavailable.noLog": "No transcript file was found for this pane's session yet.",
  "history.unavailable.error": "Couldn't read the transcript. Pull back and try again.",
  "history.findAria": "Find in history",
  "history.closeAria": "Close history",
  "history.title": "History",
  "history.loadOlder": "Load older",
  "history.loading": "Loading…",
  "history.startClipped": "Start of the readable transcript (the log was clipped at the read cap)",
  "history.startOfConversation": "Start of the conversation",
  "history.prevMessageAria": "Previous message you sent",
  "history.nextMessageAria": "Next message you sent",
  "history.loadOlderFailed": "Couldn't load older history",

  // --- transcript (transcript-view turn rendering) ---
  "transcript.summaryLabel": "Context compacted",
  "transcript.systemLabel": "System",
  "transcript.youLabel": "You",
  "transcript.agentFallback": "agent",
  "transcript.outputTruncated": "… output truncated",
  "transcript.truncated": "… truncated",

  // --- time (relative/clock formatting) ---
  "time.justNow": "just now",
  "time.compact.now": "now",

  // --- sync (how fresh the herd on screen is, and asking for a fresher one) ---
  "sync.pull.hint": "Pull to refresh",
  "sync.pull.release": "Release to refresh",
  "sync.pull.busy": "Refreshing…",

  // --- dialog (menu / multi-select / wizard / preview-select block renderers) ---
  "dialog.sendingAria": "Sending",
  "dialog.previousStepAria": "Previous step",
  "dialog.nextStepAria": "Next step",
  "dialog.answeredAria": "Answered",
  "dialog.submitChip": "Submit",
  "dialog.stepPosition.step": "Step {index} of {total}, {label}",
  "dialog.stepPosition.submit": "Step {index} of {total}, Submit",
  "dialog.chooseOption": "Choose an option",
  "dialog.questionsAria": "Questions",
  "dialog.reviewAnswers": "Review your answers",
  "dialog.readySubmit": "Ready to submit your answers?",
  "dialog.incomplete": "You have not answered all questions",
  "dialog.submitAnswers": "Submit answers",
  "dialog.cancel": "Cancel",
  "dialog.endsQuestionsSuffix": "— ends the questions",
  "dialog.menu.moveUp": "Move up",
  "dialog.menu.moveDown": "Move down",
  "dialog.menu.leftAria": "Left — {verb} ({label})",
  "dialog.menu.rightAria": "Right — {verb} ({label})",
  "dialog.preview.currentAnswerAria": "Current answer",
  "dialog.preview.previewedBelowAria": "Previewed below",
  "dialog.preview.previewLabel": "Preview · {label}",
  "dialog.preview.editingBanner": "Note is being edited in the terminal — controls resume when it closes.",
  "dialog.preview.noteForQuestion": "Note for this question",
  "dialog.preview.noteTextAria": "Note text",
  "dialog.preview.notePlaceholder": "Add context for your answer…",
  "dialog.preview.saveNote": "Save note",
  "dialog.preview.editNoteAria": "Edit note",
  "dialog.preview.removeNoteAria": "Remove note",
  "dialog.preview.noteAria": "Note",
  "dialog.preview.addNote": "Add a note to this answer",

  // --- reply (the free-text reply race guard, lib/reply-action.ts) ---
  "reply.blocked.noBox":
    "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.",
  "reply.blocked.noEcho":
    "That's a password prompt — it shows nothing as you type, so Send can never confirm the text arrived. Nothing was typed.",
  "reply.blocked.composerLeft":
    "The agent's input box left the screen while its input line was being cleared — a menu or dialog is probably up. Your message wasn't typed.",
  "reply.stalled.noEcho":
    "That's a password prompt — it shows nothing as you type, so the text can't be confirmed and nothing was submitted. What you typed is already in the pane.",
  "reply.stalled.generic":
    "Message didn't reach the input box — a dialog may be waiting, and if you were answering it by key that key likely landed. Nothing was submitted.",

  // --- previewAction (the preview-select dialog's note flow, lib/preview-action.ts) ---
  "previewAction.note.notOpened": "Note input didn't open — check the pane",
  "previewAction.note.clearFailed": "Couldn't clear the existing note — check the pane",
  "previewAction.note.textFailed": "Note text didn't arrive — check the pane",
  "previewAction.note.closeFailed": "Note input didn't close — check the pane",

  // --- promptAction (the plan-feedback flow, lib/prompt-action.ts) ---
  "promptAction.feedback.freeTextUnsupported":
    "This dialog's free-text row is not typed from the phone",
  "promptAction.feedback.empty": "Nothing to send",
  "promptAction.feedback.boxNotOpened": "The feedback box didn't open — check the pane",
  "promptAction.feedback.notArrived": "The feedback didn't arrive — nothing was submitted",

  // --- stt (speech-to-text errors, lib/stt.ts + hooks/use-stt-recorder.ts) ---
  "stt.error.busy": "Busy — another recording is still transcribing. Try again in a moment.",
  "stt.error.tooLong": "That recording is too long — record a shorter one.",
  "stt.error.badFormat": "This browser recorded a format Collie can't send on.",
  "stt.error.unconfigured": "Speech-to-text isn't configured on this collie.",
  "stt.error.timeout": "The transcriber didn't answer in time — try again.",
  "stt.error.unreachable": "The transcriber couldn't be reached — try again.",
  "stt.error.generic": "Transcription failed — record again to retry.",
  "stt.error.networkFailure": "Couldn't reach Collie to transcribe that — try again.",
  "stt.error.recordingFailed": "Recording failed — nothing was captured.",
  "stt.error.noSpeechHeard": "Nothing was heard in that recording.",
  "stt.error.nothingRecorded": "Nothing was recorded.",
  "stt.error.unsupportedBrowser": "This browser can't record audio.",
  "stt.error.micRefused": "Microphone access was refused.",

  // --- directTyping (the composer's "Type into terminal" mode, hooks/use-direct-typing.ts) ---
  "directTyping.status.draftPending": "Send or clear the draft before typing into the terminal.",
  "directTyping.status.armed": "Typing into the terminal — keys send as you type.",
  "directTyping.status.disarmed": "Back to sending replies",
  "directTyping.status.interrupted":
    "Stopped typing into the terminal — the pane view was interrupted.",
  "directTyping.status.backgrounded":
    "Stopped typing into the terminal — the app was backgrounded.",

  // --- apiError (the bridge's refusals, keyed by the code on the wire) ---
  //
  // ONE KEY PER CODE in `lib/api-error-codes.ts`, spelled `apiError.<code>` — the dots inside a code
  // are part of the key, not a nesting. `lib/api-error-message.ts` builds the key from the code, so
  // a code with no key here is a COMPILE error, and a code a newer bridge invents falls back to the
  // English sentence that body already carries.
  //
  // `{reason}` is NEVER Collie's text: it is the multiplexer's own refusal, passed through byte for
  // byte (bridge/error-codes.ts). Those messages are a translated FRAME around a raw remainder —
  // translate the frame, leave the slot where the sentence reads naturally in your language.
  "apiError.unknown": "Something went wrong. Try again.",
  "apiError.reply.not_submitted":
    "Your message was typed into the pane but not sent — check the pane before sending it again.",
  "apiError.reply.send_failed": "The message couldn't be sent: {reason}",
  "apiError.keys.send_failed": "Those keys couldn't be sent: {reason}",
  "apiError.prompt_changed": "The screen changed before that could be sent — check the pane.",
  "apiError.prompt.read_failed": "The pane couldn't be read before sending — {mux} said: {detail}",
  "apiError.pane.close_failed": "The pane couldn't be closed: {reason}",
  "apiError.pane.rename_failed": "The pane couldn't be renamed: {reason}",
  "apiError.pane.focus_failed": "The pane couldn't be shown in the terminal: {reason}",
  "apiError.tab.create_failed": "The tab couldn't be created: {reason}",
  "apiError.tab.rename_failed": "The tab couldn't be renamed: {reason}",
  "apiError.tab.close_failed": "The tab couldn't be closed: {reason}",
  "apiError.tab.workspace_required": "No space was named for the new tab.",
  "apiError.workspace.create_failed": "The space couldn't be created: {reason}",
  "apiError.upload.too_large": "That image is too large — 10 MB is the limit.",
  "apiError.upload.no_file": "No file was sent.",
  "apiError.upload.bad_type": "Collie can't send that kind of file: {type}",
  "apiError.upload.write_failed": "The image couldn't be saved on the host: {reason}",
  "apiError.stt.unconfigured": "Speech-to-text isn't set up on this collie.",
  "apiError.stt.too_large": "That recording is too long — record a shorter one.",
  "apiError.stt.bad_format": "This browser recorded a format Collie can't send on.",
  "apiError.stt.busy": "Two recordings are already being transcribed — try again in a moment.",
  "apiError.stt.unreadable": "That recording couldn't be read.",
  "apiError.stt.empty": "That recording is empty.",
  "apiError.stt.provider_failed": "The transcription failed: {reason}",
  "apiError.pairing.bad_request": "The code or the name wasn't usable. A name is 1–48 characters.",
  "apiError.pairing.no_pending": "No pairing code is waiting on the host.",
  "apiError.pairing.expired": "That pairing code has expired.",
  "apiError.pairing.exhausted": "Too many wrong codes — that pairing was destroyed.",
  "apiError.pairing.bad_code": "That code doesn't match.",
  "apiError.pairing.duplicate_label": "A device is already using that name.",
  "apiError.device.unknown": "No paired device has that name.",
  "apiError.session.unknown": "There is no session called {session} on this collie.",
  "apiError.host.unknown": "There is no collie called {host} in this pack.",
  "apiError.pack.not_lead": "This collie doesn't lead a pack, so there is no pack to show.",
} as const;

/** Every key that exists, as a union of string literals. The completeness contract. */
export type MessageKey = keyof typeof en;

/** The English bundle's exact shape (literal values). Other locales are `Dictionary`, not this. */
export type Messages = typeof en;

/** What a translated bundle must be: every key, any string. `Record` over a finite union of
 *  literals is complete in BOTH directions — a missing key fails the assignment, an extra one is
 *  caught as an excess property. That is the entire enforcement mechanism; don't loosen it. */
export type Dictionary = Record<MessageKey, string>;
