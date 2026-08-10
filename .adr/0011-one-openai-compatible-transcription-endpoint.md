# 0011 — Voice transcription uses one OpenAI-compatible endpoint

Status: **Accepted** (2026-08-09)

## Context

Microphone audio must remain behind Collie's authenticated, same-origin bridge: a phone must not
receive a provider credential or gain another listener. The browser records a completed clip, the
bridge submits it to the configured provider, and the resulting text remains an editable draft before
the existing guarded send path.

Alternatives considered:

- **LiteLLM** adds a Python runtime or separate proxy process, listener, supervision, and logging
  boundary for a single provider call.
- **Vercel AI SDK** has experimental transcription plus provider/registry surface without removing
  Collie's capture, validation, privacy, or draft-review responsibilities.
- **Bespoke fetch** would make Collie own multipart details, cancellation, retries, and
  OpenAI-compatible typing.

## Decision

Use the official `openai` JavaScript SDK with exactly one configured OpenAI-compatible endpoint.
Do not add a registry, fallback, streaming, conversion, playback, local service, or additional ingress.

## Consequences

- Operators select a model identifier whose endpoint implements Collie's narrow completed-file,
  final-text transcription subset; model names and transcription quality are not portable.
- The configured provider receives audio and owns its own retention and logging policy. Collie's
  current configuration, request bounds, privacy, and audit behavior are canonical in the
  [README](../README.md#voice-input-optional) and [Architecture](../ARCHITECTURE.md#6-security-model).
- A compatible private service may be the single upstream, but remains independently deployed and
  secured; Collie does not manage it.

## Revisit

Revisit this decision only when a concrete provider cannot meet the narrow final-text contract, or
when product requirements genuinely need provider-specific behavior. That is the threshold for a new
decision, not a reason to pre-build a registry.
