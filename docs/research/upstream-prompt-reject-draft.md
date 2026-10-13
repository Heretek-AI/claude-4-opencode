# FILED — upstream issue for sst/opencode (WS7)

Filed as https://github.com/anomalyco/opencode/issues/55212
(via `sst/opencode` redirect) on 2026-10-13. Drift J is kept until it lands.
Original draft body retained below for reference.

---

Title: `session.prompt` hook has no reject-with-message — throw yields empty HTTP 500

## What happens

`ctx.session.hook("prompt", ...)` (opencode 2.0.26) exposes a mutable
prompt. Throwing inside the hook keeps the prompt out of the session,
but the API answers HTTP 500 with an empty body. The block reason never
reaches the caller.

Observed and pinned downstream:

- `docs/research/opencode-v2-findings.md:18` — prompt-hook row:
  "Throwing keeps the prompt out of the session, and the API answers
  HTTP 500 with an empty body. There is no way to reject with a message."
- `docs/research/opencode-v2-findings.md:42` — gap: "A plugin cannot
  reject a prompt with a message the user sees."
- `docs/research/opencode-v2-findings.md:50` — drift J:
  "`UserPromptSubmit` blocking throws, so the API answers HTTP 500 with
  an empty body and the reason never reaches the caller."
- Downstream adapter: `src/runtime/hooks/bind.ts:168-179` (drift J
  comment + `throw new Error(outcome.blocked)`).

## Repro (downstream)

1. Register a `session.prompt` hook that throws `new Error("blocked: <reason>")`
   for a matching prompt.
2. Send that prompt through the API.
3. Prompt never reaches the model (good — non-admission holds), but the
   caller gets HTTP 500 with an empty body; `<reason>` is lost.

## Proposal (preserving non-admission)

Add a reject-with-message channel for the prompt hook that keeps the
prompt out of the session AND delivers the reason, e.g. either:

- a `PromptRejected` error class (or `{reject: true, message}` return)
  that the server maps to **403** with `{error: {code, message}}`, or
- allow returning `{reject: <message>}` from the hook with the same
  403 + `{error:{code,message}}` mapping.

Key property: non-admission is preserved (prompt still never reaches the
model); only the caller-visible status/body changes from
`500 + empty` to `403 + {error:{code,message}}`.

## Downstream stance until this lands

Keep drift J as-is (throw; prompt never reaches model). Do not replace
with context-append — that would let blocked prompts through. This
draft file is removed/replaced with the issue link once filed.
