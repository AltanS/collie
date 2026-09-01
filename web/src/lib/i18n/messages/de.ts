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
  "settings.theme.description": "Systemeinstellung übernehmen oder festlegen.",
  "settings.theme.option.system": "System",
  "settings.theme.option.light": "Hell",
  "settings.theme.option.dark": "Dunkel",

  // --- settings.haptics ---
  "settings.haptics.title": "Haptik",
  "settings.haptics.description": "Kurze Vibration bei Tastendruck und Schnellantworten.",


  // --- settings.zen ---
  // Availability only: the toggle decides whether the pane menu offers zen at all.
  "settings.install.title": "App installieren",
  "settings.install.description": "Collie zum Startbildschirm hinzufügen: Vollbild und eigenes App-Icon.",
  "settings.install.button": "Installieren",
  "settings.install.iosHint": "Unter iOS und iPadOS über das Teilen-Menü des Browsers installieren: Teilen antippen, dann „Zum Home-Bildschirm“.",
  "settings.zen.title": "Zen-Modus",
  "settings.zen.description": "Fügt dem Menü einen Eintrag hinzu, der alle Elemente außer dem Terminal ausblendet.",

  // --- settings.handsFree ---
  "settings.handsFree.title": "Freisprechen",
  "settings.handsFree.description":
    "Transkript sofort senden, statt es im Eingabefeld abzulegen. Standardmäßig deaktiviert, um Eingaben vor dem Senden an das Terminal prüfen zu können.",
  "settings.handsFree.ariaLabel": "Freisprechen: Transkript sofort senden",

  // --- settings.push ---
  "settings.push.title": "Push-Benachrichtigungen",
  "settings.push.description": "Benachrichtigung empfangen, wenn ein Agent Eingaben erfordert.",
  "settings.push.reason.insecure": "Push erfordert eine HTTPS-Verbindung.",
  "settings.push.reason.serverOff": "Push ist auf der Bridge nicht konfiguriert (keine VAPID-Schlüssel).",
  "settings.push.reason.denied":
    "Benachrichtigungen sind blockiert. In den Browsereinstellungen aktivieren.",
  "settings.push.reason.unsupported": "Dieser Browser unterstützt keine Push-Benachrichtigungen.",
  "settings.push.reason.default": "Push-Benachrichtigungen konnten nicht aktiviert werden.",
  "settings.push.availability.insecure":
    "Über HTTP nicht verfügbar. Collie über HTTPS bereitstellen, um Push zu nutzen.",
  "settings.push.availability.serverOff":
    "Auf der Bridge sind keine VAPID-Schlüssel hinterlegt. Push ist serverseitig deaktiviert.",
  "settings.push.availability.denied":
    "Benachrichtigungen für diese Seite sind blockiert. In den Browsereinstellungen freigeben.",
  "settings.push.availability.unsupported":
    "Dieser Browser unterstützt keine Push-Benachrichtigungen.",

  // --- settings.notify ---
  "settings.notify.title": "Benachrichtigen bei",
  "settings.notify.description": "Gilt für alle Geräte.",
  "settings.notify.blocked.label": "Eingabe erforderlich",
  "settings.notify.blocked.hint": "ein Agent wartet auf Rückmeldung",
  "settings.notify.done.label": "Fertiggestellt",
  "settings.notify.done.hint": "ein Agent schließt seine Aufgabe ab",
  "settings.notify.updates.label": "App-Updates",
  "settings.notify.updates.hint": "eine neue Collie-Version ist verfügbar",

  // --- settings.snooze ---
  "settings.snooze.title": "Nicht stören",
  "settings.snooze.description.idle": "Push-Benachrichtigungen vorübergehend pausieren.",
  "settings.snooze.description.active": "Pausiert bis {time}. Bis dahin werden keine Benachrichtigungen zugestellt.",
  "settings.snooze.resume": "Jetzt fortsetzen",
  "settings.snooze.preset.min30": "30m",
  "settings.snooze.preset.hour1": "1h",
  "settings.snooze.preset.hour4": "4h",

  // --- settings.devices ---
  "settings.devices.title": "Gekoppelte Geräte",
  "settings.devices.description.enforced":
    "Schreibzugriffe erfordern ein gekoppeltes Gerät. Lesezugriff bleibt offen.",
  "settings.devices.description.open":
    "Keine Geräte gekoppelt, Schreibzugriffe sind ungesichert. Ein Gerät koppeln, um Authentifizierung zu erzwingen.",
  "settings.devices.pairedAs": "Dieses Gerät ist gekoppelt als {device}.",
  "settings.devices.loadError": "Gekoppelte Geräte konnten nicht von der Bridge geladen werden.",
  "settings.devices.thisDevice": "Dieses Gerät",
  "settings.devices.row.meta": "Gekoppelt {paired} · Zuletzt aktiv {lastSeen}",
  "settings.devices.revokeError": "Gerät konnte nicht widerrufen werden.",
  "settings.devices.cancel": "Abbrechen",
  "settings.devices.unpairSelf": "Dieses Gerät entkoppeln",
  "settings.devices.revoke": "Widerrufen",
  "settings.devices.revokeAria": "{label} widerrufen",
  "settings.devices.pair.title": "Dieses Gerät koppeln",
  "settings.devices.pair.hint": "{command} auf dem Host ausführen und den ausgegebenen Code eingeben.",
  "settings.devices.pair.codeLabel": "Kopplungscode",
  "settings.devices.pair.codePlaceholder": "8 Zeichen",
  "settings.devices.pair.nameLabel": "Gerätename",
  "settings.devices.pair.namePlaceholder": "z. B. Smartphone",
  "settings.devices.pair.networkError":
    "Bridge nicht erreichbar. Verbindung prüfen und erneut versuchen.",
  "settings.devices.pair.failure.noPending":
    "Kein offener Kopplungscode vorhanden. `bin/collie pair` auf dem Host ausführen, um einen zu generieren.",
  "settings.devices.pair.failure.expired":
    "Dieser Code ist abgelaufen. `bin/collie pair` auf dem Host ausführen, um einen neuen zu erzeugen.",
  "settings.devices.pair.failure.exhausted":
    "Zu viele Fehlversuche. Die Kopplung wurde verworfen. `bin/collie pair` auf dem Host ausführen, um neu zu starten.",
  "settings.devices.pair.failure.badCode":
    "Code stimmt nicht überein. Eingabe prüfen. Nach weiteren Fehlversuchen verfällt der Code.",
  "settings.devices.pair.failure.duplicateLabel":
    "Dieser Name wird bereits verwendet. Anderen Namen wählen, der Code bleibt gültig.",
  "settings.devices.pair.failure.badRequest":
    "Code oder Name ungültig. Namen müssen 1–48 Zeichen lang sein.",

  // --- settings.connection ---
  "settings.connection.title": "Verbindung",
  "settings.connection.description": "Diagnosedaten für dieses Gerät.",
  "settings.connection.row.endpoint": "Endpunkt",
  "settings.connection.row.secure": "Sicherer Kontext",
  "settings.connection.row.bridge": "Bridge",
  "settings.connection.row.deviceAccess": "Gerätezugriff",
  "settings.connection.row.serverBuild": "Server-Build",
  "settings.connection.secure.yes": "Ja",
  "settings.connection.secure.no": "Nein (HTTP)",
  "settings.connection.bridge.connected": "Verbunden",
  "settings.connection.bridge.offline": "Herdr offline",
  "settings.connection.bridge.connecting": "Verbindung wird hergestellt…",
  "settings.connection.device.notEnforced": "Nicht erzwungen",
  "settings.connection.device.fullAccessNamed": "Vollzugriff · {device}",
  "settings.connection.device.fullAccessLocal": "Vollzugriff (lokal)",
  "settings.connection.device.readOnlyNamed": "Schreibgeschützt · {device}",
  "settings.connection.device.readOnly": "Schreibgeschützt",

  // --- settings.update (update-check-control + footer update banner) ---
  "settings.update.title": "Updates",
  "settings.update.check.prompt": "Auf neue Collie-Versionen prüfen.",
  "settings.update.check.running": "Version v{current}",
  "settings.update.check.runningChecked": "Version v{current} · Geprüft {checked}",
  "settings.update.action": "Nach Updates suchen",
  "settings.update.checking": "Wird geprüft…",
  "settings.update.error": "Prüfung fehlgeschlagen.",
  "settings.update.upToDate": "Aktuell",
  "settings.updateBanner.restart": "Bridge-Neustart erforderlich",
  "settings.updateBanner.releaseAvailable": "Collie {version} verfügbar",
  "settings.updateBanner.majorAvailable": "Collie {version} (Major-Release)",
  "settings.updateBanner.copyAria": "Befehl kopieren: {command}",

  // --- settings.typeface ---
  "settings.typeface.title": "Schriftart",
  "settings.typeface.description": "Oberflächenschrift auf diesem Gerät.",
  "settings.typeface.family": "Schriftfamilie",
  "settings.typeface.system": "Systemstandard",
  "settings.typeface.note.system": "Systemschrift des Geräts. Kein zusätzlicher Download.",
  "settings.typeface.note.grotesk": "Eigene Collie-Schrift, abgestimmt auf das Logo.",
  "settings.typeface.note.aldrich": "Nur eine Schriftstärke: Fetter Text wird wie normaler Text dargestellt.",
  "settings.typeface.note.operator": "Vom Betreiber dieser Collie-Instanz hinterlegt.",

  // --- settings.fonts ---
  "settings.fonts.title": "Terminal-Schrift",
  "settings.fonts.description": "Schrift für Terminal-Spiegel und Eingabefeld auf diesem Gerät.",
  "settings.fonts.family": "Schriftfamilie",
  "settings.fonts.size": "Terminal-Text",
  "settings.fonts.draftSize": "Eingabe-Text",
  "settings.fonts.draftSize.hint":
    "Unter iOS fest auf 16 px gesetzt, da Safari bei kleineren Schriftgrößen automatisch heranzoomt und nicht zurücksetzt.",
  "settings.fonts.draftSize.decrease": "Schriftgröße der Eingabe verringern",
  "settings.fonts.draftSize.increase": "Schriftgröße der Eingabe erhöhen",
  "settings.fonts.system": "Systemstandard",

  // --- settings.display (mirror display prefs, behind the composer's ⚙ dock) ---
  "settings.display.wrap.label": "Zeilenumbruch",
  "settings.display.wrap.hint":
    "Deaktiviert: Spaltentreue Darstellung für TUI-Tabellen mit horizontalem Scrollen.",
  "settings.display.tapToType.label": "Tippen zum Schreiben",
  "settings.display.tapToType.hint":
    "Aktiv: Antippen des Spiegels öffnet überall die Tastatur. Deaktiviert: Spiegel bleibt Textanzeige, Tastatur öffnet nur im Eingabefeld.",
  "settings.display.rawTerminal.label": "Rohes Terminal",
  "settings.display.rawTerminal.hint":
    "Zeigt den reinen Terminal-Puffer ohne Buttons, Rahmen oder Statusleisten. Gedacht für falsch dargestellte TUI-Dialoge zur manuellen Tastensteuerung.",
  "settings.display.textSize.label": "Textgröße",
  "settings.display.textSize.decrease": "Schriftgröße verringern",
  "settings.display.textSize.increase": "Schriftgröße erhöhen",

  // --- settings.buildStamp ---
  "settings.buildStamp.tapToUpdate": "Neuer Build verfügbar, zum Aktualisieren antippen",
  "settings.buildStamp.updating": "Wird aktualisiert…",

  // --- composer (the reply box + its Keys/Quick/Display docks) ---
  "composer.dock.closeAria": "{title} schließen",
  "composer.controls.label": "Steuerung",
  "composer.controls.keys": "Tasten",
  "composer.controls.typeAria": "Ins Terminal schreiben",
  "composer.controls.type": "Tippen",
  "composer.controls.quick": "Schnell",
  "composer.controls.agent": "Agent",
  "composer.controls.displayAria": "Anzeigeeinstellungen",
  "composer.controls.display": "Anzeige",
  "composer.sentPreview.label": "Gesendet:",
  "composer.placeholder.gone": "Pane existiert nicht mehr",
  "composer.placeholder.readOnly": "Schreibgeschützt: Gerät nicht autorisiert",
  "composer.placeholder.noMuxSend": "Eingabe in dieses Terminal nicht möglich",
  "composer.placeholder.direct": "Ins Terminal eingeben…",
  "composer.placeholder.shell": "Shell-Befehl eingeben…",
  "composer.placeholder.reply": "Antwort eingeben…",
  "composer.mic.unavailable": "Spracheingabe nicht verfügbar",
  "composer.mic.stopAria": "Aufnahme beenden",
  "composer.mic.recordAria": "Sprachnachricht aufnehmen",
  "composer.mic.transcribing": "Transkription läuft…",
  "composer.mic.recording": "Aufnahme: {elapsed}",
  "composer.mic.handsFreeHint": "Wird beim Beenden gesendet",
  "composer.mic.manualHint": "Wird in das Eingabefeld eingefügt",
  "composer.mic.stop": "Stopp",
  "composer.mic.discardAria": "Aufnahme verwerfen",
  "composer.attach.aria": "Bild anhängen",
  "composer.send.typeAnyway": "Trotzdem tippen",
  "composer.send.reallySend": "Senden bestätigen",
  "composer.send.stopTypingAria": "Eingabe ins Terminal abbrechen",
  "composer.send.sendAria": "Senden",
  "composer.draft.tooLong":
    "Zu lang für einen dauerhaften Entwurf. Bleibt beim Pane-Wechsel erhalten, geht aber beim Beenden der App verloren.",
  "composer.status.dialogWaiting": "Ein Dialog ist geöffnet. Erst antworten, dann senden.",
  "composer.status.paneNotWritable": "Pane ist nicht mehr beschreibbar. Nichts gesendet.",
  "composer.status.inputChanged":
    "Eingabefeld hat sich beim Leeren geändert. Es wurde nichts getippt. Pane prüfen.",
  "composer.status.clearFailed": "Terminal-Eingabe konnte nicht geleert werden",
  "composer.status.sent": "Gesendet ✓",
  "composer.status.tapAgainToType": "{error} Erneut tippen, um die Eingabe trotzdem zu senden.",
  "composer.discard.confirmKeys.one": "Erneut tippen, um {count} wartende Taste zu verwerfen",
  "composer.discard.confirmKeys.other": "Erneut tippen, um {count} wartende Tasten zu verwerfen",
  "composer.destructive.confirm": "Destruktiv: {reason}. Erneut tippen zum Bestätigen.",
  "composer.destructive.confirmOnHost":
    "Destruktiv: {reason} auf {host}. Erneut tippen zum Bestätigen.",
  "composer.upload.success": "Bild hinzugefügt, Pfad steht in der Nachricht",
  "composer.noEcho.title": "Passwortabfrage ohne Echo",
  "composer.noEcho.noLiveTyped":
    "Der Text steht unbestätigt im Pane. Da diese Ansicht nicht live ist, kann von hier aus nichts gesendet werden. Die Eingabe direkt im Terminal beantworten.",
  "composer.noEcho.noLiveUntyped":
    "Es wurde nichts getippt. Diese Ansicht ist nicht live, passende Tasten können von hier aus nicht übermittelt werden.",
  "composer.noEcho.liveTyped":
    "Der Text steht bereits im Pane. Da er nicht bestätigt werden konnte, wurde er nicht abgeschickt. Im Tippen-Modus Enter drücken und nicht erneut senden.",
  "composer.noEcho.liveUntyped":
    "Senden bestätigt eingegebenen Text, aber diese Abfrage liefert kein Echo. Der Tippen-Modus leitet Tasten direkt weiter, inklusive Enter.",
  "composer.noEcho.useType": "Tippen-Modus nutzen",
  "composer.noEcho.dismissAria": "Passworthinweis verwerfen",
  "composer.draftPreview.title": "Entwurf im Terminal",
  "composer.draftPreview.takeOver": "Übernehmen",

  // --- sendMode (the armed "typing straight through" indicator) ---
  "sendMode.armed.title": "Eingabe ins Terminal",
  "sendMode.armed.hint": "Tastatureingaben werden direkt weitergeleitet",
  "sendMode.armed.stop": "Stopp",

  // --- chat (the pane view shell: header, mirror, switcher) ---
  "chat.zen.label": "Zen-Modus",
  // The floating pill is the ONE way out of zen, and it carries no words — only the glyph.
  "chat.zen.exitAria": "Zen-Modus beenden",
  "chat.strips.hide.both": "Tabs und Panes ausblenden",
  "chat.strips.hide.tabs": "Tabs ausblenden",
  "chat.strips.hide.panes": "Panes ausblenden",
  "chat.strips.show.both": "Tabs und Panes anzeigen. {tabs}, {panes} ausgeblendet.",
  "chat.strips.show.tabs": "Tabs anzeigen. {tabs} ausgeblendet.",
  "chat.strips.show.panes": "Panes anzeigen. {panes} ausgeblendet.",
  "chat.find.label": "In Ausgabe suchen",
  "chat.history.label": "Verlauf",
  "chat.paneMenu.aria": "Pane-Aktionen",
  "chat.header.openOverviewAria": "Übersicht für {workspace} öffnen{status}",
  "chat.header.statusAria": ", {label}",
  "chat.header.agentGone": "(Agent nicht erreichbar)",
  "chat.scrollback.showHistory": "Gesamten Verlauf anzeigen",
  "chat.scrollback.loadOlder": "Ältere Einträge laden",
  "chat.scrollback.loading": "Wird geladen…",
  "chat.scrollback.noSessionReported":
    "{agent} hat keine Sitzung an Herdr gemeldet. Herdr-Integration installieren oder aktualisieren und den Agenten in diesem Pane neu starten.",
  "chat.output.empty": "(keine neue Ausgabe)",
  "chat.switcher.aria": "Pane wechseln",
  "chat.switcher.title": "Pane wechseln",
  "chat.status.feedbackSent": "Feedback gesendet",
  "chat.status.sent": "Gesendet",
  "chat.status.menuChanged": "Menü geändert, Aktualisierung läuft",
  "chat.status.sendFailed": "Senden fehlgeschlagen",
  "chat.status.wizardChanged": "Assistent geändert, Aktualisierung läuft",
  "chat.status.noteSaved": "Notiz gespeichert",
  "chat.status.noteRemoved": "Notiz entfernt",
  "chat.status.dialogChanged": "Dialog geändert, Aktualisierung läuft",
  "chat.status.selectionChanged": "Auswahl geändert, Aktualisierung läuft",
  "chat.status.screenChanged": "Bildschirm geändert, Aktualisierung läuft",
  "chat.status.readOnly": "Schreibgeschützt: Gerät nicht autorisiert",

  // --- prompt (the native prompt-select / plan-feedback block) ---
  "prompt.family.select": "Option wählen",
  "prompt.family.permission": "Berechtigung erforderlich",
  "prompt.family.trust": "Diesem Ordner vertrauen",
  "prompt.family.plan": "Plan prüfen",
  "prompt.sendingAria": "Wird gesendet",
  "prompt.feedback.cancel": "Abbrechen",
  "prompt.feedback.typedAria": "Feedback im Terminal",
  "prompt.feedback.planChange.offer": "Änderungen an Claude übermitteln",
  "prompt.feedback.planChange.editorLabel": "Gewünschte Änderungen",
  "prompt.feedback.planChange.textAria": "Feedbacktext",
  "prompt.feedback.planChange.placeholder": "Gewünschte Anpassungen beschreiben…",
  "prompt.feedback.planChange.help":
    "Sendet den Plan mit Anmerkungen zurück. Claude plant weiter, anstatt mit der Ausführung zu beginnen.",
  "prompt.feedback.planChange.send": "Feedback senden",
  "prompt.feedback.planChange.sending": "Feedback wird gesendet…",
  "prompt.feedback.planChange.focused":
    "Das Feedback-Feld hat den Fokus im Terminal. Tastatureingaben schreiben in das Feld, anstatt Aktionen auszulösen. Nach dem Schließen sind die Schaltflächen wieder aktiv.",
  "prompt.feedback.planChange.typedPrefix": "Feedback-Eingabe im Terminal: ",
  "prompt.feedback.freeText.focused":
    "Die Freitextzeile hat den Fokus im Terminal. Tastatureingaben schreiben in das Feld, anstatt Aktionen auszulösen. Nach dem Schließen sind die Schaltflächen wieder aktiv.",
  "prompt.feedback.freeText.typedPrefix": "Eigene Eingabe im Terminal: ",

  // --- paneActions (long-press sheet: rename / close a pane) ---
  "paneActions.title.fallback": "Pane",
  "paneActions.readOnly": "Nur Lesezugriff: Dieses Gerät darf Panes weder umbenennen noch schließen.",
  "paneActions.hostBlockSuffix": "{hostBlock}: Umbenennen und Schließen bleiben blockiert, bis der Host antwortet.",
  "paneActions.rename.label": "Umbenennen",
  "paneActions.rename.placeholder": "Pane-Name",
  "paneActions.close.label": "Pane schließen",
  "paneActions.close.confirm": "Zum Schließen erneut tippen",
  "paneActions.close.closing": "Wird geschlossen…",
  // TODO(translation): English changed from "Show in terminal" to "Focus in {mux}" — needs a
  // translator's call on the verb ("focus") and where a multiplexer name sits in a German
  // sentence. Kept the old "show" wording for now rather than guess; `{mux}` is unused here.
  "paneActions.focus.labelWithMux": "Im Terminal anzeigen",
  "paneActions.focus.labelFallback": "Im Terminal fokussieren",
  "paneActions.focus.done": "Im Terminal fokussiert",
  "paneActions.focus.failed": "Fokussieren im Terminal fehlgeschlagen",
  "paneActions.empty.fallback": "Dieser Multiplexer unterstützt keine Pane-Aktionen.",
  "paneActions.status.renamed": "Umbenannt",
  "paneActions.status.labelCleared": "Label entfernt",
  "paneActions.status.renameFailed": "Umbenennen fehlgeschlagen",
  "paneActions.status.closeFailed": "Schließen fehlgeschlagen",

  // --- keys (the inline Keys tray + its staging strip) ---
  "keys.tab.keys": "Tasten",
  "keys.presets.label": "Voreinstellungen",
  "keys.fkeys.label": "F-Tasten",
  "keys.confirm.label": "Bestätigen",
  "keys.queue.removeAria": "{label} entfernen",
  "keys.queue.charPlaceholder": "Taste",
  "keys.queue.charAria": "Taste für Kombination eingeben",
  "keys.queue.send": "Senden",
  "keys.queue.clearAria": "Warteschlange leeren",

  // --- nav (app header, Collie mark, settings gear) ---
  "nav.settings.aria": "Einstellungen",
  "nav.home.aria.default": "Collie-Startseite",
  "nav.home.aria.lost": "Collie-Startseite: nicht verbunden",
  "nav.home.aria.reconnecting": "Collie-Startseite: verbindet neu",
  "nav.mux.onPrefix": "auf",
  "nav.prereleaseTitle": "Vorabversion: {version}",

  // --- home (dashboard herd list) ---
  "home.empty.disconnected": "Nicht verbunden",
  "home.empty.disconnectedAt": "Nicht verbunden, zuletzt aktiv: {time}",
  "home.empty.noAgents": "Keine aktiven Agenten.",
  "home.empty.waiting": "Warten auf Herdr...",
  "home.empty.panesHint": "Panes befinden sich unter Spaces.",
  "home.allClear": "Kein Handlungsbedarf",
  "home.sort.newest": "Neueste",
  "home.sort.oldest": "Älteste",
  "home.sort.aria.newest": "Sortiert nach letzter Nutzung. Zu älteste zuerst wechseln",
  "home.sort.aria.oldest": "Sortiert nach älteste zuerst. Zu letzter Nutzung wechseln",
  "home.sidebar.shells": "Shells",
  "home.sidebar.paneActionsTitle": "Pane-Aktionen anzeigen",

  // --- status (triage sections, status labels, counts) ---
  "status.section.needsYou": "Eingabe erforderlich",
  "status.section.readyUnseen": "Bereit · Ungesehen",
  "status.section.working": "In Arbeit",
  "status.section.recent": "Zuletzt",
  "status.label.blocked": "wartet auf Eingabe",
  "status.label.working": "läuft",
  "status.label.idle": "inaktiv",
  "status.label.done": "abgeschlossen",
  "status.label.unknown": "unbekannt",
  "status.count.needsYou.one": "{count} wartet auf Eingabe",
  "status.count.needsYou.other": "{count} warten auf Eingabe",
  "status.count.working.one": "{count} läuft",
  "status.count.working.other": "{count} laufen",
  "status.shellBadge": "shell",
  "status.dismissAria": "Verwerfen",

  // --- space (spaces overview/strip/view, tabs, panes, new-space) ---
  "space.overview.title": "Spaces",
  "space.overview.new.aria": "Neuer Space",
  "space.overview.filter.placeholder": "Spaces filtern…",
  "space.overview.filter.aria": "Spaces filtern",
  "space.overview.empty.none": "Keine Spaces vorhanden.",
  "space.overview.empty.noMatch": "Kein Space entspricht „{query}“.",
  "space.overview.needsYou.one": "{count} Space erfordert Aufmerksamkeit",
  "space.overview.needsYou.other": "{count} Spaces erfordern Aufmerksamkeit",
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
  "space.view.noPanesInTab": "Dieser Tab enthält keine Panes.",
  "space.view.noPanesInSpace": "Dieser Space enthält keine Panes.",
  "space.tabStrip.title": "Tabs",
  "space.tabStrip.all": "Alle",
  "space.tabStrip.new.aria": "Neuer Tab",
  "space.paneStrip.title": "Panes",
  "space.new.title": "Neuer Space",
  "space.new.dir.label": "Verzeichnis (optional)",
  "space.new.dir.placeholder": "~ (Home-Verzeichnis)",
  "space.new.label.label": "Label (optional)",
  "space.new.label.placeholder": "Space benennen",
  "space.new.create": "Space erstellen und Shell öffnen",
  "space.tab.titleFallback": "Tab",
  "space.tab.titleWithLabel": "Tab {label}",
  "space.tab.readOnly": "Schreibgeschützt. Dieses Gerät darf Tabs nicht umbenennen oder schließen.",
  "space.tab.hostBlockSuffix": "{hostBlock}: Umbenennen und Schließen erst nach Antwort möglich.",
  "space.tab.rename": "Umbenennen",
  "space.tab.close": "Tab schließen",
  "space.tab.closing": "Wird geschlossen…",
  "space.tab.closeConfirm.one": "Erneut tippen, um {count} Pane zu schließen",
  "space.tab.closeConfirm.other": "Erneut tippen, um {count} Panes zu schließen",
  "space.tab.closeConfirmPlain": "Erneut tippen zum Schließen",
  "space.tab.empty.fallback": "Dieser Multiplexer unterstützt keine Tab-Aktionen.",
  "space.tab.placeholder": "Tab benennen",
  "space.tab.renamed": "Umbenannt",
  "space.tab.renameFailed": "Umbenennen fehlgeschlagen",
  "space.tab.closeFailed": "Schließen fehlgeschlagen",
  "space.tab.closed": "Tab geschlossen",
  "space.readOnly.notPaired": "Nicht gekoppelt. Dieses Gerät in den Einstellungen koppeln.",
  "space.readOnly.deviceUnauthorised": "Schreibgeschützt: Gerät nicht autorisiert",
  "space.create.ready": "Neuer {what} bereit. Agent starten.",
  "space.noun.tab": "Tab",
  "space.noun.space": "Space",

  // --- actionSheet (shared rename/back/save rows behind pane + tab long-press sheets) ---
  "actionSheet.back": "Zurück",
  "actionSheet.label": "Bezeichnung",
  "actionSheet.save": "Speichern",

  // --- commands (agent command palette) ---
  "commands.title": "Agent-Befehle",
  "commands.search.placeholder": "{count} Befehle durchsuchen…",
  "commands.common.hint": "Häufig · Tippen, um alle {count} zu durchsuchen",
  "commands.empty": "Keine Befehle für „{query}“ gefunden.",
  "commands.confirm": "Bestätigen",

  // --- quickActions (one-tap reply dock) ---
  "quickActions.group.confirm": "Bestätigen",
  "quickActions.group.common": "Häufig",

  // --- find (the in-mirror / in-history find bar) ---
  "find.placeholder": "In {subject} suchen…",
  "find.aria": "In {subject} suchen",
  "find.prevAria": "Vorheriger Treffer",
  "find.nextAria": "Nächster Treffer",
  "find.closeAria": "Suche schließen",
  "find.subject.output": "Ausgabe",
  "find.subject.history": "Verlauf",

  // --- connection (banner, read-only strip, host chip/stale banner, session/server switchers) ---
  "connection.auth.message": "Zugriff verweigert. Es liegt kein Verbindungsproblem vor.",
  "connection.auth.signIn": "Anmelden",
  "connection.reload.aria": "Neu laden",
  "connection.retry": "Erneut versuchen",
  "common.closeAria": "Schließen",
  "common.scrollToLatestAria": "Zum Neuesten scrollen",
  "connection.connected": "Verbunden",
  "connection.reconnecting": "Verbindung wird wiederhergestellt…",
  "connection.herdrDown": "Herdr läuft auf dem Host nicht",
  "connection.offlineCantReach": "Offline: Collie ist nicht erreichbar",
  "connection.cantReach": "Collie ist nicht erreichbar",
  "connection.withLastSeen": "{cause}, zuletzt gesehen {time}",
  "connection.readOnly.notPaired": "Nicht gekoppelt. Gerät in den Einstellungen koppeln, um Eingaben an Agenten zu senden.",
  "connection.readOnly.device": "Schreibgeschützt: Dieses Gerät darf keine Eingaben an Agenten senden{deviceSuffix}.",
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
  "connection.stale.incompatible": "{name} verwendet eine inkompatible Collie-Version",
  "connection.stale.unreachable": "{name} ist nicht erreichbar · {label}",
  "connection.stale.nothingCached": "Für diesen Rechner sind noch keine Daten zwischengespeichert.",
  "connection.stale.showingLastKnown":
    "Zeigt den letzten bekannten Stand. Eingaben werden abgewiesen, bis der Rechner antwortet.",
  "connection.stale.waitingFirst": "Noch keine Daten von {name}. Warte auf erste Antwort.",
  "connection.stale.messageTemplate": "{reason}. {detail}",
  "connection.session.title": "Sitzungen",
  "connection.session.aria": "Sitzung: {name}. Sitzung wechseln",
  "connection.session.primary": "primär",
  "connection.session.unreachable": "nicht erreichbar",
  "connection.session.ariaIn": "In Sitzung: {name}",
  "connection.session.all": "Alle Sitzungen",
  "connection.session.allDescription": "Alle Sitzungen dieses Rechners in einer Liste",
  "connection.session.allAria": "Alle Sitzungen werden angezeigt. Sitzung wechseln",
  "connection.server.title": "Rechner",
  "connection.server.aria": "Host: {name}. Host wechseln",

  // --- pack ---
  "pack.title": "Pack",
  "pack.nav.back": "Zurück",
  "pack.entry.title": "Pack-Übersicht",
  "pack.entry.description": "Status aller Rechner im Pack.",
  "pack.footer.label": "Pack · {machines} · {reachable}",
  "pack.footer.aria": "Pack-Übersicht öffnen",
  "pack.summary.counts": "{machines} · {reachable}",
  "pack.summary.machines.one": "{count} Rechner",
  "pack.summary.machines.other": "{count} Rechner",
  "pack.summary.reachable": "{count} erreichbar",
  "pack.summary.deputy": "Deputy",
  "pack.summary.noDeputy": "Kein Deputy benannt",
  "pack.summary.warrant": "Vollmacht {generation}",
  "pack.summary.secret": "Geheimnis",
  "pack.summary.secretValue": "Generation {generation} · rotiert {time}",
  "pack.member.health": "Status",
  "pack.member.reason": "Ursache",
  "pack.member.conflict": "Konflikt",
  "pack.member.conflictValue": "{lead} führt ebenfalls · Vollmacht {generation}",
  "pack.member.conflictNoWarrant": "{lead} führt ebenfalls · keine Vollmacht",
  "pack.member.version": "Version",
  "pack.member.versionDiffers": "Weicht vom Lead ab",
  "pack.member.address": "Adresse",
  "pack.member.enrolled": "Registriert",
  "pack.member.secretBehind": "Hat das aktuelle Secret noch nicht übernommen.",
  "pack.member.provisional": "Registriert, aber nie erreicht.",
  "pack.health.reachable": "erreichbar",
  "pack.health.unreachable": "nicht erreichbar",
  "pack.health.incompatible": "inkompatibel",
  "pack.health.conflicted": "im Konflikt",
  "pack.role.deputy": "deputy",
  "pack.sheet.goTo": "Zu diesem Rechner",
  "pack.formation.aria": "Pack-Aufstellung: {machines}",
  "pack.node.aria": "{name}, {role}, {health}",
  "pack.node.ariaPlain": "{name}, {health}",
  "pack.solo.title": "Dieser Collie führt kein Pack",
  "pack.solo.description": "Packs werden über die Kommandozeile erstellt und verwaltet.",
  "pack.error.title": "Pack-Status konnte nicht geladen werden",
  "pack.error.description":
    "Die Bridge hat nicht geantwortet. Collie versucht es beim nächsten Abruf erneut.",

  // --- error (boot splash, route-level error recovery) ---
  "error.boot.connecting": "Verbindung zur Herde wird aufgebaut…",
  "error.boot.title": "Keine Verbindung",
  "error.boot.body": "Collie ist nicht erreichbar. Verbindung zum Host prüfen und erneut versuchen.",
  "error.boot.retry": "Erneut versuchen",
  "error.root.title": "Fehler aufgetreten",
  "error.root.unknown": "Unbekannter Fehler",
  "error.root.reload": "Neu laden",

  // --- idle (the idle-pause cover) ---
  "idle.dialogAria": "Collie pausiert",
  "idle.catchingUp.title": "Synchronisierung",
  "idle.catchingUp.body": "Ruft den aktuellen Zustand der Herde ab.",
  "idle.paused.title": "Pausiert",
  "idle.paused.body":
    "Live-Updates wurden während der Inaktivität gestoppt. Die Ansicht im Hintergrund ist eingefroren. Beim Fortsetzen wird der letzte Stand geladen.",
  "idle.resume": "Zum Fortsetzen tippen",

  // --- pwa (self-update banner) ---
  "pwa.updateAvailable": "Neue Version verfügbar. Zum Aktualisieren tippen.",

  // --- history (pane transcript route) ---
  "history.unavailable.disabled": "Transkriptverlauf ist auf dieser Bridge deaktiviert (COLLIE_TRANSCRIPT).",
  "history.unavailable.noSession": "Dieses Pane hat keine Agentensitzung, daher gibt es kein Transkript.",
  "history.unavailable.noLog": "Bisher wurde keine Transkriptdatei für die Sitzung dieses Panes gefunden.",
  "history.unavailable.error": "Transkript konnte nicht gelesen werden. Zurückgehen und erneut versuchen.",
  "history.findAria": "Im Verlauf suchen",
  "history.closeAria": "Verlauf schließen",
  "history.title": "Verlauf",
  "history.loadOlder": "Ältere laden",
  "history.loading": "Wird geladen…",
  "history.startClipped": "Beginn des lesbaren Transkripts (Log am Leselimit abgeschnitten)",
  "history.startOfConversation": "Beginn der Konversation",
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

  // --- dialog (menu / multi-select / wizard / preview-select block renderers) ---
  "dialog.sendingAria": "Wird gesendet",
  "dialog.previousStepAria": "Vorheriger Schritt",
  "dialog.nextStepAria": "Nächster Schritt",
  "dialog.answeredAria": "Beantwortet",
  "dialog.submitChip": "Absenden",
  "dialog.stepPosition.step": "Schritt {index} von {total}, {label}",
  "dialog.stepPosition.submit": "Schritt {index} von {total}, Absenden",
  "dialog.chooseOption": "Option auswählen",
  "dialog.questionsAria": "Fragen",
  "dialog.reviewAnswers": "Antworten überprüfen",
  "dialog.readySubmit": "Antworten jetzt übermitteln.",
  "dialog.incomplete": "Nicht alle Fragen wurden beantwortet.",
  "dialog.submitAnswers": "Antworten absenden",
  "dialog.cancel": "Abbrechen",
  "dialog.endsQuestionsSuffix": "- beendet den Fragenteil",
  "dialog.menu.moveUp": "Nach oben",
  "dialog.menu.moveDown": "Nach unten",
  "dialog.menu.leftAria": "Links: {verb} ({label})",
  "dialog.menu.rightAria": "Rechts: {verb} ({label})",
  "dialog.preview.currentAnswerAria": "Aktuelle Antwort",
  "dialog.preview.previewedBelowAria": "Vorschau unten",
  "dialog.preview.previewLabel": "Vorschau: {label}",
  "dialog.preview.editingBanner": "Notiz wird im Terminal bearbeitet. Bedienelemente sind nach dem Schließen wieder aktiv.",
  "dialog.preview.noteForQuestion": "Notiz zu dieser Frage",
  "dialog.preview.noteTextAria": "Notiztext",
  "dialog.preview.notePlaceholder": "Kontext zur Antwort hinzufügen...",
  "dialog.preview.saveNote": "Notiz speichern",
  "dialog.preview.editNoteAria": "Notiz bearbeiten",
  "dialog.preview.removeNoteAria": "Notiz entfernen",
  "dialog.preview.noteAria": "Notiz",
  "dialog.preview.addNote": "Notiz zur Antwort hinzufügen",

  // --- reply (the free-text reply race guard, lib/reply-action.ts) ---
  "reply.blocked.noBox":
    "Das Eingabefeld des Agenten ist nicht sichtbar. Vermutlich ist ein Menü oder Dialog geöffnet. Es wurde nichts eingegeben.",
  "reply.blocked.noEcho":
    "Dies ist eine Passwortabfrage. Da keine Zeichenausgabe erfolgt, kann das Senden den Empfang nicht bestätigen. Es wurde nichts eingegeben.",
  "reply.blocked.composerLeft":
    "Das Eingabefeld des Agenten wurde während des Löschens der Zeile geschlossen. Vermutlich ist ein Menü oder Dialog aktiv. Die Nachricht wurde nicht eingegeben.",
  "reply.stalled.noEcho":
    "Dies ist eine Passwortabfrage ohne Zeichenecho. Der Text konnte nicht bestätigt und daher nicht übermittelt werden. Die Eingabe steht bereits im Pane.",
  "reply.stalled.generic":
    "Die Nachricht hat das Eingabefeld nicht erreicht. Vermutlich wartet ein Dialog. Einzelne Tastendrücke zur Bestätigung wurden eventuell verarbeitet. Es wurde nichts gesendet.",

  // --- previewAction (the preview-select dialog's note flow, lib/preview-action.ts) ---
  "previewAction.note.notOpened": "Notizfeld konnte nicht geöffnet werden. Pane prüfen.",
  "previewAction.note.clearFailed": "Bestehende Notiz konnte nicht gelöscht werden. Pane prüfen.",
  "previewAction.note.textFailed": "Notiztext wurde nicht übertragen. Pane prüfen.",
  "previewAction.note.closeFailed": "Notizfeld konnte nicht geschlossen werden. Pane prüfen.",

  // --- promptAction (the plan-feedback flow, lib/prompt-action.ts) ---
  "promptAction.feedback.freeTextUnsupported":
    "Das Freitextfeld dieses Dialogs unterstützt keine Eingabe über Mobilgeräte.",
  "promptAction.feedback.empty": "Keine Daten zum Senden.",
  "promptAction.feedback.boxNotOpened": "Das Feedback-Feld hat sich nicht geöffnet. Pane prüfen.",
  "promptAction.feedback.notArrived": "Das Feedback ist nicht angekommen. Es wurde nichts gesendet.",

  // --- stt (speech-to-text errors, lib/stt.ts + hooks/use-stt-recorder.ts) ---
  "stt.error.busy": "Eine andere Transkription läuft noch. Bitte kurz warten und erneut versuchen.",
  "stt.error.tooLong": "Die Aufnahme ist zu lang. Bitte eine kürzere Aufnahme erstellen.",
  "stt.error.badFormat":
    "Der Browser hat ein Audioformat erzeugt, das Collie nicht verarbeiten kann.",
  "stt.error.unconfigured": "Spracherkennung ist auf dieser Collie-Instanz nicht konfiguriert.",
  "stt.error.timeout": "Zeitüberschreitung beim Transkriptionsdienst. Bitte erneut versuchen.",
  "stt.error.unreachable": "Der Transkriptionsdienst ist nicht erreichbar. Bitte erneut versuchen.",
  "stt.error.generic": "Die Transkription ist fehlgeschlagen. Bitte erneut aufnehmen.",
  "stt.error.networkFailure":
    "Collie ist für die Transkription nicht erreichbar. Bitte erneut versuchen.",
  "stt.error.recordingFailed": "Die Aufnahme ist fehlgeschlagen. Es wurden keine Audiodaten erfasst.",
  "stt.error.noSpeechHeard": "In der Aufnahme wurde keine Sprache erkannt.",
  "stt.error.nothingRecorded": "Es wurden keine Audiodaten aufgenommen.",
  "stt.error.unsupportedBrowser": "Dieser Browser unterstützt keine Audioaufnahme.",
  "stt.error.micRefused": "Der Zugriff auf das Mikrofon wurde verweigert.",

  // --- directTyping (the composer's "Type into terminal" mode, hooks/use-direct-typing.ts) ---
  "directTyping.status.draftPending":
    "Entwurf vor der Eingabe ins Terminal senden oder verwerfen.",
  "directTyping.status.armed": "Direkteingabe im Terminal aktiv. Tastenanschläge werden direkt gesendet.",
  "directTyping.status.disarmed": "Zurück zur regulären Eingabe von Antworten.",
  "directTyping.status.interrupted":
    "Direkteingabe im Terminal beendet, da die Pane-Ansicht unterbrochen wurde.",
  "directTyping.status.backgrounded":
    "Direkteingabe im Terminal beendet, da die App in den Hintergrund wechselte.",

  // --- apiError (the bridge's refusals, keyed by the code on the wire) ---
  "apiError.unknown": "Ein Fehler ist aufgetreten. Bitte erneut versuchen.",
  "apiError.reply.not_submitted":
    "Nachricht wurde in das Pane eingefügt, aber nicht gesendet. Bitte Pane vor erneutem Senden prüfen.",
  "apiError.reply.send_failed": "Nachricht konnte nicht gesendet werden: {reason}",
  "apiError.keys.send_failed": "Tasteneingaben konnten nicht gesendet werden: {reason}",
  "apiError.prompt_changed":
    "Terminalinhalt hat sich vor dem Senden geändert. Bitte Pane prüfen.",
  "apiError.prompt.read_failed":
    "Pane konnte vor dem Senden nicht gelesen werden. {mux} meldet: {detail}",
  "apiError.pane.close_failed": "Pane konnte nicht geschlossen werden: {reason}",
  "apiError.pane.rename_failed": "Pane konnte nicht umbenannt werden: {reason}",
  "apiError.pane.focus_failed": "Pane konnte im Terminal nicht fokussiert werden: {reason}",
  "apiError.tab.create_failed": "Tab konnte nicht erstellt werden: {reason}",
  "apiError.tab.rename_failed": "Tab konnte nicht umbenannt werden: {reason}",
  "apiError.tab.close_failed": "Tab konnte nicht geschlossen werden: {reason}",
  "apiError.tab.workspace_required": "Für den neuen Tab wurde kein Space angegeben.",
  "apiError.workspace.create_failed": "Space konnte nicht erstellt werden: {reason}",
  "apiError.upload.too_large": "Bilddatei ist zu groß. Das Limit liegt bei 10 MB.",
  "apiError.upload.no_file": "Es wurde keine Datei übermittelt.",
  "apiError.upload.bad_type": "Collie unterstützt diesen Dateityp nicht: {type}",
  "apiError.upload.write_failed":
    "Bild konnte auf dem Host nicht gespeichert werden: {reason}",
  "apiError.stt.unconfigured": "Spracherkennung ist auf dieser collie-Instanz nicht eingerichtet.",
  "apiError.stt.too_large": "Aufnahme ist zu lang. Bitte eine kürzere Aufnahme wählen.",
  "apiError.stt.bad_format":
    "Audioformat des Browsers wird von Collie nicht unterstützt.",
  "apiError.stt.busy":
    "Zwei Aufnahmen werden bereits verarbeitet. Bitte gleich erneut versuchen.",
  "apiError.stt.unreadable": "Aufnahme konnte nicht gelesen werden.",
  "apiError.stt.empty": "Aufnahme enthält keine Audiodaten.",
  "apiError.stt.provider_failed": "Transkription fehlgeschlagen: {reason}",
  "apiError.pairing.bad_request":
    "Code oder Name ungültig. Namen müssen 1 bis 48 Zeichen lang sein.",
  "apiError.pairing.no_pending": "Kein ausstehender Kopplungscode auf dem Host vorhanden.",
  "apiError.pairing.expired": "Dieser Kopplungscode ist abgelaufen.",
  "apiError.pairing.exhausted": "Zu viele Fehlversuche. Der Kopplungsvorgang wurde abgebrochen.",
  "apiError.pairing.bad_code": "Ungültiger Kopplungscode.",
  "apiError.pairing.duplicate_label": "Ein Gerät mit diesem Namen existiert bereits.",
  "apiError.device.unknown": "Kein gekoppeltes Gerät mit diesem Namen vorhanden.",
  "apiError.session.unknown": "Keine Sitzung namens {session} auf diesem collie vorhanden.",
  "apiError.host.unknown": "Kein collie namens {host} in diesem pack vorhanden.",
  "apiError.pack.not_lead": "Dieser collie führt kein pack. Es gibt kein pack anzuzeigen.",
  // --- worktrees (ADR 0032) ---
  "apiError.worktree.list_failed": "Worktrees konnten nicht aufgelistet werden: {reason}",
  "apiError.worktree.create_failed": "Worktree konnte nicht erstellt werden: {reason}",
  "apiError.worktree.created_not_opened": "Branch wurde erstellt, konnte jedoch nicht geöffnet werden: {reason}",
  "apiError.worktree.open_failed": "Worktree konnte nicht geöffnet werden: {reason}",
  "apiError.worktree.busy": "Ein anderer Worktree-Vorgang läuft noch. Bitte kurz warten.",
  "apiError.worktree.ambiguous_branch": "Branch-Name ist mehrdeutig: {reason}",
  "apiError.worktree.branch_required": "Bitte zuerst einen Branch-Namen angeben.",
  "apiError.worktree.not_a_repo": "Dieser Space liegt in keinem Git-Repository.",
  "worktree.section": "Worktrees",
  "worktree.new": "Neuer Worktree",
  "worktree.branchLabel": "Branch-Name",
  "worktree.branchPlaceholder": "feature/meine-aenderung",
  "worktree.branchesFrom": "Basiert auf {branch}",
  "worktree.create": "Erstellen",
  "worktree.creating": "Wird erstellt…",
  "worktree.open": "Öffnen",
  "worktree.opening": "Wird geöffnet…",
  "worktree.mainCheckout": "Haupt-Repository",
  "worktree.empty": "Keine Worktrees vorhanden.",
  "worktree.detached": "losgelöst",
  "worktree.recoverOpen": "Erstellten Branch öffnen",
  "space.new.tab.plain": "Space",
  "space.new.tab.worktree": "Worktree",
  "space.new.repo.label": "Repository",
  "worktree.orOpenExisting": "Oder bestehenden öffnen",
};
