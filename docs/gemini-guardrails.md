# Gemini system instructions and guardrails

System instructions define the model's role and behavior. A response schema defines the output shape. Neither replaces application validation or manager approval.

## Current implementation

`config/gemini-system-instructions.md` is the editable system prompt. It reflects the Resourcing Agent Brief: availability and essential requirements first; bandwidth given the largest individual weight; five retained and two or three displayed; missing/conflicting data flagged; no forced match; manager approval and fresh capacity checks required before assignments. The exact percentages in `config/scoring.json` are development proposals, not percentages dictated by the brief.

TypeScript calculates eligibility, scores, ordering, warnings, and the shortlist first. Gemini sees only displayed fictional candidate IDs, scores, verified facts, scoring configuration, and requested hours/openings. It selects two to four fact indexes per candidate. Code validates and renders those facts verbatim. Generated prose, scores, weights, new candidates, and assignments are not accepted.

Hard limits enforced in code:

- Exactly the displayed IDs in their original order; no extra fields.
- Two to four distinct valid facts per candidate, including available hours and essential requirements.
- Original scores, five-candidate retention, warnings, and approval notice preserved.
- Base model: `gemini-3.8-flash`; no automatic switch to another model.
- One initial provider request plus up to ten retries for HTTP 408/429/5xx and local timeouts. Thirty-second deadline per request; a fresh abort signal each time; exponential backoff from one second, capped at two seconds. SDK retries are disabled to keep the maximum at eleven provider requests. Worst case is approximately six minutes. Authentication/configuration errors and invalid output are not retried.
- 800 output tokens; no tools.
- Invalid JSON, invented facts, changed candidates, API failure, or missing configuration uses the full factual-template fallback.
- No eligible candidates skips the model call entirely.

Temperature 0.2 reduces variation in fact selection. It does not guarantee deterministic output or enforce staffing restrictions. Ranking remains deterministic regardless of model output.

## Run

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the ignored `.env`, then:

```bash
npm run demo:gemini
npm run demo:gemini -- fixtures/request-no-match.json
```

Results are saved to ignored `artifacts/gemini-demo.json`, with the untouched run, explanation source, and validated fact selections.

To test the same connection privately in Slack, start `npm run slack:demo` and run `/resource-demo ai`. No new slash command or Slack scope is needed. The command acknowledges immediately, displays a private waiting notice, then calls Gemini with the fictional sample shortlist. It replaces that notice with either `Gemini connected: verified fact selection` or `Template fallback` with a reason and provider-request count. A template fallback renders code-generated facts and does not call another model. The ignored `artifacts/slack-runs/` record includes the original run, model, explanation source, attempt count, and validated selections. Normal `/resource-demo` and `/resource-demo form` use factual templates without calling Gemini. Neither mode updates Excel or creates assignments.

For a local connection test, you need a valid Gemini API key with access/quota for `GEMINI_MODEL`, the installed Slack bot token, an app-level token with `connections:write`, and the configured workspace ID. Socket Mode must be enabled and the local process must stay running. AWS and Microsoft Graph are not needed for this fictional-data test. Rotating Slack access tokens can expire; refresh or replace them locally when required. Never put credentials in Git or demo records.

## Future roles

Gemini could interpret natural-language requests into a validated request schema. Missing hours, essential skills, or timing should be clarified before scoring. It could propose weight changes for manager review, but must not apply them silently. Date-aware capacity, manager authorization, approval writes to both Excel datasets, reconciliation, and operations notifications remain future work.

References: [Google system instructions](https://ai.google.dev/gemini-api/docs/text-generation#system-instructions-and-other-configurations), [Google structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [Google retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).
