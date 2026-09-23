# 0060 — An attachment is a chip, not a path

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/components/composer.tsx` · `web/src/components/attachment-chip.tsx` ·
  `web/src/lib/attachments.ts` · `web/src/lib/drafts.ts` · `bridge/server.ts` (CSP) ·
  [ADR 0057](./0057-the-composer-is-one-box.md)

## Context

An upload wrote the bridge's host path straight into the draft. The terminal needs that path, and
the phone gained nothing from showing it: a 70-character run of directory names that pushed the
operator's own words around and, before `wrap-anywhere`, pushed Send off the screen. Altan: "when
adding images, show little image icons instead of the raw urls ... resolved to the url when sending
to the terminal, just ugly in the collie UI". A first cut put every path in front of the text on
Send. Altan then asked that the path land where the attachment was added, the way Claude Code's own
`[Image #1]` works.

## Decision

**An upload becomes a chip above the field and a short marker in the draft. The marker holds the
place; Send swaps in the path there. The terminal gets the same line it got before.**

1. **The marker.** A finished upload inserts `[Image #N]` for a photo or `[File #N]` for anything
   else at the caret (the end when the field never had one), with a space before it unless the text
   there already ends in whitespace, and a space after it unless the text there already starts with
   some. `N` counts per draft from 1 and is never reused within the draft: removing `#2` leaves a
   gap. A multi-photo pick uploads one by one in pick order, and each marker lands after the one
   before.
2. **The chip.** Chips stand in a strip inside the composer's box, above its one row. A photo
   picked this session is a 40x40 thumbnail drawn from a blob URL; anything else, and a photo
   restored after a reload, is a small tile with an icon and the name cut to 14 characters. Each
   chip carries its `#N` in a corner badge and an x (`Remove <name>`, 44px hit area). One uniform
   1px border, no shadow. The strip scrolls sideways when it overflows. The box takes `flex-wrap`
   only while chips exist, so the field is never re-parented and an empty composer is exactly the
   one 46px row ADR 0057 measured.
3. **Send.** Each marker whose number matches a chip becomes that chip's path, where it stands. A
   chip whose marker the operator edited away is not dropped: its path goes in front of the text, in
   chip order. A marker-shaped string with no chip behind it is sent as typed. The destructive
   confirm reads the composed line. A box holding only chips shows Send, not the microphone, and
   sends the paths alone. A verified send clears text and chips together and restarts numbering; a
   failed one keeps both.
4. **The x.** It removes the chip, its marker and one space beside it. Deleting the marker by hand
   keeps the chip, which point 3 then sends in front, so nothing attached is lost by accident.
5. **Drafts.** The pane's draft stores the text with its markers, the chips (`n`, path, name, kind)
   and the next number. The blob URL is never stored; it is revoked when its chip is removed, sent,
   or its pane is left, and on unmount. A stored draft with no chip fields is the pre-chip shape,
   byte for byte, and still loads.
6. **CSP.** `img-src` admits `blob:`. A blob URL is minted only by this page's own script from a
   file the operator picked, so it opens no new origin.
7. **A chip whose marker is gone says so before Send.** Counsel asked that point 3 not be silent.
   While the chip's marker is missing from the text, its border turns dashed, its `#N` badge gains
   an arrow to the line's start, and its title and a screen-reader line read "Its marker is gone
   from your text, so Send puts <name> in front." Typing the marker back clears it. No dialog, no
   toast: the cue sits where the operator already looks, and the send itself is unchanged.
   `markerMissing` in `web/src/lib/attachments.ts` answers for both the chip and `composeLine`.

## Consequences

- **What the terminal receives is unchanged** whenever the markers are left alone: the same path,
  in the place the operator put it.
- **Paths no longer reach the field from an upload.** The `wrap-anywhere` and `min-w-0` guards
  stay, for a path the operator types or pastes as text.
- **The paste-a-file, Photos and Files paths share one chip list.** Take over, slash-command insert
  and dictation still write text only.
