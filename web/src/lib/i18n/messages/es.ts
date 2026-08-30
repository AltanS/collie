import type { Dictionary } from "./en";

// Spanish. See de.ts for the typing contract.

export const es: Dictionary = {
  "settings.language.title": "Idioma",
  "settings.language.description": "El espejo de la terminal nunca se traduce.",

  // --- settings (page chrome) ---
  "settings.title": "Ajustes",
  "settings.nav.back": "Atrás",

  // --- settings.theme ---
  "settings.theme.title": "Apariencia",
  "settings.theme.description": "Seguir al teléfono o fijar un tema.",
  "settings.theme.option.system": "Sistema",
  "settings.theme.option.light": "Claro",
  "settings.theme.option.dark": "Oscuro",

  // --- settings.haptics ---
  "settings.haptics.title": "Vibración",
  "settings.haptics.description": "Un zumbido corto al pulsar una tecla o una respuesta rápida.",


  // --- settings.handsFree ---
  "settings.handsFree.title": "Voz manos libres",
  "settings.handsFree.description":
    "Enviar la transcripción de inmediato en vez de ponerla en el cuadro de mensaje. Desactivado por defecto — normalmente lees lo que se entendió antes de que llegue al terminal.",
  "settings.handsFree.ariaLabel": "Voz manos libres: enviar transcripción de inmediato",

  // --- settings.push ---
  "settings.push.title": "Notificaciones push",
  "settings.push.description": "Recibe una notificación cuando un agente necesite tu atención.",
  "settings.push.reason.insecure": "Push necesita una conexión HTTPS.",
  "settings.push.reason.serverOff": "Push no está configurado en el bridge (sin claves VAPID).",
  "settings.push.reason.denied":
    "Las notificaciones están bloqueadas — actívalas en los ajustes del navegador.",
  "settings.push.reason.unsupported": "Este navegador no admite notificaciones push.",
  "settings.push.reason.default": "No se pudieron activar las notificaciones push.",
  "settings.push.availability.insecure":
    "No disponible por HTTP plano — sirve Collie por HTTPS para activar push.",
  "settings.push.availability.serverOff":
    "El bridge no tiene claves VAPID configuradas, así que push está desactivado del lado del servidor.",
  "settings.push.availability.denied":
    "Las notificaciones están bloqueadas para este sitio. Actívalas de nuevo en los ajustes del navegador.",
  "settings.push.availability.unsupported": "Este navegador no admite notificaciones push.",

  // --- settings.notify ---
  "settings.notify.title": "Notificar cuando",
  "settings.notify.description": "Se aplica a todos los dispositivos.",
  "settings.notify.blocked.label": "Necesita respuesta",
  "settings.notify.blocked.hint": "un agente está esperando tu respuesta",
  "settings.notify.done.label": "Terminado",
  "settings.notify.done.hint": "un agente completa su tarea",
  "settings.notify.updates.label": "Actualizaciones",
  "settings.notify.updates.hint": "hay una nueva versión de Collie disponible",

  // --- settings.snooze ---
  "settings.snooze.title": "No molestar",
  "settings.snooze.description.idle": "Pausar todas las notificaciones push por un rato.",
  "settings.snooze.description.active": "Pausado hasta {time} — sin pushes hasta entonces.",
  "settings.snooze.resume": "Reanudar ahora",
  "settings.snooze.preset.min30": "30m",
  "settings.snooze.preset.hour1": "1h",
  "settings.snooze.preset.hour4": "4h",

  // --- settings.devices ---
  "settings.devices.title": "Dispositivos vinculados",
  "settings.devices.description.enforced":
    "Toda escritura necesita un dispositivo vinculado. La lectura sigue abierta.",
  "settings.devices.description.open":
    "Nada está vinculado, así que las escrituras no están protegidas. Vincula un dispositivo para exigir una credencial.",
  "settings.devices.pairedAs": "Este dispositivo está vinculado como {device}.",
  "settings.devices.loadError": "No se pudieron cargar los dispositivos vinculados desde el bridge.",
  "settings.devices.thisDevice": "Este dispositivo",
  "settings.devices.row.meta": "Vinculado {paired} · visto por última vez {lastSeen}",
  "settings.devices.revokeError": "No se pudo revocar ese dispositivo.",
  "settings.devices.cancel": "Cancelar",
  "settings.devices.unpairSelf": "Desvincular este teléfono",
  "settings.devices.revoke": "Revocar",
  "settings.devices.revokeAria": "Revocar {label}",
  "settings.devices.pair.title": "Vincular este dispositivo",
  "settings.devices.pair.hint":
    "Ejecuta {command} en el host y escribe el código que muestra.",
  "settings.devices.pair.codeLabel": "Código de vinculación",
  "settings.devices.pair.codePlaceholder": "8 caracteres",
  "settings.devices.pair.nameLabel": "Nombre para este dispositivo",
  "settings.devices.pair.namePlaceholder": "p. ej. mi teléfono",
  "settings.devices.pair.networkError":
    "No se pudo conectar con el bridge para vincular. Revisa la conexión e inténtalo de nuevo.",
  "settings.devices.pair.failure.noPending":
    "No hay ningún código de vinculación pendiente. Ejecuta `bin/collie pair` en el host para generar uno.",
  "settings.devices.pair.failure.expired":
    "Ese código ha expirado. Ejecuta `bin/collie pair` en el host para uno nuevo.",
  "settings.devices.pair.failure.exhausted":
    "Demasiados códigos incorrectos, esa vinculación fue destruida. Ejecuta `bin/collie pair` en el host para generar una nueva.",
  "settings.devices.pair.failure.badCode":
    "Ese código no coincide. Revísalo e inténtalo de nuevo — unos intentos más fallidos y se destruirá.",
  "settings.devices.pair.failure.duplicateLabel":
    "Otro dispositivo ya usa ese nombre. Elige uno diferente — el código sigue siendo válido.",
  "settings.devices.pair.failure.badRequest":
    "El código o el nombre no eran válidos. Un nombre tiene entre 1 y 48 caracteres.",

  // --- settings.connection ---
  "settings.connection.title": "Conexión",
  "settings.connection.description": "Diagnóstico de este dispositivo.",
  "settings.connection.row.endpoint": "Punto de conexión",
  "settings.connection.row.secure": "Contexto seguro",
  "settings.connection.row.bridge": "Bridge",
  "settings.connection.row.deviceAccess": "Acceso del dispositivo",
  "settings.connection.row.serverBuild": "Build del servidor",
  "settings.connection.secure.yes": "Sí",
  "settings.connection.secure.no": "No (HTTP plano)",
  "settings.connection.bridge.connected": "Conectado",
  "settings.connection.bridge.offline": "Herdr sin conexión",
  "settings.connection.bridge.connecting": "Conectando…",
  "settings.connection.device.notEnforced": "No aplicado",
  "settings.connection.device.fullAccessNamed": "Acceso total · {device}",
  "settings.connection.device.fullAccessLocal": "Acceso total (local)",
  "settings.connection.device.readOnlyNamed": "Solo lectura · {device}",
  "settings.connection.device.readOnly": "Solo lectura",

  // --- settings.update (update-check-control + footer update banner) ---
  "settings.update.title": "Actualizaciones",
  "settings.update.check.prompt": "Comprueba si hay una nueva versión de Collie disponible.",
  "settings.update.check.running": "Ejecutando v{current}",
  "settings.update.check.runningChecked": "Ejecutando v{current} · comprobado {checked}",
  "settings.update.action": "Buscar actualizaciones",
  "settings.update.checking": "Comprobando…",
  "settings.update.error": "No se pudo comprobar.",
  "settings.update.upToDate": "Actualizado",
  "settings.updateBanner.restart": "Reinicio del bridge necesario",
  "settings.updateBanner.releaseAvailable": "Collie {version} disponible",
  "settings.updateBanner.majorAvailable": "Collie {version} — una nueva versión mayor",
  "settings.updateBanner.copyAria": "Copiar comando: {command}",

  // --- settings.fonts ---
  "settings.fonts.title": "Fuente de la terminal",
  "settings.fonts.description": "Solo el espejo de la terminal, en este dispositivo.",
  "settings.fonts.family": "Familia",
  "settings.fonts.size": "Tamaño",
  "settings.fonts.system": "Predeterminada del sistema",

  // --- settings.display (mirror display prefs, behind the composer's ⚙ dock) ---
  "settings.display.wrap.label": "Ajuste de línea",
  "settings.display.wrap.hint":
    "Desactivado muestra salida fiel a las columnas para tablas TUI — te desplazas en su lugar.",
  "settings.display.tapToType.label": "Tocar para escribir",
  "settings.display.tapToType.hint":
    "Activado, tocar el espejo en cualquier parte abre el teclado. Desactivado, el espejo se comporta como un documento — los toques caen sobre el texto y solo el compositor abre el teclado.",
  "settings.display.rawTerminal.label": "Terminal en bruto",
  "settings.display.rawTerminal.hint":
    "Muestra el espejo puro — sin botones de aviso tocables, sin marco ni barras de estado. Úsalo cuando un diálogo se muestre mal y quieras manejarlo a mano desde Teclas.",
  "settings.display.textSize.label": "Tamaño del texto",
  "settings.display.textSize.decrease": "Reducir tamaño de fuente",
  "settings.display.textSize.increase": "Aumentar tamaño de fuente",

  // --- settings.buildStamp ---
  "settings.buildStamp.tapToUpdate": "nuevo build — toca para actualizar",
  "settings.buildStamp.updating": "actualizando…",

  // --- composer (the reply box + its Keys/Quick/Display docks) ---
  "composer.dock.closeAria": "Cerrar {title}",
  "composer.controls.label": "Controles",
  "composer.controls.keys": "Teclas",
  "composer.controls.typeAria": "Escribir en la terminal",
  "composer.controls.type": "Escribir",
  "composer.controls.quick": "Rápido",
  "composer.controls.agent": "Agente",
  "composer.controls.displayAria": "Ajustes de pantalla",
  "composer.controls.display": "Pantalla",
  "composer.sentPreview.label": "Enviaste:",
  "composer.placeholder.gone": "El panel ya no existe",
  "composer.placeholder.readOnly": "Solo lectura — dispositivo no autorizado",
  "composer.placeholder.noMuxSend": "No se puede escribir en esta terminal desde aquí",
  "composer.placeholder.direct": "Escribe en la terminal…",
  "composer.placeholder.shell": "Escribe un comando de shell…",
  "composer.placeholder.reply": "Escribe una respuesta…",
  "composer.mic.unavailable": "La entrada de voz no está disponible",
  "composer.mic.stopAria": "Detener grabación",
  "composer.mic.recordAria": "Grabar un mensaje de voz",
  "composer.mic.transcribing": "Transcribiendo…",
  "composer.mic.recording": "Grabando {elapsed}",
  "composer.mic.handsFreeHint": "se enviará cuando te detengas",
  "composer.mic.manualHint": "queda en el cuadro de mensaje",
  "composer.mic.stop": "Detener",
  "composer.mic.discardAria": "Descartar grabación",
  "composer.attach.aria": "Adjuntar imagen",
  "composer.send.typeAnyway": "¿Escribir igual?",
  "composer.send.reallySend": "¿Enviar de verdad?",
  "composer.send.stopTypingAria": "Dejar de escribir en la terminal",
  "composer.send.sendAria": "Enviar",
  "composer.draft.tooLong":
    "Demasiado largo para guardar como borrador — sobrevive al cambiar de panel, pero no al cerrar la app.",
  "composer.status.dialogWaiting": "Un diálogo espera respuesta — respóndelo primero y luego envía.",
  "composer.status.paneNotWritable": "El panel ya no admite escritura — no se envió nada",
  "composer.status.inputChanged":
    "El cuadro de entrada cambió mientras se limpiaba — no se escribió nada. Revisa el panel.",
  "composer.status.clearFailed": "No se pudo limpiar la entrada de la terminal",
  "composer.status.sent": "Enviado ✓",
  "composer.status.tapAgainToType": "{error} Toca Enviar de nuevo para escribir igual.",
  "composer.discard.confirmKeys.one": "Toca de nuevo para descartar {count} tecla en espera",
  "composer.discard.confirmKeys.other": "Toca de nuevo para descartar {count} teclas en espera",
  "composer.destructive.confirm": "Destructivo: {reason} — toca Enviar de nuevo para confirmar",
  "composer.destructive.confirmOnHost":
    "Destructivo: {reason} en {host} — toca Enviar de nuevo para confirmar",
  "composer.upload.success": "Imagen añadida — la ruta está en el mensaje",
  "composer.noEcho.title": "Solicitud de contraseña — no hay eco",
  "composer.noEcho.noLiveTyped":
    "Lo que escribiste ya está en el panel, sin enviar — pero esta vista no está en vivo, así que no se puede enviar nada desde aquí. Respóndelo en la terminal.",
  "composer.noEcho.noLiveUntyped":
    "No se escribió nada. Esta vista no está en vivo, así que las teclas que funcionarían no se pueden enviar desde aquí.",
  "composer.noEcho.liveTyped":
    "Lo que escribiste ya está en el panel — solo que no se puede confirmar, así que no se envió. Presiona Enter en Escribir y no lo reenvíes.",
  "composer.noEcho.liveUntyped":
    "Enviar confirma lo que escribió, y esta solicitud no muestra nada que confirmar. Escribir manda tus teclas directo, Enter incluido.",
  "composer.noEcho.useType": "Usar Escribir",
  "composer.noEcho.dismissAria": "Descartar aviso de contraseña",
  "composer.draftPreview.title": "Borrador en la terminal",
  "composer.draftPreview.takeOver": "Retomar",

  // --- sendMode (the armed "typing straight through" indicator) ---
  "sendMode.armed.title": "Escribiendo en la terminal",
  "sendMode.armed.hint": "las teclas van directo",
  "sendMode.armed.stop": "Detener",

  // --- chat (the pane view shell: header, mirror, switcher) ---
  "chat.find.label": "Buscar en la salida",
  "chat.history.label": "Historial de conversación",
  "chat.paneMenu.aria": "Acciones del panel",
  "chat.header.openOverviewAria": "Abrir resumen de {workspace}{status}",
  "chat.header.statusAria": " — {label}",
  "chat.header.agentGone": "(agente ausente)",
  "chat.scrollback.showHistory": "Ver historial completo",
  "chat.scrollback.loadOlder": "Cargar más antiguos",
  "chat.scrollback.loading": "Cargando…",
  "chat.scrollback.noSessionReported":
    "{agent} no ha informado ninguna sesión a Herdr. Instala o actualiza la integración de Herdr para él y reinicia el agente en este panel.",
  "chat.output.empty": "(sin salida reciente)",
  "chat.switcher.aria": "Cambiar de panel",
  "chat.switcher.title": "Cambiar de panel",
  "chat.status.feedbackSent": "Comentario enviado",
  "chat.status.sent": "Enviado",
  "chat.status.menuChanged": "El menú cambió — actualizando",
  "chat.status.sendFailed": "Error al enviar",
  "chat.status.wizardChanged": "El asistente cambió — actualizando",
  "chat.status.noteSaved": "Nota guardada",
  "chat.status.noteRemoved": "Nota eliminada",
  "chat.status.dialogChanged": "El diálogo cambió — actualizando",
  "chat.status.selectionChanged": "La selección cambió — actualizando",
  "chat.status.screenChanged": "La pantalla cambió — actualizando",
  "chat.status.readOnly": "Solo lectura — dispositivo no autorizado",

  // --- prompt (the native prompt-select / plan-feedback block) ---
  "prompt.family.select": "Elige una opción",
  "prompt.family.permission": "Se requiere permiso",
  "prompt.family.trust": "¿Confiar en esta carpeta?",
  "prompt.family.plan": "Revisar el plan",
  "prompt.sendingAria": "Enviando",
  "prompt.feedback.cancel": "Cancelar",
  "prompt.feedback.typedAria": "Comentario en la terminal",
  "prompt.feedback.planChange.offer": "Decirle a Claude qué cambiar",
  "prompt.feedback.planChange.editorLabel": "¿Qué debería cambiar Claude?",
  "prompt.feedback.planChange.textAria": "Texto de comentarios",
  "prompt.feedback.planChange.placeholder": "Di qué hacer distinto…",
  "prompt.feedback.planChange.help":
    "Devuelve el plan con tus notas — Claude sigue planificando en vez de empezar a trabajar.",
  "prompt.feedback.planChange.send": "Enviar comentario",
  "prompt.feedback.planChange.sending": "Enviando comentario…",
  "prompt.feedback.planChange.focused":
    "El cuadro de comentarios tiene el teclado en la terminal — estos botones escribirían ahí en vez de responder. Vuelven a funcionar cuando se cierra.",
  "prompt.feedback.planChange.typedPrefix": "Se está escribiendo un comentario en la terminal: ",
  "prompt.feedback.freeText.focused":
    "La fila de texto libre tiene el teclado en la terminal — estos botones escribirían ahí en vez de responder. Vuelven a funcionar cuando se cierra.",
  "prompt.feedback.freeText.typedPrefix":
    "Se está escribiendo una respuesta personalizada en la terminal: ",

  // --- paneActions (long-press sheet: rename / close a pane) ---
  "paneActions.title.fallback": "Panel",
  "paneActions.readOnly": "Solo lectura — este dispositivo no puede renombrar ni cerrar paneles.",
  "paneActions.hostBlockSuffix": "{hostBlock} — renombrar y cerrar no están disponibles hasta que responda.",
  "paneActions.rename.label": "Renombrar",
  "paneActions.rename.placeholder": "nombra este panel",
  "paneActions.close.label": "Cerrar panel",
  "paneActions.close.confirm": "Toca de nuevo para cerrar",
  "paneActions.close.closing": "Cerrando…",
  // TODO(translation): English changed from "Show in terminal" to "Focus in {mux}" — needs a
  // translator's call on the verb ("focus") and where a multiplexer name sits in a Spanish
  // sentence. Kept the old "show" wording for now rather than guess; `{mux}` is unused here.
  "paneActions.focus.labelWithMux": "Mostrar en la terminal",
  "paneActions.focus.labelFallback": "Mostrar en la terminal",
  "paneActions.focus.done": "Mostrado en la terminal",
  "paneActions.focus.failed": "No se pudo mostrar en la terminal",
  "paneActions.empty.fallback": "Este multiplexor no ofrece acciones para un panel.",
  "paneActions.status.renamed": "Renombrado",
  "paneActions.status.labelCleared": "Etiqueta borrada",
  "paneActions.status.renameFailed": "Error al renombrar",
  "paneActions.status.closeFailed": "Error al cerrar",

  // --- keys (the inline Keys tray + its staging strip) ---
  "keys.tab.keys": "Teclas",
  "keys.presets.label": "Preajustes",
  "keys.fkeys.label": "Teclas F",
  "keys.confirm.label": "¿Confirmar?",
  "keys.queue.removeAria": "Quitar {label}",
  "keys.queue.charPlaceholder": "tecla",
  "keys.queue.charAria": "Escribe una tecla para combinar",
  "keys.queue.send": "Enviar",
  "keys.queue.clearAria": "Borrar teclas en espera",

  // --- nav (app header, Collie mark, settings gear) ---
  "nav.settings.aria": "Ajustes",
  "nav.home.aria.default": "Inicio de Collie",
  "nav.home.aria.lost": "Inicio de Collie — sin conexión",
  "nav.home.aria.reconnecting": "Inicio de Collie — reconectando",
  "nav.mux.onPrefix": "en",
  "nav.prereleaseTitle": "Compilación preliminar — {version}",

  // --- home (dashboard herd list) ---
  "home.empty.disconnected": "Desconectado",
  "home.empty.disconnectedAt": "Desconectado — visto por última vez {time}",
  "home.empty.noAgents": "No hay agentes activos.",
  "home.empty.waiting": "Esperando a Herdr…",
  "home.empty.panesHint": "Tus paneles están en Espacios.",
  "home.allClear": "Nada te necesita",
  "home.sort.newest": "Más reciente",
  "home.sort.oldest": "Más antiguo",
  "home.sort.aria.newest": "Ordenado por uso reciente — cambiar a más antiguo primero",
  "home.sort.aria.oldest": "Ordenado por más antiguo primero — cambiar a uso reciente",
  "home.sidebar.shells": "Shells",
  "home.sidebar.paneActionsTitle": "Toca para ver acciones del panel",

  // --- status (triage sections, status labels, counts) ---
  "status.section.needsYou": "Te necesita",
  "status.section.readyUnseen": "Listo · sin ver",
  "status.section.working": "En curso",
  "status.section.recent": "Reciente",
  "status.label.blocked": "te necesita",
  "status.label.working": "en curso",
  "status.label.idle": "inactivo",
  "status.label.done": "listo",
  "status.label.unknown": "desconocido",
  "status.count.needsYou.one": "{count} te necesita",
  "status.count.needsYou.other": "{count} te necesitan",
  "status.count.working.one": "{count} en curso",
  "status.count.working.other": "{count} en curso",
  "status.shellBadge": "shell",
  "status.dismissAria": "Descartar",

  // --- space (spaces overview/strip/view, tabs, panes, new-space) ---
  "space.overview.title": "Espacios",
  "space.overview.new.aria": "Nuevo espacio",
  "space.overview.filter.placeholder": "Filtrar espacios…",
  "space.overview.filter.aria": "Filtrar espacios",
  "space.overview.empty.none": "Aún no hay espacios.",
  "space.overview.empty.noMatch": "Ningún espacio coincide con “{query}”.",
  "space.overview.needsYou.one": "{count} espacio te necesita",
  "space.overview.needsYou.other": "{count} espacios te necesitan",
  "space.overview.paneCount.one": "{count} panel",
  "space.overview.paneCount.other": "{count} paneles",
  "space.strip.back": "Atrás",
  "space.strip.title": "Espacios",
  "space.strip.all": "Todos",
  "space.view.tabCount.one": "{count} pestaña",
  "space.view.tabCount.other": "{count} pestañas",
  "space.view.paneCount.one": "{count} panel",
  "space.view.paneCount.other": "{count} paneles",
  "space.view.emptyTab": "(pestaña vacía)",
  "space.view.noPanesInTab": "Esta pestaña no tiene paneles.",
  "space.view.noPanesInSpace": "Este espacio no tiene paneles.",
  "space.tabStrip.title": "Pestañas",
  "space.tabStrip.all": "Todas",
  "space.tabStrip.new.aria": "Nueva pestaña",
  "space.paneStrip.title": "Paneles",
  "space.new.title": "Nuevo espacio",
  "space.new.dir.label": "Directorio (opcional)",
  "space.new.dir.placeholder": "~ (directorio de inicio)",
  "space.new.label.label": "Etiqueta (opcional)",
  "space.new.label.placeholder": "nombra este espacio",
  "space.new.create": "Crear espacio y abrir shell",
  "space.tab.titleFallback": "Pestaña",
  "space.tab.titleWithLabel": "Pestaña {label}",
  "space.tab.readOnly": "Solo lectura — este dispositivo no puede renombrar ni cerrar pestañas.",
  "space.tab.hostBlockSuffix": "{hostBlock} — renombrar y cerrar no estarán disponibles hasta que responda.",
  "space.tab.rename": "Renombrar",
  "space.tab.close": "Cerrar pestaña",
  "space.tab.closing": "Cerrando…",
  "space.tab.closeConfirm.one": "Toca de nuevo para cerrar {count} panel",
  "space.tab.closeConfirm.other": "Toca de nuevo para cerrar {count} paneles",
  "space.tab.closeConfirmPlain": "Toca de nuevo para cerrar",
  "space.tab.empty.fallback": "Este multiplexor no ofrece acciones para una pestaña.",
  "space.tab.placeholder": "nombra esta pestaña",
  "space.tab.renamed": "Renombrada",
  "space.tab.renameFailed": "Error al renombrar",
  "space.tab.closeFailed": "Error al cerrar",
  "space.readOnly.notPaired": "Sin vincular — vincula este dispositivo en Ajustes",
  "space.readOnly.deviceUnauthorised": "Solo lectura — dispositivo no autorizado",
  "space.create.ready": "Nuevo: {what} — inicia tu agente",
  "space.noun.tab": "pestaña",
  "space.noun.space": "espacio",

  // --- actionSheet (shared rename/back/save rows behind pane + tab long-press sheets) ---
  "actionSheet.back": "Atrás",
  "actionSheet.label": "Etiqueta",
  "actionSheet.save": "Guardar",

  // --- commands (agent command palette) ---
  "commands.title": "Comandos del agente",
  "commands.search.placeholder": "Buscar entre {count} comandos…",
  "commands.common.hint": "Comunes · escribe para buscar los {count}",
  "commands.empty": "Ningún comando coincide con “{query}”.",
  "commands.confirm": "¿Confirmar?",

  // --- quickActions (one-tap reply dock) ---
  "quickActions.group.confirm": "confirmar",
  "quickActions.group.common": "comunes",

  // --- find (the in-mirror / in-history find bar) ---
  "find.placeholder": "Buscar en {subject}…",
  "find.aria": "Buscar en {subject}",
  "find.prevAria": "Coincidencia anterior",
  "find.nextAria": "Siguiente coincidencia",
  "find.closeAria": "Cerrar búsqueda",
  "find.subject.output": "la salida",
  "find.subject.history": "el historial",

  // --- connection (banner, read-only strip, host chip/stale banner, session/server switchers) ---
  "connection.auth.message": "Acceso denegado. Esto no es un problema de conexión.",
  "connection.auth.signIn": "Iniciar sesión",
  "connection.reload.aria": "Recargar",
  "connection.retry": "Reintentar",
  "common.closeAria": "Cerrar",
  "common.scrollToLatestAria": "Ir a lo más reciente",
  "connection.connected": "Conectado",
  "connection.reconnecting": "Reconectando…",
  "connection.herdrDown": "Herdr está caído en el host",
  "connection.offlineCantReach": "Sin conexión — no se puede alcanzar Collie",
  "connection.cantReach": "No se puede alcanzar Collie",
  "connection.withLastSeen": "{cause} — visto por última vez {time}",
  "connection.readOnly.notPaired": "Sin vincular — vincula este dispositivo en Ajustes para escribir a los agentes.",
  "connection.readOnly.device": "Solo lectura — este dispositivo no puede escribir a los agentes{deviceSuffix}.",
  "connection.host.lastSeen": "visto por última vez {time}",
  "connection.host.neverSeen": "nunca visto",
  "connection.host.unreachablePlain": "inaccesible",
  "connection.host.unreachableSuffix": "inaccesible · {label}",
  "connection.host.incompatible": "incompatible",
  "connection.host.lead": "lead",
  "connection.host.onPrefix": "en",
  "connection.host.ariaSends": "Envía al host: {name}{unreachable}",
  "connection.host.ariaHost": "Host: {name}{unreachable}",
  "connection.host.ariaUnreachableSuffix": " (inaccesible)",
  "connection.stale.incompatible": "{name} está usando una versión incompatible de Collie",
  "connection.stale.unreachable": "{name} está inaccesible · {label}",
  "connection.stale.nothingCached": "Aún no hay nada guardado para esta máquina.",
  "connection.stale.showingLastKnown":
    "Mostrando la última pantalla conocida — respuestas y teclas se rechazan hasta que responda.",
  "connection.stale.waitingFirst": "Aún nada de {name} — esperando su primera respuesta.",
  "connection.stale.messageTemplate": "{reason}. {detail}",
  "connection.session.title": "Sesiones",
  "connection.session.aria": "Sesión: {name}. Cambiar sesión",
  "connection.session.primary": "principal",
  "connection.session.unreachable": "inaccesible",
  "connection.session.ariaIn": "En la sesión: {name}",
  "connection.session.all": "Todas las sesiones",
  "connection.session.allDescription": "Todas las sesiones de esta máquina, en una lista",
  "connection.session.allAria": "Mostrando todas las sesiones. Cambiar sesión",
  "connection.server.title": "Máquinas",
  "connection.server.aria": "Host: {name}. Cambiar host",

  // --- pack ---
  "pack.title": "Pack",
  "pack.nav.back": "Atrás",
  "pack.entry.title": "Resumen del pack",
  "pack.entry.description": "Cómo está cada máquina del pack.",
  "pack.footer.label": "Pack · {machines} · {reachable}",
  "pack.footer.aria": "Abrir el resumen del pack",
  "pack.summary.counts": "{machines} · {reachable}",
  "pack.summary.machines.one": "{count} máquina",
  "pack.summary.machines.other": "{count} máquinas",
  "pack.summary.reachable": "{count} accesibles",
  "pack.summary.deputy": "Deputy",
  "pack.summary.noDeputy": "sin deputy designado",
  "pack.summary.warrant": "mandato {generation}",
  "pack.summary.secret": "Secreto",
  "pack.summary.secretValue": "generación {generation} · rotado {time}",
  "pack.member.health": "Estado",
  "pack.member.reason": "Motivo",
  "pack.member.conflict": "Conflicto",
  "pack.member.conflictValue": "{lead} también lidera · mandato {generation}",
  "pack.member.conflictNoWarrant": "{lead} también lidera · sin mandato",
  "pack.member.version": "Versión",
  "pack.member.versionDiffers": "difiere del lead",
  "pack.member.address": "Dirección",
  "pack.member.enrolled": "Inscrito",
  "pack.member.secretBehind": "Todavía no ha recogido el secreto actual.",
  "pack.member.provisional": "Inscrito pero nunca alcanzado.",
  "pack.health.reachable": "accesible",
  "pack.health.unreachable": "inaccesible",
  "pack.health.incompatible": "incompatible",
  "pack.health.conflicted": "en conflicto",
  "pack.role.deputy": "deputy",
  "pack.sheet.goTo": "Ir a esta máquina",
  "pack.formation.aria": "Formación del grupo: {machines}",
  "pack.node.aria": "{name}, {role}, {health}",
  "pack.node.ariaPlain": "{name}, {health}",
  "pack.solo.title": "Este collie no lidera ningún pack",
  "pack.solo.description": "Un pack se crea y se cambia desde la línea de comandos.",
  "pack.error.title": "No se pudo cargar el estado del pack",
  "pack.error.description":
    "El bridge no respondió. Collie lo intentará en el siguiente sondeo.",

  // --- error (boot splash, route-level error recovery) ---
  "error.boot.connecting": "Conectando con la manada…",
  "error.boot.title": "Sin conexión",
  "error.boot.body": "No se puede alcanzar Collie — revisa la conexión con el host e inténtalo de nuevo.",
  "error.boot.retry": "Reintentar",
  "error.root.title": "Algo salió mal",
  "error.root.unknown": "Error desconocido",
  "error.root.reload": "Recargar",

  // --- idle (the idle-pause cover) ---
  "idle.dialogAria": "Collie en pausa",
  "idle.catchingUp.title": "Poniéndose al día",
  "idle.catchingUp.body": "Cargando el estado actual de la manada.",
  "idle.paused.title": "En pausa",
  "idle.paused.body":
    "Las actualizaciones en vivo se detuvieron porque esta pantalla estuvo inactiva — lo que hay detrás está congelado. Al reanudar retomas justo donde lo dejaste.",
  "idle.resume": "Toca para reanudar",

  // --- pwa (self-update banner) ---
  "pwa.updateAvailable": "Nueva versión — toca para actualizar",

  // --- history (pane transcript route) ---
  "history.unavailable.disabled": "El historial de transcripción está desactivado en este bridge (COLLIE_TRANSCRIPT).",
  "history.unavailable.noSession": "Este panel no tiene sesión de agente, así que no hay transcripción que leer.",
  "history.unavailable.noLog": "Aún no se encontró archivo de transcripción para la sesión de este panel.",
  "history.unavailable.error": "No se pudo leer la transcripción. Vuelve atrás e inténtalo de nuevo.",
  "history.findAria": "Buscar en el historial",
  "history.closeAria": "Cerrar historial",
  "history.title": "Historial",
  "history.loadOlder": "Cargar anteriores",
  "history.loading": "Cargando…",
  "history.startClipped": "Inicio de la transcripción legible (el registro se recortó en el límite de lectura)",
  "history.startOfConversation": "Inicio de la conversación",
  "history.prevMessageAria": "Mensaje anterior que enviaste",
  "history.nextMessageAria": "Siguiente mensaje que enviaste",
  "history.loadOlderFailed": "No se pudo cargar historial anterior",

  // --- transcript (transcript-view turn rendering) ---
  "transcript.summaryLabel": "Contexto comprimido",
  "transcript.systemLabel": "Sistema",
  "transcript.youLabel": "Tú",
  "transcript.agentFallback": "agente",
  "transcript.outputTruncated": "… salida truncada",
  "transcript.truncated": "… truncado",

  // --- time (relative/clock formatting) ---
  "time.justNow": "justo ahora",
  "time.compact.now": "ahora",

  // --- sync (how fresh the herd on screen is, and asking for a fresher one) ---
  "sync.pull.hint": "Desliza para actualizar",
  "sync.pull.release": "Suelta para actualizar",
  "sync.pull.busy": "Actualizando…",

  // --- dialog (menu / multi-select / wizard / preview-select block renderers) ---
  "dialog.sendingAria": "Enviando",
  "dialog.previousStepAria": "Paso anterior",
  "dialog.nextStepAria": "Siguiente paso",
  "dialog.answeredAria": "Respondido",
  "dialog.submitChip": "Enviar",
  "dialog.stepPosition.step": "Paso {index} de {total}, {label}",
  "dialog.stepPosition.submit": "Paso {index} de {total}, Enviar",
  "dialog.chooseOption": "Elige una opción",
  "dialog.questionsAria": "Preguntas",
  "dialog.reviewAnswers": "Revisa tus respuestas",
  "dialog.readySubmit": "¿Listo para enviar tus respuestas?",
  "dialog.incomplete": "No respondiste todas las preguntas",
  "dialog.submitAnswers": "Enviar respuestas",
  "dialog.cancel": "Cancelar",
  "dialog.endsQuestionsSuffix": "— termina las preguntas",
  "dialog.menu.moveUp": "Subir",
  "dialog.menu.moveDown": "Bajar",
  "dialog.menu.leftAria": "Izquierda — {verb} ({label})",
  "dialog.menu.rightAria": "Derecha — {verb} ({label})",
  "dialog.preview.currentAnswerAria": "Respuesta actual",
  "dialog.preview.previewedBelowAria": "Vista previa abajo",
  "dialog.preview.previewLabel": "Vista previa · {label}",
  "dialog.preview.editingBanner": "La nota se está editando en la terminal — los controles vuelven cuando se cierre.",
  "dialog.preview.noteForQuestion": "Nota para esta pregunta",
  "dialog.preview.noteTextAria": "Texto de la nota",
  "dialog.preview.notePlaceholder": "Añade contexto para tu respuesta…",
  "dialog.preview.saveNote": "Guardar nota",
  "dialog.preview.editNoteAria": "Editar nota",
  "dialog.preview.removeNoteAria": "Quitar nota",
  "dialog.preview.noteAria": "Nota",
  "dialog.preview.addNote": "Añadir una nota a esta respuesta",

  // --- reply (the free-text reply race guard, lib/reply-action.ts) ---
  "reply.blocked.noBox":
    "El cuadro de entrada del agente no está visible — probablemente hay un menú o diálogo abierto. No se escribió nada.",
  "reply.blocked.noEcho":
    "Es una solicitud de contraseña — no muestra nada mientras escribes, así que Enviar nunca puede confirmar que el texto llegó. No se escribió nada.",
  "reply.blocked.composerLeft":
    "El cuadro de entrada del agente desapareció mientras se limpiaba su línea de entrada — probablemente hay un menú o diálogo abierto. Tu mensaje no se escribió.",
  "reply.stalled.noEcho":
    "Es una solicitud de contraseña — no muestra nada mientras escribes, así que el texto no se puede confirmar y no se envió. Lo que escribiste ya está en el panel.",
  "reply.stalled.generic":
    "El mensaje no llegó al cuadro de entrada — puede haber un diálogo esperando, y si lo respondiste con una tecla, es probable que esa tecla haya llegado. No se envió nada.",

  // --- previewAction (the preview-select dialog's note flow, lib/preview-action.ts) ---
  "previewAction.note.notOpened": "El campo de nota no se abrió — revisa el panel",
  "previewAction.note.clearFailed": "No se pudo borrar la nota existente — revisa el panel",
  "previewAction.note.textFailed": "El texto de la nota no llegó — revisa el panel",
  "previewAction.note.closeFailed": "El campo de nota no se cerró — revisa el panel",

  // --- promptAction (the plan-feedback flow, lib/prompt-action.ts) ---
  "promptAction.feedback.freeTextUnsupported":
    "La fila de texto libre de este diálogo no se escribe desde el teléfono",
  "promptAction.feedback.empty": "Nada que enviar",
  "promptAction.feedback.boxNotOpened": "El cuadro de comentarios no se abrió — revisa el panel",
  "promptAction.feedback.notArrived": "El comentario no llegó — no se envió nada",

  // --- stt (speech-to-text errors, lib/stt.ts + hooks/use-stt-recorder.ts) ---
  "stt.error.busy": "Ocupado — todavía se está transcribiendo otra grabación. Inténtalo de nuevo en un momento.",
  "stt.error.tooLong": "Esa grabación es muy larga — graba una más corta.",
  "stt.error.badFormat": "Este navegador grabó un formato que Collie no puede enviar.",
  "stt.error.unconfigured": "El dictado por voz no está configurado en este collie.",
  "stt.error.timeout": "El transcriptor no respondió a tiempo — inténtalo de nuevo.",
  "stt.error.unreachable": "No se pudo contactar al transcriptor — inténtalo de nuevo.",
  "stt.error.generic": "La transcripción falló — vuelve a grabar para intentarlo otra vez.",
  "stt.error.networkFailure":
    "No se pudo contactar a Collie para transcribir eso — inténtalo de nuevo.",
  "stt.error.recordingFailed": "La grabación falló — no se capturó nada.",
  "stt.error.noSpeechHeard": "No se escuchó nada en esa grabación.",
  "stt.error.nothingRecorded": "No se grabó nada.",
  "stt.error.unsupportedBrowser": "Este navegador no puede grabar audio.",
  "stt.error.micRefused": "Se rechazó el acceso al micrófono.",

  // --- directTyping (the composer's "Type into terminal" mode, hooks/use-direct-typing.ts) ---
  "directTyping.status.draftPending":
    "Envía o borra el borrador antes de escribir en la terminal.",
  "directTyping.status.armed": "Escribiendo en la terminal — las teclas se envían al instante.",
  "directTyping.status.disarmed": "Volviendo a enviar respuestas",
  "directTyping.status.interrupted":
    "Se detuvo la escritura en la terminal — la vista del panel se interrumpió.",
  "directTyping.status.backgrounded":
    "Se detuvo la escritura en la terminal — la app pasó a segundo plano.",

  // --- apiError (the bridge's refusals, keyed by the code on the wire) ---
  "apiError.unknown": "Algo salió mal. Inténtalo de nuevo.",
  "apiError.reply.not_submitted":
    "Tu mensaje se escribió en el panel pero no se envió — revisa el panel antes de enviarlo otra vez.",
  "apiError.reply.send_failed": "No se pudo enviar el mensaje: {reason}",
  "apiError.keys.send_failed": "No se pudieron enviar esas teclas: {reason}",
  "apiError.prompt_changed": "La pantalla cambió antes de poder enviarlo — revisa el panel.",
  "apiError.prompt.read_failed":
    "No se pudo leer el panel antes de enviar — {mux} responde: {detail}",
  "apiError.pane.close_failed": "No se pudo cerrar el panel: {reason}",
  "apiError.pane.rename_failed": "No se pudo renombrar el panel: {reason}",
  "apiError.pane.focus_failed": "No se pudo mostrar el panel en la terminal: {reason}",
  "apiError.tab.create_failed": "No se pudo crear la pestaña: {reason}",
  "apiError.tab.rename_failed": "No se pudo renombrar la pestaña: {reason}",
  "apiError.tab.close_failed": "No se pudo cerrar la pestaña: {reason}",
  "apiError.tab.workspace_required": "No se indicó un espacio para la nueva pestaña.",
  "apiError.workspace.create_failed": "No se pudo crear el espacio: {reason}",
  "apiError.upload.too_large": "Esa imagen es muy grande — el límite es 10 MB.",
  "apiError.upload.no_file": "No se envió ningún archivo.",
  "apiError.upload.bad_type": "Collie no puede enviar ese tipo de archivo: {type}",
  "apiError.upload.write_failed": "No se pudo guardar la imagen en el host: {reason}",
  "apiError.stt.unconfigured": "El dictado por voz no está configurado en este collie.",
  "apiError.stt.too_large": "Esa grabación es muy larga — graba una más corta.",
  "apiError.stt.bad_format": "Este navegador grabó un formato que Collie no puede enviar.",
  "apiError.stt.busy":
    "Ya se están transcribiendo dos grabaciones — inténtalo en un momento.",
  "apiError.stt.unreadable": "No se pudo leer esa grabación.",
  "apiError.stt.empty": "Esa grabación está vacía.",
  "apiError.stt.provider_failed": "La transcripción falló: {reason}",
  "apiError.pairing.bad_request":
    "El código o el nombre no eran válidos. Un nombre tiene entre 1 y 48 caracteres.",
  "apiError.pairing.no_pending": "No hay ningún código de vinculación pendiente en el host.",
  "apiError.pairing.expired": "Ese código de vinculación expiró.",
  "apiError.pairing.exhausted":
    "Demasiados códigos incorrectos — esa vinculación fue destruida.",
  "apiError.pairing.bad_code": "Ese código no coincide.",
  "apiError.pairing.duplicate_label": "Otro dispositivo ya usa ese nombre.",
  "apiError.device.unknown": "Ningún dispositivo vinculado tiene ese nombre.",
  "apiError.session.unknown": "No hay ninguna sesión llamada {session} en este collie.",
  "apiError.host.unknown": "No hay ningún collie llamado {host} en este pack.",
  "apiError.pack.not_lead": "Este collie no lidera ningún pack, así que no hay pack que mostrar.",
};
