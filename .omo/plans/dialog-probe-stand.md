# Stand Dialog-Probes (2026-10-08, pausiert)

## Gemessen
- `/models`-Dialog (unfiltered): modal=false, composer=false, picker=false
  (echte Prädikate auf Capture). Folge: Sends verweigert (sicher), aber KEINE
  Karte mit Escape — gleiche Loch-Klasse wie command-palette-query.
- Captures in /tmp verworfen (Transkript-Verschmutzung), keine fixtures erzeugt.

## Blockiert (Infra, kein Produkt-Befund)
- send-text landet seit ~18:00 nicht im Pane; frischer opencode-Boot 50s ohne
  Composer. T1 (getippter Filter-Send) und T2 (Permission-4.-Typ) nicht gefahren.
- agents/sessions/themes/rename/mcps/export: keine verwertbaren Shapes.

## Kosten
- 2 ungeplante Modell-Calls (/export, /sessions liefen als Agent-Tasks):
  $0.01, Budget /tmp/collie-budget-dialogs.log used=2/5 (max 5).

## Methoden-Lehre (in Skill-Auftrag überführt)
- Nie Slash-Text+Enter für unverifizierte Kommandos (führt als Agent-Task aus).
- Nur paletten-getrieben: Pfeiltasten + Enter auf verifizierte Einträge.
- Frisches /new pro Probe, visible-Source-Verifikation, Budget-consume VOR Enter.

## Offen (mit User besprechen)
- T1/T2/T3-Rest neu auflegen (saubere Methodik) oder als Stage an Skill-Tab.
- Permission-4.-Typ braucht 1 geplanten Call.
- Update/Share-Confirm: nur Code-Recon (nicht live triggerbar).
