# 0164: A push shows the project picture as its icon

- **Status:** Accepted
- **Date:** 2026-11-20
- **Supersedes in part:** [ADR 0160](./0160-a-repository-file-changes-what-collie-shows-and-nothing-else.md), rule 3's
  second and third sentences ("The icon and the badge are always Collie's. The picture goes only in the
  notification's own picture slot").
- **Trail:** the project picture's review (issue 811), rounds 17 and 18, 2026-11-20. On a Pixel with
  Chrome, the picture in `image` came as a full-width picture about half the notification tall; the
  operator found it "super large" and answered "yes approve small square". Files:
  `web/src/lib/project-picture-push.ts`, `web/src/lib/push-decision.ts` (`pushOptions`),
  `web/src/lib/project-picture.ts`, `web/src/sw.ts`

## Decision

- **A push about a session with a project picture shows the picture as the notification's icon**, the
  small square beside the title, from a 192 px square copy the page drew itself. With no picture the
  icon is the Collie mark.
- **No push sets `image`.** Android draws that slot at the full width of the notification, and a web
  page cannot size it.
- **The badge stays Collie's**, and the rest of ADR 0160's rule 3 stands: nothing is fetched at push
  time, and the operating system gets only the page's own PNG for that pane's machine and version.

## Consequences

- Collie's own mark leaves a push that has a picture. What says Collie there: on Android the app's
  icon and name in the header row and the badge in the status bar; on a desktop browser the origin
  line under the title. The title still names the agent, so the picture never stands alone.
- Desktop Chrome and Firefox show the icon, so their pushes show the picture too, where before only
  Android showed it. Safari draws the site's own icon and ignores `icon`, as before.
- A non-square picture sits whole and centred in the square on a transparent ground, never cropped or
  stretched. The copy is a few KB, where the 1024 x 512 banner it replaces was up to 1 MB.
