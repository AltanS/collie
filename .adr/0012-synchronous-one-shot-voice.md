# 0012 — Voice remains a synchronous one-shot BFF

Status: **Accepted** (2026-08-16)

## Context

Voice transcription needs a final text result before it can enter Collie's existing editable draft and
explicit Send path. The current requirement is a completed clip, not partial text, playback, or a
background task. A five-minute, 8 MiB clip still needs to tolerate bounded slow but continuously
progressing mobile upload, which makes a small fixed browser timeout dishonest.

Several larger designs look attractive once a request takes longer than a normal mutation:

- A **status side-channel** needs operation identity, lifecycle state, polling, retention, and a policy
  for what a browser may infer after it loses the original response.
- An **async in-memory job** separates request receipt from result delivery but still loses work on a
  bridge restart; adding status/recovery semantics turns it into a tracker rather than a simpler call.
- **Durable or resumable upload** requires audio storage, cleanup, ownership, replay and retry rules,
  and a new privacy boundary for the most sensitive payload in this feature.
- A **realtime transport** adds connection lifecycle, framing, codec/backpressure and partial-result
  contracts even though the product wants one completed file and final text.

None solves a current user requirement, and all would expand the bridge's state, failure, and security
surface beyond the existing same-origin, write-gated BFF and one configured provider call.

## Decision

**Keep voice transcription synchronous and one-shot.** A pane-local browser operation records a
completed clip, makes one bounded request through the existing same-origin, write-gated bridge, and
receives final text for the ordinary editable draft. Do not add a status endpoint, async job, durable or
resumable upload, or realtime transport for this flow.

## Consequences

- There is no audio, operation, retry queue, or recovery record across an interrupted upload, page
  cancellation, or bridge restart. The operator records again after failure; a successful transcript
  retains only the existing editable browser draft semantics.
- The size-aware total deadline supports a bounded slow-but-progressing uplink. It does not promise
  completion through a long interruption or below the accepted uplink floor. MediaRecorder receives a
  codec-aware bitrate **hint**, not a guaranteed bitrate or a new quality/acceptance contract.
- Health domains stay split: root snapshot freshness, pane freshness, and fresh-only Herdr state are
  independent loader facts; voice phases and the pane write lock are local operation state. A pending
  voice request never becomes a global connection or reconnecting signal.
- Network topology and security posture do not change: no listener, front door, browser provider
  credential, or realtime channel is added. The same-origin write gate, server-held provider
  credential, and metadata-only privacy boundary remain in place.

## Revisit

Revisit only when product requirements actually need partial results, status after a lost response,
background completion, or recovery across restart/interruption. Any such requirement should choose its
persistence and security model explicitly rather than silently growing this one-shot path.
