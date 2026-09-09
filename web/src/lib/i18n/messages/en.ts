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


  // --- settings.zen ---
  // Availability only: the toggle decides whether the pane menu offers zen at all.
  "settings.install.title": "Install the app",
  "settings.install.description": "Add Collie to your home screen — full screen, its own icon.",
  "settings.install.button": "Install",
  "settings.install.iosHint": "On an iPhone or iPad, install from the browser's share sheet: tap Share, then \"Add to Home Screen\".",
  "settings.zen.title": "Zen mode",
  "settings.zen.description": "Adds a row to the pane menu that hides everything but the terminal.",
  "settings.zen.auto.label": "Enter on landscape",
  "settings.zen.auto.hint": "Rotate the phone sideways to open zen automatically; rotate back to close it.",

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
  "settings.push.reason.timeout": "Notification setup timed out. Check that this device can reach its push service, then try again.",
  "settings.push.availability.unavailable": "Could not check notification setup. Check your connection or sign in again, then retry.",
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
  "settings.devices.pair.hint":
    "Run {command} on the host, then scan the code it prints or type it here.",
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
  "settings.updateBanner.restartNeeded": "Collie was replaced on disk. Restart it.",
  "settings.updateBanner.releaseAvailable": "Collie {version} available",
  "settings.updateBanner.majorAvailable": "Collie {version} — a new major",
  "settings.updateBanner.copyAria": "Copy command: {command}",

  // --- settings.typeface (the APP's own face — a per-device preference since ADR 0033) ---
  // FAMILY NAMES ARE NOT HERE, and must not be added: "Space Grotesk" and "Aldrich" are proper
  // nouns and are named the same in every locale, exactly like the terminal families below. The
  // NOTES are phrases about a face rather than the name of one, so they are translated.
  "settings.typeface.title": "Typeface",
  "settings.typeface.description": "The app's own face, on this device.",
  "settings.typeface.family": "Family",
  "settings.typeface.system": "System default",
  "settings.typeface.note.system": "Your phone's own face. Downloads nothing.",
  "settings.typeface.note.grotesk": "Collie's own voice, drawn to match the mark.",
  // Says the cost out loud rather than letting it be discovered: Aldrich ships one weight, and the
  // app suppresses synthesized bold, so bold text under it is not heavier than the rest.
  "settings.typeface.note.aldrich": "One weight, so bold text looks the same as regular.",
  "settings.typeface.note.operator": "Added by this collie's operator.",

  // --- settings.fonts (the terminal face: the mirror's size and the draft field's; NOT the app's own typeface) ---
  "settings.fonts.title": "Terminal font",
  "settings.fonts.description": "The terminal mirror and the draft field, on this device.",
  "settings.fonts.family": "Family",
  "settings.fonts.size": "Mirror text",
  "settings.fonts.draftSize": "Draft text",
  "settings.fonts.draftSize.hint":
    "iOS keeps this at 16 — Safari zooms the page into any smaller field you type in, and never zooms back out.",
  "settings.fonts.draftSize.decrease": "Decrease draft text size",
  "settings.fonts.draftSize.increase": "Increase draft text size",
  "settings.fonts.system": "System default",

  // --- settings.display (mirror display prefs, behind the composer's ⚙ dock) ---
  "settings.display.wrap.label": "Wrap lines",
  "settings.display.wrap.hint":
    "Off pans the whole pane, column-faithful. You no longer need it for a table — a table pans by itself while Wrap is on.",
  "settings.display.tapToType.label": "Tap to type",
  "settings.display.tapToType.hint":
    "On, tapping the mirror anywhere opens the keyboard. Off, the mirror behaves like a document — taps land on the text and only the composer opens the keyboard.",
  "settings.display.fullReply.label": "Full latest reply",
  "settings.display.fullReply.hint":
    "An agent's terminal keeps no scrollback, so a long answer loses its start. On, that reply is shown in full from the agent's own log, in place of the rows it covers.",
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
  "composer.placeholder.readOnly": "Read-only — not authorised",
  "composer.placeholder.noMuxSend": "Can't type into this terminal",
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
  "composer.attach.aria": "Attach file",
  "composer.attach.title": "Attach",
  "composer.attach.photos": "Photos",
  "composer.attach.files": "Files",
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
  "composer.upload.success": "File added, path in message",
  "composer.upload.tooLarge": "That file is bigger than {max} MB, the limit on this collie.",
  "composer.upload.badType": "Collie can't attach {name}.",
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
  "chat.zen.label": "Zen mode",
  // The floating pill is the ONE way out of zen, and it carries no words — only the glyph.
  "chat.zen.exitAria": "Exit zen mode",
  // --- chat.strips (the tab row + pane row, folded into one bar of beads) ---
  // The chevron's own name, and the summary bar's. Both are chosen for the rows actually on screen:
  // a pane row appears only above one pane, so naming it unconditionally would promise a row that is
  // not there. Each case is a WHOLE sentence rather than a phrase assembled from parts — "3 tabs" is
  // a noun phrase, and dropping one into a template is the bug every language with cases hands back.
  "chat.strips.hide.both": "Hide tabs and panes",
  "chat.strips.hide.tabs": "Hide tabs",
  "chat.strips.hide.panes": "Hide panes",
  "chat.strips.show.both": "Show tabs and panes. {tabs}, {panes} hidden.",
  "chat.strips.show.tabs": "Show tabs. {tabs} hidden.",
  "chat.strips.show.panes": "Show panes. {panes} hidden.",
  "chat.find.label": "Find in output",
  "chat.history.label": "Conversation history",
  // The header's ⋮ — the glyph names nothing, so the accessible name has to say what it OPENS.
  "chat.paneMenu.aria": "Pane actions",
  "chat.header.openOverviewAria": "Open {workspace} overview{status}",
  "chat.header.statusAria": " — {label}",
  "chat.header.agentGone": "(agent gone)",
  "chat.scrollback.showHistory": "Show entire history",
  "chat.scrollback.loadOlder": "Load older",
  "chat.scrollback.loading": "Loading…",
  "chat.scrollback.noSessionReported":
    "{agent} has not reported a session to Herdr. Install or update the Herdr integration for it, then restart the agent in this pane.",
  "chat.fullReply.title": "Full reply",
  "chat.fullReply.fromTranscript": "from transcript",
  "chat.fullReply.showingTerminal": "showing the terminal",
  "chat.output.empty": "(no recent output)",
  "chat.switcher.aria": "Switch pane",
  "chat.switcher.title": "Switch pane",
  "chat.switcher.launch.here": "here",
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
  "paneActions.focus.labelWithMux": "Focus in {mux}",
  "paneActions.focus.labelFallback": "Focus in the terminal",
  "paneActions.focus.done": "Focused in the terminal",
  "paneActions.focus.failed": "Couldn't focus in the terminal",
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
  "status.detailAria": "Show the whole message",
  "status.detail.title": "What went wrong",
  "status.detail.copy": "Copy",
  "status.detail.copied": "Copied",
  "status.detail.dismiss": "Dismiss",

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
  "space.tab.closed": "Tab closed",
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
  // The parenthesis form is the LOCALE's, not this file's: a Chinese bundle writes full-width
  // brackets and no leading space. So the punctuation is one key and the word inside it is the same
  // word the eye reads, rather than a second translation of it that could drift.
  "connection.host.ariaSuffix": " ({word})",
  // ── §10.2's PRESENTATION SPLIT, IN WORDS (M22/05) ─────────────────────────
  // Two situations used to share the word above. "reconnecting" is the lead still trying, inside its
  // budget, and it asks nothing of the operator; "needs attention" is the lead unable to fix it by
  // trying again. The pair only earns its keep if the two never read as the same thing, so the
  // action sentences say the difference out loud rather than leaving it to a colour.
  "connection.host.reconnecting": "reconnecting",
  "connection.host.attention": "needs attention",
  "connection.host.reconnectingSuffix": "reconnecting · {label}",
  "connection.host.attentionSuffix": "needs attention · {label}",
  "connection.host.reconnectingAction": "The lead is still trying. Nothing to do.",
  "connection.host.attentionAction": "Trying again will not fix this. Check this machine.",
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
  "connection.session.ariaIn": "In session: {name}",
  "connection.session.all": "All sessions",
  "connection.session.allDescription": "Every session on this machine, in one list",
  "connection.session.allAria": "Showing every session. Switch session",
  "connection.server.title": "Machines",
  "connection.server.aria": "Host: {name}. Switch host",

  // --- crew (the read-only /crew census; role names stay English, ADR 0030) ---
  "crew.title": "Crew",
  "crew.nav.back": "Back",
  "crew.entry.title": "Crew overview",
  "crew.entry.description": "How every machine in the crew is doing.",
  "crew.footer.label": "Crew · {machines} · {reachable}",
  "crew.footer.aria": "Open the crew overview",
  "crew.summary.counts": "{machines} · {reachable}",
  "crew.summary.machines.one": "{count} machine",
  "crew.summary.machines.other": "{count} machines",
  "crew.summary.reachable": "{count} reachable",
  "crew.summary.deputy": "Deputy",
  "crew.summary.noDeputy": "no deputy named",
  "crew.summary.warrant": "warrant {generation}",
  "crew.summary.secret": "Secret",
  "crew.summary.secretValue": "generation {generation} · rotated {time}",
  "crew.member.health": "State",
  "crew.member.reason": "Reason",
  "crew.member.conflict": "Conflict",
  "crew.member.conflictValue": "{lead} also leads · warrant {generation}",
  "crew.member.conflictNoWarrant": "{lead} also leads · no warrant",
  "crew.member.version": "Version",
  "crew.member.versionDiffers": "differs from lead",
  "crew.member.address": "Address",
  "crew.member.enrolled": "Enrolled",
  "crew.member.secretBehind": "Has not picked up the current secret.",
  "crew.member.provisional": "Enrolled but never reached.",
  "crew.health.reachable": "reachable",
  "crew.health.unreachable": "unreachable",
  "crew.health.incompatible": "incompatible",
  "crew.health.conflicted": "conflicted",
  "crew.role.deputy": "deputy",
  "crew.sheet.goTo": "Go to this machine",
  "crew.formation.aria": "Crew formation: {machines}",
  "crew.node.aria": "{name}, {role}, {health}",
  "crew.node.ariaPlain": "{name}, {health}",
  "crew.solo.title": "This collie is not leading a crew",
  "crew.solo.description": "A crew is created and changed from the command line.",
  "crew.error.title": "Could not load crew status",
  "crew.error.description": "The bridge did not answer. Collie tries again on the next poll.",

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
  "transcript.toolImageAlt": "Tool output",
  "transcript.attachmentAlt": "Attachment",

  // --- mirror (terminal graphics in the pane mirror) ---
  "mirror.imageAlt": "Terminal graphics",
  "mirror.imageBadge": "[Image]",
  "mirror.imageMatchedByOrder": "matched by order, open History to check",

  // --- time (relative/clock formatting) ---
  "time.justNow": "just now",
  "time.compact.now": "now",

  // --- sync (how fresh the herd on screen is, and asking for a fresher one) ---

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
  "dialog.autocomplete.title": "Slash commands",
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
  "apiError.launch.not_allowlisted": "That command isn't one of your launchers",
  "apiError.launch.pane_unknown": "That pane is gone, nothing was launched",
  "apiError.workspace.create_failed": "The space couldn't be created: {reason}",
  "apiError.upload.too_large": "That file is too large, {maxMb} MB is the limit.",
  "apiError.upload.no_file": "No file was sent.",
  "apiError.upload.bad_type": "Collie can't send that kind of file: {type}",
  "apiError.upload.write_failed": "The file couldn't be saved on the host: {reason}",
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
  "apiError.host.unknown": "There is no collie called {host} in this crew.",
  // The key mirrors the wire code `crew.not_lead` (`bridge/error-codes.ts`). Both say crew from 1.8.0.
  "apiError.crew.not_lead": "This collie doesn't lead a crew, so there is no crew to show.",
  // --- worktrees (ADR 0032) ---
  "apiError.worktree.list_failed": "The worktrees couldn't be listed: {reason}",
  "apiError.worktree.create_failed": "The worktree couldn't be created: {reason}",
  "apiError.worktree.created_not_opened": "The branch was created, but nothing could be opened on it: {reason}",
  "apiError.worktree.open_failed": "The worktree couldn't be opened: {reason}",
  "apiError.worktree.busy": "Another worktree operation is still running — try again in a moment.",
  "apiError.worktree.ambiguous_branch": "That branch name matches more than one thing: {reason}",
  "apiError.worktree.branch_required": "Type a branch name first.",
  "apiError.worktree.not_a_repo": "This space isn't in a Git repository.",
  "worktree.section": "Worktrees",
  "worktree.new": "New worktree",
  "worktree.branchLabel": "Branch name",
  "worktree.branchPlaceholder": "feature/my-change",
  "worktree.branchesFrom": "Branches from {branch}",
  "worktree.create": "Create",
  "worktree.creating": "Creating…",
  "worktree.open": "Open",
  "worktree.opening": "Opening…",
  "worktree.mainCheckout": "the repo itself",
  "worktree.empty": "No worktrees yet.",
  "worktree.detached": "detached",
  "worktree.recoverOpen": "Open the branch that was created",
  "space.new.tab.plain": "Space",
  "space.new.tab.worktree": "Worktree",
  "space.new.repo.label": "Repository",
  "space.new.host.label": "Host",
  "worktree.orOpenExisting": "Or open one that already exists",
  // --- apiError.update (POST /api/update refusals, M15/05) ---
  "apiError.update.confirm_required": "That update needed a confirm, so nothing was started.",
  "apiError.update.in_progress": "An update is already running ({state}). Nothing was started.",
  "apiError.update.preflight_unavailable": "The preflight couldn't be run on this machine, so the update was refused.",
  "apiError.update.preflight_red": "Preflight is red on {check}: {reason}",
  "apiError.update.major_confirm_required": "{version} crosses a major, and a major needs its own confirm.",
  "apiError.update.target_mismatch": "This screen offered {asked}, but this collie would install {would}. Reload and read it again.",
  "apiError.update.none_available": "There is no newer release to take.",
  "apiError.update.packaged": "Updates come from your package manager. Collie won't replace this install's files.",
  "apiError.update.start_failed": "The update couldn't be started: {reason}",
  // --- settings.updateCard (the update card, M15/05) ---
  "settings.updateCard.title": "Update Collie",
  "settings.updateCard.running": "Running {current}",
  "settings.updateCard.newest": "Newest {version}",
  "settings.updateCard.upToDate": "Up to date. Nothing to do.",
  "settings.updateCard.unknownLatest": "The newest release isn't known yet.",
  "settings.updateCard.includes": "One update folds in {versions}.",
  "settings.updateCard.action": "Update to {version}",
  "settings.updateCard.majorAction": "Cross to {version}",
  "settings.updateCard.majorNote": "{version} is a new major.",
  "settings.updateCard.dismiss": "Remind me next digest",
  "settings.updateCard.dismissed": "Dismissed until the next digest.",
  "settings.updateCard.checking": "Checking this machine…",
  "settings.updateCard.details": "Details",
  "settings.updateCard.summary.checks.one": "{count} check",
  "settings.updateCard.summary.checks.other": "{count} checks",
  "settings.updateCard.summary.red.one": "{count} red",
  "settings.updateCard.summary.red.other": "{count} red",
  "settings.updateCard.summary.amber.one": "{count} amber",
  "settings.updateCard.summary.amber.other": "{count} amber",
  "settings.updateCard.summary.peers.one": "{count} peer",
  "settings.updateCard.summary.peers.other": "{count} peers",
  "settings.updateCard.preflightUnavailable": "The preflight couldn't be run on this machine.",
  "settings.updateCard.packageManaged": "Your package manager updates this install. Collie won't take it from here.",
  "settings.updateCard.remedy": "Fix: {command}",
  "settings.updateCard.confirmTitle": "Update to {version}?",
  "settings.updateCard.confirmBody": "Your terminal session stays alive. The phone view drops for up to 30 seconds.",
  // THE SENTENCE ABOUT THE CREW LINK (M27/06), whole. It lives in the CARD's namespace because the
  // card is where it is read: above the confirm, with room for both halves of it — what changes,
  // and what to do about it. The band prints `updateRibbon.linkChangeShort` instead, held to the
  // row's forty characters like every other band string. The digest push carries this same English
  // from `LINK_CHANGE_SENTENCE` in `bridge/update.ts`, which has no locale to read.
  //
  // Generic on purpose: it is printed off a wire-version DIFFERENCE, never off a release name, so
  // the release after the next one carries it with no string edited.
  "settings.updateCard.linkChange": "Changes the crew link. Update the lead first, members follow.",
  "settings.updateCard.confirmAction": "Yes, update",
  "settings.updateCard.majorConfirmTitle": "Cross the major to {version}?",
  "settings.updateCard.majorConfirmBody": "{version} is a new major, so it is consented to on its own and never folded into a routine update. Read its release notes first. Your terminal session stays alive. The phone view drops for up to 30 seconds.",
  "settings.updateCard.majorConfirmAction": "Yes, cross to {version}",
  "settings.updateCard.cancel": "Cancel",
  "settings.updateCard.starting": "Starting…",
  "settings.updateCard.startingSlow": "Still starting. The host has not reported the run yet.",
  "settings.updateCard.state.preflight": "Checking this machine…",
  "settings.updateCard.state.staging": "Staging {version}…",
  "settings.updateCard.state.restarting": "Restarting. This is not an outage.",
  "settings.updateCard.phaseOf": "Step {step} of {total}",
  "settings.updateCard.state.restartingSlow": "This restart is taking longer than expected. Check the service on that machine.",
  "settings.updateCard.state.verifying": "Verifying the new build…",
  "settings.updateCard.state.done": "Updated to {version}.",
  "settings.updateCard.state.rolledBack": "Rolled back. This machine is still on {version}.",
  "settings.updateCard.state.stuck": "The update is stuck. Run this in a terminal:",
  "settings.updateCard.state.interrupted": "The update stopped before it finished. Nothing was left half-installed.",
  "settings.updateCard.progressNote": "Keep this screen open. Your terminal session is untouched.",
  "settings.updateCard.retry": "Retry",
  "settings.updateCard.logTail": "Log tail",
  "settings.updateCard.versionUnknown": "an unknown version",

  // --- settings.updateCard, the crew half (M16/01) ---
  "settings.updateCard.actionCrew": "Update crew to {version}",
  "settings.updateCard.retryCrew": "Retry crew update",
  "settings.updateCard.retryNow": "Retry now",
  "settings.updateCard.crewConfirmTitle": "Update the crew to {version}?",
  "settings.updateCard.crewConfirmBody": "This machine goes first. Each member then levels itself to the same release, checks its own health and rolls back on its own if it fails.",
  "settings.updateCard.crewConfirmAction": "Yes, update the crew",
  "settings.updateCard.retryConfirmTitle": "Retry the crew update?",
  "settings.updateCard.retryConfirmBody": "This machine is already current, so only the peers run. Each one gets one more attempt.",
  "settings.updateCard.retryConfirmAction": "Yes, retry",
  "settings.updateCard.peers.label": "Crew members",
  "settings.updateCard.crewPatience": "No action needed, this finishes on its own.",
  "settings.updateCard.peer.versionUnknown": "version unknown",
  "settings.updateCard.peer.unknownReason": "we could not check this machine",
  "settings.updateCard.peer.asOf": "checked {ago}",
  "settings.updateCard.peer.movingFor": "for {elapsed}",
  "settings.updateCard.peer.verdict.green": "ready",
  "settings.updateCard.peer.verdict.amber": "warnings",
  "settings.updateCard.peer.verdict.red": "red",
  "settings.updateCard.peer.verdict.unknown": "unknown",
  "settings.updateCard.peer.state.waiting": "waiting",
  "settings.updateCard.peer.state.updating": "updating",
  "settings.updateCard.peer.state.unreachable": "unreachable",
  "settings.updateCard.peer.state.preflight": "checking",
  "settings.updateCard.peer.state.staging": "staging",
  "settings.updateCard.peer.state.restarting": "restarting",
  "settings.updateCard.peer.state.verifying": "verifying",
  "settings.updateCard.peer.state.done": "updated",
  "settings.updateCard.peer.state.rolledBack": "rolled back",
  "settings.updateCard.peer.state.packageManaged": "waits for the package manager",
  "settings.updateCard.peer.state.stuck": "stuck",
  "settings.updateCard.peer.state.interrupted": "stopped",
  "settings.updateCard.peer.state.idle": "waiting",

  // --- updates (the page, and the Settings row that opens it), M16/01 ---
  "updates.title": "Updates",
  "updates.nav.back": "Back",
  "updates.entry.title": "Updates",
  "updates.entry.description": "Update Collie, and the crew with it.",
  "updates.entry.status.updating": "Updating…",
  "updates.entry.status.peersBehind.one": "{count} peer behind",
  "updates.entry.status.peersBehind.other": "{count} peers behind",
  "updates.entry.status.available": "{version} available",
  "updates.entry.status.upToDate": "Up to date",

  // --- updateRibbon (the ONE top-of-app update band), M16/02 ---
  // Every string in this block is held to a 40-CHARACTER BUDGET in all six locales, enforced by
  // `update-ribbon-i18n.test.ts`. One truncating row on a phone is about forty characters wide, and
  // a line that overflows it in German or Japanese is a line nobody can read. The budget is measured
  // with the slots filled: a version, a peer name, a count. `{reason}` is a peer's own prose of
  // unbounded length, so it is cut on a word boundary before it ever reaches a string here and the
  // Updates page carries it whole.
  "updateRibbon.starting": "Starting update…",
  "updateRibbon.fetching": "Updating to {version}. Fetching",
  "updateRibbon.building": "Updating to {version}. Building",
  "updateRibbon.restarting": "Updating to {version}. Restarting",
  "updateRibbon.updated": "Updated to {version}. Tap to reload.",
  "updateRibbon.peers.one": "Updating {count} peer: {names}",
  "updateRibbon.peers.other": "Updating {count} peers: {names}",
  "updateRibbon.peersSlow.one": "Updating {count} peer: {names}, {elapsed}",
  "updateRibbon.peersSlow.other": "Updating {count} peers: {names}, {elapsed}",
  "updateRibbon.underAMinute": "less than a minute",
  "updateRibbon.minutes.one": "{count} min",
  "updateRibbon.minutes.other": "{count} min",
  "updateRibbon.packageManaged.one": "{names} waits for its package manager",
  "updateRibbon.packageManaged.other": "{names} wait for their package manager",
  "updateRibbon.peerFailed": "Could not update {name}: {reason}.",
  "updateRibbon.seeUpdates": "See Updates.",
  // THE BAND'S OWN CUT OF IT. One truncating row is about forty characters wide, which the whole
  // sentence is not, so the band states WHAT changes and the tap lands on the card, where the rest
  // of it sits above the confirm. Held to the budget like every other band string.
  "updateRibbon.linkChangeShort": "Changes the crew link.",
  "updateRibbon.available": "Collie {version} available. Tap to update.",
  // A packaged host cannot take the tap — its updates come from its package manager (ADR 0035) — so
  // the band STATES the fact and names the manager. It does not instruct: the phone cannot run
  // pacman, and a line that told the operator to would be telling them to go somewhere else.
  "updateRibbon.availablePackaged": "Collie {version} available via {manager}.",
  // The same host under a prefix Collie does not recognise: there is no manager to name, so the band
  // states the version and points at the page that carries the boundary sentence.
  "updateRibbon.availablePackagedUnnamed": "Collie {version} available.",
  "updateRibbon.dismiss": "Dismiss this version",
  // The close on the two QUIET crew states. Not "dismiss this version": what is put down there is a
  // notice about another machine, and this host's own offer is untouched by it.
  "updateRibbon.hideNotice": "Hide this notice",
} as const;

/** Every key that exists, as a union of string literals. The completeness contract. */
export type MessageKey = keyof typeof en;

/** The English bundle's exact shape (literal values). Other locales are `Dictionary`, not this. */
export type Messages = typeof en;

/** What a translated bundle must be: every key, any string. `Record` over a finite union of
 *  literals is complete in BOTH directions — a missing key fails the assignment, an extra one is
 *  caught as an excess property. That is the entire enforcement mechanism; don't loosen it. */
export type Dictionary = Record<MessageKey, string>;
