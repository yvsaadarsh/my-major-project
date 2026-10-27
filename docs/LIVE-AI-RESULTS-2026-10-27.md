# Live Gemini investigation — 2026-10-27

Continued from `6d4da35d1b869b485f207fb08ecc8ee36a393fee` on
`handoff/chatgpt-2026-10-26`. Only the previously created dedicated loopback
`projectos_gemini35_verify_20261027` database was used. No production/shared
DB, migration change, merge, or force-push.

## Original failures and evidence limits

The retained live run exited 1: **30 passed, 2 failed, 2 skipped**:

- `supported policy returns 200`: HTTP 502.
- `duplicate-intent policy returns 200`: HTTP 502.

The old harness discarded both error bodies. Their individual root causes
cannot be reconstructed: that route returns 502 for provider errors, empty,
malformed or schema-invalid output. Logs prove later simulation, parse-task
and narrative calls encountered 429, but do not tie 429 to those two requests.
Both policy requests subsequently returned valid drafts and conflicts. This
proves real read-only interpretation endpoints, not rule creation/execution.

The original simulation assertions checked text length and target references,
not provenance. Its logs contain interpretation/narration failures, and response
bodies were not retained. Therefore the old run cannot establish provenance for
each simulation response. Deterministic diff/apply/no-mutation/stale/replay checks
remain passing evidence; they are not live-AI evidence.

## Reproduced output defect

Authenticated listing includes explicit `gemini-3.6-flash`. The saved 3.5 alias
was routed to 3.6. A controlled request with the real task-parse prompt and
512-token configuration returned `MAX_TOKENS`: 491 thinking tokens, 17 output
tokens, 59 characters, invalid JSON. No response schema is configured; parsing
expects a complete JSON object with a nonempty title. This reproduces the
truncation-to-422 failure mode; the original 422's raw output was not retained.

With 4096 tokens, after one 503, the same prompt returned `STOP`, valid JSON
with title/description/priority/dueDate/notes, 1487 thinking tokens and 31 output
tokens. This confirms both the explicit model and the budget remedy at client
level. The old prose responses lacked completion metadata, so their precise
termination cause cannot be proved retrospectively.

## Focused changes

- Optional fast/quality token budgets, bounded at 8192; old defaults preserved.
- Reject non-STOP or missing completion markers, rather than accepting truncated
  JSON/prose. Streaming routes abort incomplete bodies instead of clean EOF.
- Simulation reports separate interpretation/narration provenance; only validated
  model interpretation and successfully completed narration are marked Gemini.
- Live harness requires both provenance markers, logs sanitized error categories,
  and compares rule counts before/after rather than comparing a count to itself.
- Regression tests cover truncated/missing completion metadata, partial streams,
  malformed interpretation and fallback provenance.

## Rate limits and cost control

No account quota/usage service is connected. The API key/model listing cannot
establish account billing limits. Historical 429 errors were normalized without
quota metadata; per-minute, token, daily and spend exhaustion remain unknown.
The installed SDK implements bounded exponential backoff with jitter and reads
Retry-After/Retry-After-Ms (subject to its maximum interval). This investigation
uses single-attempt calls with pacing, not repeated full-suite runs. Diagnostic
metadata records status, finish reasons, token usage, model version and retry/
quota metadata where supplied, never credentials or prompt/output text.

The final response identifies the exact exhausted quota:
`generativelanguage.googleapis.com/generate_content_free_tier_requests`,
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`. Google returned
RESOURCE_EXHAUSTED and RetryInfo.retryDelay=15622s (later 15602s), with no
Retry-After HTTP header. Further calls were stopped; no model switch was made
to evade the quota. Earlier 429s cannot retrospectively be assigned this cause.

Targeted runs use explicit 3.6 for both models, 4096-token budgets, proxy enabled,
and one attempt. Initial timeout was 30 seconds; following a narrative timeout,
a bounded 60-second timeout was used. The forecast fixture attempt changed only the disposable project age before a
diagnostic enum-name error stopped task inserts. That script was corrected, but
not rerun after quota exhaustion. Notification checks would require observing
a real baseline-to-new-band transition, not fabricating a stored baseline.

## Final results

| Check | Result | Evidence |
| --- | --- | --- |
| Explicit model / client structured JSON | PASS | 3.6 listed; real STOP completion and all task keys at 4096 tokens |
| Policy interpretation endpoint | PASS | HTTP200, TASK_OVERDUE / NOTIFY_MANAGER draft and conflict results; STOP metadata |
| Task parsing endpoint | BLOCKED | First 503, paced follow-up 429 daily quota; client-level JSON success is not endpoint success |
| Simulation live interpretation/narration | BLOCKED | Corrected request HTTP200, both aiProvenance fields fallback; provider 429. Initial diagnostic request used newStatus instead of status and was rejected before any model call |
| Narrative completion | BLOCKED | 30-second timeout before first chunk; no complete prose verified |
| Retrospective completion | BLOCKED | HTTP502 / upstream429; earlier partial prose is not a complete success |
| Forecast live prose | NOT RUN | Fixture setup error corrected; further work stopped at confirmed daily quota |
| Smart notification workflow | NOT RUN | Stopped at confirmed daily quota |
| Full live suite after changes | NOT RUN | Deliberately avoided; original 30/2/2 result remains historical |
| Client regression | PASS | 31 assertions, including completion metadata and budget bounds |
| Mocked routes | PASS | 269 assertions, including provenance and aborted incomplete body |
| Lint / typecheck / production build | PASS | No migration changes |
| Environment publication | NOT RUN | Configuration draft saving is not publication; no publish operation exposed |

Production readiness remains blocked on complete live workflow verification after
quota reset or an authorized quota increase. Defaults remain 2.5-flash / 2.5-pro;
the tested runtime explicitly overrides both to 3.6-flash. No model API key,
private prompt or generated task content was recorded in diagnostics. Logs are
outside Git under `/workspace/.onboarding/results`, particularly
`output-diagnosis.log`, `output-budget.log`, `targeted-*.log` and
`targeted-metadata.jsonl`. The final chat records commit/push status.

