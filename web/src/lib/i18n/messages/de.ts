import type { Dictionary } from "./en";

// German. Typed `Dictionary`, so a key English has and this file does not is a compile error, and a
// key this file invents that English does not have is one too. Keep the `{slot}` names byte-exact.

export const de: Dictionary = {
  "settings.language.title": "Sprache",
  "settings.language.description": "Der Terminal-Spiegel wird nie übersetzt.",

  // --- settings (page chrome) ---
  "settings.title": "Einstellungen",
  "settings.nav.back": "Zurück",

  // --- settings.theme ---
  "settings.theme.title": "Erscheinungsbild",
  "settings.theme.description": "Dem Telefon folgen oder eines festlegen.",
  "settings.theme.option.system": "System",
  "settings.theme.option.light": "Hell",
  "settings.theme.option.dark": "Dunkel",

  // --- settings.haptics ---
  "settings.haptics.title": "Vibration",
  "settings.haptics.description": "Ein kurzer Impuls bei Tastendruck oder Schnellantwort.",


  // --- settings.handsFree ---
  "settings.handsFree.title": "Freisprechen",
  "settings.handsFree.description":
    "Das Transkript sofort senden statt es ins Nachrichtenfeld zu legen. Standardmäßig aus — normalerweise liest man erst, was verstanden wurde, bevor es das Terminal erreicht.",
  "settings.handsFree.ariaLabel": "Freisprechen: Transkript sofort senden",

  // --- settings.push ---
  "settings.push.title": "Push-Benachrichtigungen",
  "settings.push.description": "Eine Benachrichtigung erhalten, wenn ein Agent Eingabe braucht.",
  "settings.push.reason.insecure": "Push braucht eine HTTPS-Verbindung.",
  "settings.push.reason.serverOff": "Push ist auf der Bridge nicht eingerichtet (keine VAPID-Schlüssel).",
  "settings.push.reason.denied":
    "Benachrichtigungen sind blockiert — in den Browsereinstellungen erlauben.",
  "settings.push.reason.unsupported": "Dieser Browser unterstützt keine Push-Benachrichtigungen.",
  "settings.push.reason.default": "Push-Benachrichtigungen konnten nicht aktiviert werden.",
  "settings.push.availability.insecure":
    "Über reines HTTP nicht verfügbar — Collie über HTTPS bereitstellen, um Push zu aktivieren.",
  "settings.push.availability.serverOff":
    "Die Bridge hat keine VAPID-Schlüssel eingerichtet, daher ist Push serverseitig deaktiviert.",
  "settings.push.availability.denied":
    "Benachrichtigungen sind für diese Seite blockiert. In den Browsereinstellungen wieder erlauben.",
  "settings.push.availability.unsupported":
    "Dieser Browser unterstützt keine Push-Benachrichtigungen.",

  // --- settings.notify ---
  "settings.notify.title": "Benachrichtigen bei",
  "settings.notify.description": "Gilt für alle Geräte.",
  "settings.notify.blocked.label": "Eingabe nötig",
  "settings.notify.blocked.hint": "ein Agent wartet auf dich",
  "settings.notify.done.label": "Fertig",
  "settings.notify.done.hint": "ein Agent schließt seine Aufgabe ab",
  "settings.notify.updates.label": "App-Updates",
  "settings.notify.updates.hint": "eine neue Collie-Version ist verfügbar",

  // --- settings.snooze ---
  "settings.snooze.title": "Nicht stören",
  "settings.snooze.description.idle": "Push-Benachrichtigungen für eine Weile pausieren.",
  "settings.snooze.description.active": "Pausiert bis {time} — bis dahin keine Pushes.",
  "settings.snooze.resume": "Jetzt fortsetzen",
  "settings.snooze.preset.min30": "30m",
  "settings.snooze.preset.hour1": "1h",
  "settings.snooze.preset.hour4": "4h",

  // --- settings.devices ---
  "settings.devices.title": "Gekoppelte Geräte",
  "settings.devices.description.enforced":
    "Jeder Schreibzugriff braucht ein gekoppeltes Gerät. Lesen bleibt offen.",
  "settings.devices.description.open":
    "Nichts ist gekoppelt, daher sind Schreibzugriffe ungesichert. Ein Gerät koppeln, um einen Nachweis zu verlangen.",
  "settings.devices.pairedAs": "Dieses Gerät ist gekoppelt als {device}.",
  "settings.devices.loadError": "Gekoppelte Geräte konnten nicht von der Bridge geladen werden.",
  "settings.devices.thisDevice": "Dieses Gerät",
  "settings.devices.row.meta": "Gekoppelt {paired} · zuletzt gesehen {lastSeen}",
  "settings.devices.revokeError": "Dieses Gerät konnte nicht widerrufen werden.",
  "settings.devices.cancel": "Abbrechen",
  "settings.devices.unpairSelf": "Dieses Telefon entkoppeln",
  "settings.devices.revoke": "Widerrufen",
  "settings.devices.revokeAria": "{label} widerrufen",
  "settings.devices.pair.title": "Dieses Gerät koppeln",
  "settings.devices.pair.hint": "{command} auf dem Host ausführen und den angezeigten Code eingeben.",
  "settings.devices.pair.codeLabel": "Kopplungscode",
  "settings.devices.pair.codePlaceholder": "8 Zeichen",
  "settings.devices.pair.nameLabel": "Name für dieses Gerät",
  "settings.devices.pair.namePlaceholder": "z. B. mein Telefon",
  "settings.devices.pair.networkError":
    "Bridge konnte nicht erreicht werden. Verbindung prüfen und erneut versuchen.",
  "settings.devices.pair.failure.noPending":
    "Kein Kopplungscode wartet. `bin/collie pair` auf dem Host ausführen, um einen zu erzeugen.",
  "settings.devices.pair.failure.expired":
    "Dieser Code ist abgelaufen. `bin/collie pair` auf dem Host für einen neuen ausführen.",
  "settings.devices.pair.failure.exhausted":
    "Zu viele falsche Codes, die Kopplung wurde verworfen. `bin/collie pair` auf dem Host für eine neue ausführen.",
  "settings.devices.pair.failure.badCode":
    "Dieser Code stimmt nicht. Prüfen und erneut versuchen — nach ein paar weiteren Fehlversuchen wird er verworfen.",
  "settings.devices.pair.failure.duplicateLabel":
    "Ein Gerät nutzt diesen Namen bereits. Einen anderen wählen — der Code bleibt gültig.",
  "settings.devices.pair.failure.badRequest":
    "Code oder Name waren ungültig. Ein Name hat 1–48 Zeichen.",

  // --- settings.connection ---
  "settings.connection.title": "Verbindung",
  "settings.connection.description": "Diagnose für dieses Gerät.",
  "settings.connection.row.endpoint": "Endpunkt",
  "settings.connection.row.secure": "Sicherer Kontext",
  "settings.connection.row.bridge": "Bridge",
  "settings.connection.row.deviceAccess": "Gerätezugriff",
  "settings.connection.row.serverBuild": "Server-Build",
  "settings.connection.secure.yes": "Ja",
  "settings.connection.secure.no": "Nein (reines HTTP)",
  "settings.connection.bridge.connected": "Verbunden",
  "settings.connection.bridge.offline": "Herdr offline",
  "settings.connection.bridge.connecting": "Verbindet…",
  "settings.connection.device.notEnforced": "Nicht erzwungen",
  "settings.connection.device.fullAccessNamed": "Vollzugriff · {device}",
  "settings.connection.device.fullAccessLocal": "Vollzugriff (lokal)",
  "settings.connection.device.readOnlyNamed": "Schreibgeschützt · {device}",
  "settings.connection.device.readOnly": "Schreibgeschützt",

  // --- settings.update (update-check-control + footer update banner) ---
  "settings.update.title": "Updates",
  "settings.update.check.prompt": "Prüfen, ob eine neue Collie-Version verfügbar ist.",
  "settings.update.check.running": "Läuft mit v{current}",
  "settings.update.check.runningChecked": "Läuft mit v{current} · geprüft {checked}",
  "settings.update.action": "Nach Updates suchen",
  "settings.update.checking": "Prüft…",
  "settings.update.error": "Prüfung fehlgeschlagen.",
  "settings.update.upToDate": "Aktuell",
  "settings.updateBanner.restart": "Bridge-Neustart nötig",
  "settings.updateBanner.releaseAvailable": "Collie {version} verfügbar",
  "settings.updateBanner.majorAvailable": "Collie {version} — eine neue Hauptversion",
  "settings.updateBanner.copyAria": "Befehl kopieren: {command}",

  // --- settings.fonts ---
  "settings.fonts.title": "Terminal-Schrift",
  "settings.fonts.description": "Nur der Terminal-Spiegel, auf diesem Gerät.",
  "settings.fonts.family": "Schriftart",
  "settings.fonts.size": "Größe",
  "settings.fonts.system": "Systemstandard",

  // --- settings.display (mirror display prefs, behind the composer's ⚙ dock) ---
  "settings.display.wrap.label": "Zeilenumbruch",
  "settings.display.wrap.hint":
    "Aus zeigt spaltengetreue Ausgabe für TUI-Tabellen — stattdessen schwenken.",
  "settings.display.tapToType.label": "Zum Tippen antippen",
  "settings.display.tapToType.hint":
    "An: Tippen auf den Spiegel öffnet überall die Tastatur. Aus: Der Spiegel verhält sich wie ein Dokument — Tipps treffen den Text, nur der Composer öffnet die Tastatur.",
  "settings.display.rawTerminal.label": "Rohes Terminal",
  "settings.display.rawTerminal.hint":
    "Zeigt den reinen Spiegel — keine antippbaren Prompt-Buttons, keine Rahmen oder Statuszeilen. Nutzen, wenn ein Dialog falsch dargestellt wird und man ihn per Hand über Keys steuern will.",
  "settings.display.textSize.label": "Textgröße",
  "settings.display.textSize.decrease": "Schriftgröße verringern",
  "settings.display.textSize.increase": "Schriftgröße erhöhen",

  // --- settings.buildStamp ---
  "settings.buildStamp.tapToUpdate": "neuer Build — zum Aktualisieren antippen",
  "settings.buildStamp.updating": "wird aktualisiert…",

  // --- composer (the reply box + its Keys/Quick/Display docks) ---
  "composer.dock.closeAria": "{title} schließen",
  "composer.controls.label": "Steuerung",
  "composer.controls.keys": "Tasten",
  "composer.controls.typeAria": "Ins Terminal tippen",
  "composer.controls.type": "Tippen",
  "composer.controls.quick": "Schnell",
  "composer.controls.agent": "Agent",
  "composer.controls.displayAria": "Anzeigeeinstellungen",
  "composer.controls.display": "Anzeige",
  "composer.sentPreview.label": "Gesendet:",
  "composer.placeholder.gone": "Pane ist weg",
  "composer.placeholder.readOnly": "Schreibgeschützt — Gerät nicht autorisiert",
  "composer.placeholder.noMuxSend": "In dieses Terminal kann von hier aus nicht getippt werden",
  "composer.placeholder.direct": "Ins Terminal tippen…",
  "composer.placeholder.shell": "Shell-Befehl eingeben…",
  "composer.placeholder.reply": "Antwort eingeben…",
  "composer.mic.unavailable": "Spracheingabe nicht verfügbar",
  "composer.mic.stopAria": "Aufnahme stoppen",
  "composer.mic.recordAria": "Sprachnachricht aufnehmen",
  "composer.mic.transcribing": "Wird transkribiert…",
  "composer.mic.recording": "Aufnahme {elapsed}",
  "composer.mic.handsFreeHint": "wird beim Stoppen gesendet",
  "composer.mic.manualHint": "landet im Nachrichtenfeld",
  "composer.mic.stop": "Stopp",
  "composer.mic.discardAria": "Aufnahme verwerfen",
  "composer.attach.aria": "Bild anhängen",
  "composer.send.typeAnyway": "Trotzdem tippen?",
  "composer.send.reallySend": "Wirklich senden?",
  "composer.send.stopTypingAria": "Tippen ins Terminal stoppen",
  "composer.send.sendAria": "Senden",
  "composer.draft.tooLong":
    "Zu lang für einen gespeicherten Entwurf — übersteht Pane-Wechsel, aber nicht das Schließen der App.",
  "composer.status.dialogWaiting": "Ein Dialog wartet — erst beantworten, dann senden.",
  "composer.status.paneNotWritable": "Pane ist nicht mehr beschreibbar — nichts wurde gesendet",
  "composer.status.inputChanged":
    "Das Eingabefeld hat sich beim Leeren verändert — nichts wurde getippt. Pane prüfen.",
  "composer.status.clearFailed": "Terminal-Eingabe konnte nicht geleert werden",
  "composer.status.sent": "Gesendet ✓",
  "composer.status.tapAgainToType": "{error} Senden erneut antippen, um trotzdem zu tippen.",
  "composer.discard.confirmKeys.one": "Erneut antippen, um {count} wartende Taste zu verwerfen",
  "composer.discard.confirmKeys.other": "Erneut antippen, um {count} wartende Tasten zu verwerfen",
  "composer.destructive.confirm": "Destruktiv: {reason} — Senden erneut antippen zum Bestätigen",
  "composer.destructive.confirmOnHost":
    "Destruktiv: {reason} auf {host} — Senden erneut antippen zum Bestätigen",
  "composer.upload.success": "Bild hinzugefügt — Pfad in der Nachricht",
  "composer.noEcho.title": "Passwortabfrage — kein Echo",
  "composer.noEcho.noLiveTyped":
    "Das Getippte steht bereits im Pane, unabgeschickt — aber diese Ansicht ist nicht live, also kann von hier nichts gesendet werden. Am Terminal beantworten.",
  "composer.noEcho.noLiveUntyped":
    "Nichts wurde getippt. Diese Ansicht ist nicht live, die passenden Tasten können von hier nicht gesendet werden.",
  "composer.noEcho.liveTyped":
    "Das Getippte steht bereits im Pane — es kann nur nicht bestätigt werden, also wurde es nicht abgeschickt. Im Tippen-Modus Enter drücken, nicht erneut senden.",
  "composer.noEcho.liveUntyped":
    "Senden bestätigt, was es getippt hat, und diese Abfrage zeigt nichts zum Bestätigen. Der Tippen-Modus schickt Tasten direkt durch, Enter inklusive.",
  "composer.noEcho.useType": "Tippen-Modus nutzen",
  "composer.noEcho.dismissAria": "Passwort-Hinweis verwerfen",
  "composer.draftPreview.title": "Entwurf im Terminal",
  "composer.draftPreview.takeOver": "Übernehmen",

  // --- sendMode (the armed "typing straight through" indicator) ---
  "sendMode.armed.title": "Tippt ins Terminal",
  "sendMode.armed.hint": "Tasten gehen direkt durch",
  "sendMode.armed.stop": "Stopp",

  // --- chat (the pane view shell: header, mirror, switcher) ---
  "chat.find.label": "In der Ausgabe suchen",
  "chat.history.label": "Gesprächsverlauf",
  "chat.paneMenu.aria": "Bereichsaktionen",
  "chat.header.openOverviewAria": "{workspace}-Übersicht öffnen{status}",
  "chat.header.statusAria": " — {label}",
  "chat.header.agentGone": "(Agent weg)",
  "chat.scrollback.showHistory": "Gesamten Verlauf zeigen",
  "chat.scrollback.loadOlder": "Ältere laden",
  "chat.scrollback.loading": "Lädt…",
  "chat.scrollback.noSessionReported":
    "{agent} hat Herdr keine Sitzung gemeldet. Die Herdr-Integration dafür installieren oder aktualisieren und den Agenten in diesem Pane neu starten.",
  "chat.output.empty": "(keine aktuelle Ausgabe)",
  "chat.switcher.aria": "Pane wechseln",
  "chat.switcher.title": "Pane wechseln",
  "chat.status.feedbackSent": "Feedback gesendet",
  "chat.status.sent": "Gesendet",
  "chat.status.menuChanged": "Menü geändert — wird aktualisiert",
  "chat.status.sendFailed": "Senden fehlgeschlagen",
  "chat.status.wizardChanged": "Assistent geändert — wird aktualisiert",
  "chat.status.noteSaved": "Notiz gespeichert",
  "chat.status.noteRemoved": "Notiz entfernt",
  "chat.status.dialogChanged": "Dialog geändert — wird aktualisiert",
  "chat.status.selectionChanged": "Auswahl geändert — wird aktualisiert",
  "chat.status.screenChanged": "Bildschirm geändert — wird aktualisiert",
  "chat.status.readOnly": "Schreibgeschützt — Gerät nicht autorisiert",

  // --- prompt (the native prompt-select / plan-feedback block) ---
  "prompt.family.select": "Option wählen",
  "prompt.family.permission": "Berechtigung erforderlich",
  "prompt.family.trust": "Diesem Ordner vertrauen?",
  "prompt.family.plan": "Plan überprüfen",
  "prompt.sendingAria": "Wird gesendet",
  "prompt.feedback.cancel": "Abbrechen",
  "prompt.feedback.typedAria": "Feedback im Terminal",
  "prompt.feedback.planChange.offer": "Claude sagen, was zu ändern ist",
  "prompt.feedback.planChange.editorLabel": "Was soll Claude ändern?",
  "prompt.feedback.planChange.textAria": "Feedbacktext",
  "prompt.feedback.planChange.placeholder": "Sagen, was anders laufen soll…",
  "prompt.feedback.planChange.help":
    "Schickt den Plan mit deinen Notizen zurück — Claude plant weiter, statt zu starten.",
  "prompt.feedback.planChange.send": "Feedback senden",
  "prompt.feedback.planChange.sending": "Feedback wird gesendet…",
  "prompt.feedback.planChange.focused":
    "Das Feedback-Feld hat die Tastatur im Terminal — diese Buttons würden hineintippen statt zu antworten. Sie funktionieren wieder, sobald es sich schließt.",
  "prompt.feedback.planChange.typedPrefix": "Feedback wird gerade im Terminal geschrieben: ",
  "prompt.feedback.freeText.focused":
    "Die Freitextzeile hat die Tastatur im Terminal — diese Buttons würden hineintippen statt zu antworten. Sie funktionieren wieder, sobald es sich schließt.",
  "prompt.feedback.freeText.typedPrefix": "Eine eigene Antwort wird gerade im Terminal geschrieben: ",

  // --- paneActions (long-press sheet: rename / close a pane) ---
  "paneActions.title.fallback": "Pane",
  "paneActions.readOnly": "Schreibgeschützt — dieses Gerät darf Panes nicht umbenennen oder schließen.",
  "paneActions.hostBlockSuffix": "{hostBlock} — Umbenennen und Schließen sind gesperrt, bis er antwortet.",
  "paneActions.rename.label": "Umbenennen",
  "paneActions.rename.placeholder": "Namen für dieses Pane",
  "paneActions.close.label": "Pane schließen",
  "paneActions.close.confirm": "Erneut antippen zum Schließen",
  "paneActions.close.closing": "Schließt…",
  "paneActions.showInTerminal.label": "Im Terminal anzeigen",
  "paneActions.showInTerminal.done": "Im Terminal angezeigt",
  "paneActions.showInTerminal.failed": "Konnte es nicht im Terminal anzeigen",
  "paneActions.empty.fallback": "Dieser Multiplexer bietet keine Aktionen für ein Pane.",
  "paneActions.status.renamed": "Umbenannt",
  "paneActions.status.labelCleared": "Label gelöscht",
  "paneActions.status.renameFailed": "Umbenennen fehlgeschlagen",
  "paneActions.status.closeFailed": "Schließen fehlgeschlagen",

  // --- keys (the inline Keys tray + its staging strip) ---
  "keys.tab.keys": "Tasten",
  "keys.presets.label": "Vorgaben",
  "keys.fkeys.label": "F-Tasten",
  "keys.confirm.label": "Bestätigen?",
  "keys.queue.removeAria": "{label} entfernen",
  "keys.queue.charPlaceholder": "Taste",
  "keys.queue.charAria": "Taste zum Kombinieren eingeben",
  "keys.queue.send": "Senden",
  "keys.queue.clearAria": "Wartende Tasten löschen",

  // --- nav (app header, Collie mark, settings gear) ---
  "nav.settings.aria": "Einstellungen",
  "nav.home.aria.default": "Collie-Startseite",
  "nav.home.aria.lost": "Collie-Startseite — nicht verbunden",
  "nav.home.aria.reconnecting": "Collie-Startseite — verbindet erneut",
  "nav.mux.onPrefix": "auf",
  "nav.prereleaseTitle": "Vorab-Version — {version}",

  // --- home (dashboard herd list) ---
  "home.empty.disconnected": "Getrennt",
  "home.empty.disconnectedAt": "Getrennt — zuletzt gesehen {time}",
  "home.empty.noAgents": "Keine Agenten aktiv.",
  "home.empty.waiting": "Warte auf Herdr…",
  "home.empty.panesHint": "Panes stehen unter Spaces.",
  "home.allClear": "Nichts braucht dich",
  "home.sort.newest": "Neueste",
  "home.sort.oldest": "Älteste",
  "home.sort.aria.newest": "Sortiert nach zuletzt benutzt — zu älteste zuerst wechseln",
  "home.sort.aria.oldest": "Sortiert nach älteste zuerst — zu zuletzt benutzt wechseln",
  "home.sidebar.shells": "Shells",
  "home.sidebar.paneActionsTitle": "Für Pane-Aktionen antippen",

  // --- status (triage sections, status labels, counts) ---
  "status.section.needsYou": "Braucht dich",
  "status.section.readyUnseen": "Fertig · ungesehen",
  "status.section.working": "Läuft",
  "status.section.recent": "Kürzlich",
  "status.label.blocked": "braucht dich",
  "status.label.working": "läuft",
  "status.label.idle": "inaktiv",
  "status.label.done": "fertig",
  "status.label.unknown": "unbekannt",
  "status.count.needsYou.one": "{count} braucht dich",
  "status.count.needsYou.other": "{count} brauchen dich",
  "status.count.working.one": "{count} läuft",
  "status.count.working.other": "{count} laufen",
  "status.shellBadge": "shell",
  "status.dismissAria": "Verwerfen",

  // --- space (spaces overview/strip/view, tabs, panes, new-space) ---
  "space.overview.title": "Spaces",
  "space.overview.new.aria": "Neuer Space",
  "space.overview.filter.placeholder": "Spaces filtern…",
  "space.overview.filter.aria": "Spaces filtern",
  "space.overview.empty.none": "Noch keine Spaces.",
  "space.overview.empty.noMatch": "Kein Space passt zu „{query}“.",
  "space.overview.needsYou.one": "{count} Space braucht dich",
  "space.overview.needsYou.other": "{count} Spaces brauchen dich",
  "space.overview.paneCount.one": "{count} Pane",
  "space.overview.paneCount.other": "{count} Panes",
  "space.strip.back": "Zurück",
  "space.strip.title": "Spaces",
  "space.strip.all": "Alle",
  "space.view.tabCount.one": "{count} Tab",
  "space.view.tabCount.other": "{count} Tabs",
  "space.view.paneCount.one": "{count} Pane",
  "space.view.paneCount.other": "{count} Panes",
  "space.view.emptyTab": "(leerer Tab)",
  "space.view.noPanesInTab": "Dieser Tab hat keine Panes.",
  "space.view.noPanesInSpace": "Dieser Space hat keine Panes.",
  "space.tabStrip.title": "Tabs",
  "space.tabStrip.all": "Alle",
  "space.tabStrip.new.aria": "Neuer Tab",
  "space.paneStrip.title": "Panes",
  "space.new.title": "Neuer Space",
  "space.new.dir.label": "Verzeichnis (optional)",
  "space.new.dir.placeholder": "~ (Home-Verzeichnis)",
  "space.new.label.label": "Label (optional)",
  "space.new.label.placeholder": "diesen Space benennen",
  "space.new.create": "Space erstellen & Shell öffnen",
  "space.tab.titleFallback": "Tab",
  "space.tab.titleWithLabel": "Tab {label}",
  "space.tab.readOnly": "Schreibgeschützt — dieses Gerät darf Tabs nicht umbenennen oder schließen.",
  "space.tab.hostBlockSuffix": "{hostBlock} — Umbenennen und Schließen erst möglich, wenn er antwortet.",
  "space.tab.rename": "Umbenennen",
  "space.tab.close": "Tab schließen",
  "space.tab.closing": "Schließt…",
  "space.tab.closeConfirm.one": "Erneut antippen, um {count} Pane zu schließen",
  "space.tab.closeConfirm.other": "Erneut antippen, um {count} Panes zu schließen",
  "space.tab.closeConfirmPlain": "Erneut antippen zum Schließen",
  "space.tab.empty.fallback": "Dieser Multiplexer bietet keine Aktionen für einen Tab.",
  "space.tab.placeholder": "diesen Tab benennen",
  "space.tab.renamed": "Umbenannt",
  "space.tab.renameFailed": "Umbenennen fehlgeschlagen",
  "space.tab.closeFailed": "Schließen fehlgeschlagen",
  "space.readOnly.notPaired": "Nicht gekoppelt — dieses Gerät in den Einstellungen koppeln",
  "space.readOnly.deviceUnauthorised": "Schreibgeschützt — Gerät nicht autorisiert",
  "space.create.ready": "Neuer {what} bereit — Agent starten",
  "space.noun.tab": "Tab",
  "space.noun.space": "Space",

  // --- actionSheet (shared rename/back/save rows behind pane + tab long-press sheets) ---
  "actionSheet.back": "Zurück",
  "actionSheet.label": "Label",
  "actionSheet.save": "Speichern",

  // --- commands (agent command palette) ---
  "commands.title": "Agent-Befehle",
  "commands.search.placeholder": "{count} Befehle durchsuchen…",
  "commands.common.hint": "Häufig · alle {count} durchsuchen",
  "commands.empty": "Kein Befehl passt zu „{query}“.",
  "commands.confirm": "Bestätigen?",

  // --- quickActions (one-tap reply dock) ---
  "quickActions.group.confirm": "bestätigen",
  "quickActions.group.common": "häufig",

  // --- find (the in-mirror / in-history find bar) ---
  "find.placeholder": "{subject} durchsuchen…",
  "find.aria": "{subject} durchsuchen",
  "find.prevAria": "Vorheriger Treffer",
  "find.nextAria": "Nächster Treffer",
  "find.closeAria": "Suche schließen",
  "find.subject.output": "Ausgabe",
  "find.subject.history": "Verlauf",

  // --- connection (banner, read-only strip, host chip/stale banner, session/server switchers) ---
  "connection.auth.message": "Zugriff verweigert. Das ist kein Verbindungsproblem.",
  "connection.auth.signIn": "Anmelden",
  "connection.reload.aria": "Neu laden",
  "connection.retry": "Erneut versuchen",
  "common.closeAria": "Schließen",
  "common.scrollToLatestAria": "Zum neuesten scrollen",
  "connection.connected": "Verbunden",
  "connection.reconnecting": "Verbindet erneut…",
  "connection.herdrDown": "Herdr ist auf dem Host down",
  "connection.offlineCantReach": "Offline — Collie nicht erreichbar",
  "connection.cantReach": "Collie nicht erreichbar",
  "connection.withLastSeen": "{cause} — zuletzt gesehen {time}",
  "connection.readOnly.notPaired": "Nicht gekoppelt — Gerät in den Einstellungen koppeln, um Agenten zu bedienen.",
  "connection.readOnly.device": "Schreibgeschützt — dieses Gerät darf nicht in Agenten tippen{deviceSuffix}.",
  "connection.host.lastSeen": "zuletzt gesehen {time}",
  "connection.host.neverSeen": "nie gesehen",
  "connection.host.unreachablePlain": "nicht erreichbar",
  "connection.host.unreachableSuffix": "nicht erreichbar · {label}",
  "connection.host.incompatible": "inkompatibel",
  "connection.host.lead": "lead",
  "connection.host.onPrefix": "auf",
  "connection.host.ariaSends": "Sendet an Host: {name}{unreachable}",
  "connection.host.ariaHost": "Host: {name}{unreachable}",
  "connection.host.ariaUnreachableSuffix": " (nicht erreichbar)",
  "connection.stale.incompatible": "{name} läuft mit einem inkompatiblen Collie",
  "connection.stale.unreachable": "{name} ist nicht erreichbar · {label}",
  "connection.stale.nothingCached": "Noch nichts für diesen Rechner zwischengespeichert.",
  "connection.stale.showingLastKnown":
    "Zeigt den letzten bekannten Stand — Antworten und Tasten werden abgelehnt, bis er antwortet.",
  "connection.stale.waitingFirst": "Noch nichts von {name} — wartet auf die erste Antwort.",
  "connection.stale.messageTemplate": "{reason}. {detail}",
  "connection.session.title": "Sitzungen",
  "connection.session.aria": "Sitzung: {name}. Sitzung wechseln",
  "connection.session.primary": "primär",
  "connection.session.unreachable": "nicht erreichbar",
  "connection.server.title": "Rechner",
  "connection.server.aria": "Host: {name}. Host wechseln",

  // --- pack ---
  "pack.title": "Pack",
  "pack.nav.back": "Zurück",
  "pack.entry.title": "Pack-Übersicht",
  "pack.entry.description": "Wie es jedem Rechner im Pack geht.",
  "pack.footer.label": "Pack · {machines} · {reachable}",
  "pack.footer.aria": "Pack-Übersicht öffnen",
  "pack.summary.counts": "{machines} · {reachable}",
  "pack.summary.machines.one": "{count} Rechner",
  "pack.summary.machines.other": "{count} Rechner",
  "pack.summary.reachable": "{count} erreichbar",
  "pack.summary.deputy": "Deputy",
  "pack.summary.noDeputy": "kein Deputy benannt",
  "pack.summary.warrant": "Vollmacht {generation}",
  "pack.summary.secret": "Geheimnis",
  "pack.summary.secretValue": "Generation {generation} · gewechselt {time}",
  "pack.member.health": "Zustand",
  "pack.member.reason": "Grund",
  "pack.member.conflict": "Konflikt",
  "pack.member.conflictValue": "{lead} führt ebenfalls · Vollmacht {generation}",
  "pack.member.conflictNoWarrant": "{lead} führt ebenfalls · keine Vollmacht",
  "pack.member.version": "Version",
  "pack.member.versionDiffers": "weicht vom Lead ab",
  "pack.member.address": "Adresse",
  "pack.member.enrolled": "Aufgenommen",
  "pack.member.secretBehind": "Hat das aktuelle Geheimnis noch nicht übernommen.",
  "pack.member.provisional": "Aufgenommen, aber nie erreicht.",
  "pack.health.reachable": "erreichbar",
  "pack.health.unreachable": "nicht erreichbar",
  "pack.health.incompatible": "inkompatibel",
  "pack.health.conflicted": "im Konflikt",
  "pack.role.deputy": "deputy",
  "pack.sheet.goTo": "Zu diesem Rechner",
  "pack.formation.aria": "Rudel-Aufstellung: {machines}",
  "pack.node.aria": "{name}, {role}, {health}",
  "pack.node.ariaPlain": "{name}, {health}",
  "pack.solo.title": "Dieser Collie führt kein Pack",
  "pack.solo.description": "Ein Pack wird auf der Kommandozeile erstellt und geändert.",
  "pack.error.title": "Pack-Status konnte nicht geladen werden",
  "pack.error.description":
    "Die Bridge hat nicht geantwortet. Collie versucht es beim nächsten Abruf erneut.",

  // --- error (boot splash, route-level error recovery) ---
  "error.boot.connecting": "Verbindet mit der Herde…",
  "error.boot.title": "Nicht verbunden",
  "error.boot.body": "Collie nicht erreichbar — Verbindung zum Host prüfen, dann erneut versuchen.",
  "error.boot.retry": "Erneut versuchen",
  "error.root.title": "Etwas ist schiefgelaufen",
  "error.root.unknown": "Unbekannter Fehler",
  "error.root.reload": "Neu laden",

  // --- idle (the idle-pause cover) ---
  "idle.dialogAria": "Collie pausiert",
  "idle.catchingUp.title": "Holt auf",
  "idle.catchingUp.body": "Lädt den aktuellen Stand der Herde.",
  "idle.paused.title": "Pausiert",
  "idle.paused.body":
    "Live-Updates gestoppt, während dieser Bildschirm untätig war — was dahinter liegt, ist eingefroren. Fortsetzen setzt genau dort fort, wo du warst.",
  "idle.resume": "Zum Fortsetzen antippen",

  // --- pwa (self-update banner) ---
  "pwa.updateAvailable": "Neue Version — zum Aktualisieren antippen",

  // --- history (pane transcript route) ---
  "history.unavailable.disabled": "Transkript-Verlauf ist auf dieser Bridge deaktiviert (COLLIE_TRANSCRIPT).",
  "history.unavailable.noSession": "Dieses Pane hat keine Agenten-Sitzung, also gibt es kein Transkript.",
  "history.unavailable.noLog": "Für die Sitzung dieses Panes wurde noch keine Transkriptdatei gefunden.",
  "history.unavailable.error": "Transkript konnte nicht gelesen werden. Zurück und erneut versuchen.",
  "history.findAria": "Im Verlauf suchen",
  "history.closeAria": "Verlauf schließen",
  "history.title": "Verlauf",
  "history.loadOlder": "Ältere laden",
  "history.loading": "Lädt…",
  "history.startClipped": "Anfang des lesbaren Transkripts (das Log wurde am Lesestopp abgeschnitten)",
  "history.startOfConversation": "Anfang der Unterhaltung",
  "history.prevMessageAria": "Vorherige gesendete Nachricht",
  "history.nextMessageAria": "Nächste gesendete Nachricht",
  "history.loadOlderFailed": "Älterer Verlauf konnte nicht geladen werden",

  // --- transcript (transcript-view turn rendering) ---
  "transcript.summaryLabel": "Kontext komprimiert",
  "transcript.systemLabel": "System",
  "transcript.youLabel": "Du",
  "transcript.agentFallback": "Agent",
  "transcript.outputTruncated": "… Ausgabe gekürzt",
  "transcript.truncated": "… gekürzt",

  // --- time (relative/clock formatting) ---
  "time.justNow": "gerade eben",
  "time.compact.now": "jetzt",

  // --- sync (how fresh the herd on screen is, and asking for a fresher one) ---
  "sync.pull.hint": "Zum Aktualisieren ziehen",
  "sync.pull.release": "Loslassen zum Aktualisieren",
  "sync.pull.busy": "Wird aktualisiert…",

  // --- dialog (menu / multi-select / wizard / preview-select block renderers) ---
  "dialog.sendingAria": "Sendet",
  "dialog.previousStepAria": "Vorheriger Schritt",
  "dialog.nextStepAria": "Nächster Schritt",
  "dialog.answeredAria": "Beantwortet",
  "dialog.submitChip": "Absenden",
  "dialog.stepPosition.step": "Schritt {index} von {total}, {label}",
  "dialog.stepPosition.submit": "Schritt {index} von {total}, Absenden",
  "dialog.chooseOption": "Option wählen",
  "dialog.questionsAria": "Fragen",
  "dialog.reviewAnswers": "Antworten prüfen",
  "dialog.readySubmit": "Antworten jetzt absenden?",
  "dialog.incomplete": "Nicht alle Fragen beantwortet",
  "dialog.submitAnswers": "Antworten absenden",
  "dialog.cancel": "Abbrechen",
  "dialog.endsQuestionsSuffix": "— beendet die Fragen",
  "dialog.menu.moveUp": "Nach oben",
  "dialog.menu.moveDown": "Nach unten",
  "dialog.menu.leftAria": "Links — {verb} ({label})",
  "dialog.menu.rightAria": "Rechts — {verb} ({label})",
  "dialog.preview.currentAnswerAria": "Aktuelle Antwort",
  "dialog.preview.previewedBelowAria": "Vorschau unten",
  "dialog.preview.previewLabel": "Vorschau · {label}",
  "dialog.preview.editingBanner": "Notiz wird im Terminal bearbeitet — Bedienelemente kehren zurück, sobald es schließt.",
  "dialog.preview.noteForQuestion": "Notiz zu dieser Frage",
  "dialog.preview.noteTextAria": "Notiztext",
  "dialog.preview.notePlaceholder": "Kontext für deine Antwort hinzufügen…",
  "dialog.preview.saveNote": "Notiz speichern",
  "dialog.preview.editNoteAria": "Notiz bearbeiten",
  "dialog.preview.removeNoteAria": "Notiz entfernen",
  "dialog.preview.noteAria": "Notiz",
  "dialog.preview.addNote": "Notiz zu dieser Antwort hinzufügen",

  // --- reply (the free-text reply race guard, lib/reply-action.ts) ---
  "reply.blocked.noBox":
    "Das Eingabefeld des Agenten ist nicht zu sehen — vermutlich ist ein Menü oder Dialog offen. Nichts wurde getippt.",
  "reply.blocked.noEcho":
    "Das ist eine Passwortabfrage — sie zeigt beim Tippen nichts an, daher kann Senden nie bestätigen, dass der Text angekommen ist. Nichts wurde getippt.",
  "reply.blocked.composerLeft":
    "Das Eingabefeld des Agenten ist verschwunden, während die Eingabezeile geleert wurde — vermutlich ist ein Menü oder Dialog offen. Deine Nachricht wurde nicht getippt.",
  "reply.stalled.noEcho":
    "Das ist eine Passwortabfrage — sie zeigt beim Tippen nichts an, daher kann der Text nicht bestätigt werden und wurde nicht gesendet. Was du getippt hast, steht bereits im Pane.",
  "reply.stalled.generic":
    "Die Nachricht hat das Eingabefeld nicht erreicht — vielleicht wartet ein Dialog, und falls du ihn per Taste beantwortet hast, ist diese Taste wahrscheinlich angekommen. Nichts wurde gesendet.",

  // --- previewAction (the preview-select dialog's note flow, lib/preview-action.ts) ---
  "previewAction.note.notOpened": "Notizfeld hat sich nicht geöffnet — Pane prüfen",
  "previewAction.note.clearFailed": "Bestehende Notiz konnte nicht gelöscht werden — Pane prüfen",
  "previewAction.note.textFailed": "Notiztext ist nicht angekommen — Pane prüfen",
  "previewAction.note.closeFailed": "Notizfeld hat sich nicht geschlossen — Pane prüfen",

  // --- promptAction (the plan-feedback flow, lib/prompt-action.ts) ---
  "promptAction.feedback.freeTextUnsupported":
    "Die Freitextzeile dieses Dialogs wird nicht vom Handy aus getippt",
  "promptAction.feedback.empty": "Nichts zu senden",
  "promptAction.feedback.boxNotOpened": "Das Feedback-Feld hat sich nicht geöffnet — Pane prüfen",
  "promptAction.feedback.notArrived": "Das Feedback ist nicht angekommen — nichts wurde gesendet",

  // --- stt (speech-to-text errors, lib/stt.ts + hooks/use-stt-recorder.ts) ---
  "stt.error.busy": "Beschäftigt — eine andere Aufnahme wird noch transkribiert. Gleich erneut versuchen.",
  "stt.error.tooLong": "Diese Aufnahme ist zu lang — kürzer aufnehmen.",
  "stt.error.badFormat":
    "Dieser Browser hat ein Format aufgenommen, das Collie nicht weitergeben kann.",
  "stt.error.unconfigured": "Spracherkennung ist auf diesem collie nicht eingerichtet.",
  "stt.error.timeout": "Der Transkriptionsdienst hat nicht rechtzeitig geantwortet — erneut versuchen.",
  "stt.error.unreachable": "Der Transkriptionsdienst war nicht erreichbar — erneut versuchen.",
  "stt.error.generic": "Transkription fehlgeschlagen — erneut aufnehmen, um es noch einmal zu versuchen.",
  "stt.error.networkFailure":
    "Collie konnte nicht erreicht werden, um das zu transkribieren — erneut versuchen.",
  "stt.error.recordingFailed": "Aufnahme fehlgeschlagen — nichts wurde erfasst.",
  "stt.error.noSpeechHeard": "In dieser Aufnahme war nichts zu hören.",
  "stt.error.nothingRecorded": "Es wurde nichts aufgenommen.",
  "stt.error.unsupportedBrowser": "Dieser Browser kann kein Audio aufnehmen.",
  "stt.error.micRefused": "Mikrofonzugriff wurde verweigert.",

  // --- directTyping (the composer's "Type into terminal" mode, hooks/use-direct-typing.ts) ---
  "directTyping.status.draftPending":
    "Entwurf senden oder löschen, bevor du ins Terminal tippst.",
  "directTyping.status.armed": "Tippt ins Terminal — Tasten werden sofort gesendet.",
  "directTyping.status.disarmed": "Zurück zum Senden von Antworten",
  "directTyping.status.interrupted":
    "Tippen ins Terminal beendet — die Pane-Ansicht wurde unterbrochen.",
  "directTyping.status.backgrounded":
    "Tippen ins Terminal beendet — die App wurde in den Hintergrund geschickt.",

  // --- apiError (the bridge's refusals, keyed by the code on the wire) ---
  "apiError.unknown": "Etwas ist schiefgelaufen. Erneut versuchen.",
  "apiError.reply.not_submitted":
    "Deine Nachricht wurde ins Pane getippt, aber nicht gesendet — Pane prüfen, bevor du erneut sendest.",
  "apiError.reply.send_failed": "Nachricht konnte nicht gesendet werden: {reason}",
  "apiError.keys.send_failed": "Tasten konnten nicht gesendet werden: {reason}",
  "apiError.prompt_changed":
    "Der Bildschirm hat sich vor dem Senden geändert — Pane prüfen.",
  "apiError.prompt.read_failed":
    "Pane konnte vor dem Senden nicht gelesen werden — {mux} meldet: {detail}",
  "apiError.pane.close_failed": "Pane konnte nicht geschlossen werden: {reason}",
  "apiError.pane.rename_failed": "Pane konnte nicht umbenannt werden: {reason}",
  "apiError.pane.focus_failed": "Das Pane konnte nicht im Terminal angezeigt werden: {reason}",
  "apiError.tab.create_failed": "Tab konnte nicht erstellt werden: {reason}",
  "apiError.tab.rename_failed": "Tab konnte nicht umbenannt werden: {reason}",
  "apiError.tab.close_failed": "Tab konnte nicht geschlossen werden: {reason}",
  "apiError.tab.workspace_required": "Für den neuen Tab wurde kein Space genannt.",
  "apiError.workspace.create_failed": "Space konnte nicht erstellt werden: {reason}",
  "apiError.upload.too_large": "Dieses Bild ist zu groß — 10 MB sind das Limit.",
  "apiError.upload.no_file": "Es wurde keine Datei gesendet.",
  "apiError.upload.bad_type": "Collie kann diesen Dateityp nicht senden: {type}",
  "apiError.upload.write_failed":
    "Das Bild konnte auf dem Host nicht gespeichert werden: {reason}",
  "apiError.stt.unconfigured": "Spracherkennung ist auf diesem collie nicht eingerichtet.",
  "apiError.stt.too_large": "Diese Aufnahme ist zu lang — kürzer aufnehmen.",
  "apiError.stt.bad_format":
    "Dieser Browser hat ein Format aufgenommen, das Collie nicht weitergeben kann.",
  "apiError.stt.busy":
    "Zwei Aufnahmen werden bereits transkribiert — gleich erneut versuchen.",
  "apiError.stt.unreadable": "Diese Aufnahme konnte nicht gelesen werden.",
  "apiError.stt.empty": "Diese Aufnahme ist leer.",
  "apiError.stt.provider_failed": "Die Transkription ist fehlgeschlagen: {reason}",
  "apiError.pairing.bad_request":
    "Code oder Name waren ungültig. Ein Name hat 1–48 Zeichen.",
  "apiError.pairing.no_pending": "Auf dem Host wartet kein Kopplungscode.",
  "apiError.pairing.expired": "Dieser Kopplungscode ist abgelaufen.",
  "apiError.pairing.exhausted": "Zu viele falsche Codes — die Kopplung wurde verworfen.",
  "apiError.pairing.bad_code": "Dieser Code stimmt nicht.",
  "apiError.pairing.duplicate_label": "Ein Gerät nutzt diesen Namen bereits.",
  "apiError.device.unknown": "Kein gekoppeltes Gerät heißt so.",
  "apiError.session.unknown": "Auf diesem collie gibt es keine Sitzung namens {session}.",
  "apiError.host.unknown": "In diesem pack gibt es keinen collie namens {host}.",
  "apiError.pack.not_lead": "Dieser collie führt kein pack, also gibt es kein pack zu zeigen.",
};
