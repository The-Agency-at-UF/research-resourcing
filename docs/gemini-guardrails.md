# Gemini system instructions and guardrails

System instructions define the model's role and behavior. A response schema defines the output shape. Neither replaces application validation or manager approval.

## Current implementation

`config/gemini-system-instructions.md` is the editable system prompt. It reflects the Resourcing Agent Brief: availability and essential requirements first; bandwidth given the largest individual weight; five retained and two or three displayed; missing/conflicting data flagged; no forced match; manager approval and fresh capacity checks required before assignments. The exact percentages in `config/scoring.json` are development proposals, not percentages dictated by the brief.

TypeScript calculates eligibility, scores, ordering, warnings, and the shortlist first. Gemini sees only displayed fictional candidate IDs, scores, verified facts, scoring configuration, and requested hours/openings. It selects two to four fact indexes per candidate. Code validates and renders those facts verbatim. Generated prose, scores, weights, new candidates, and assignments are not accepted.

Hard limits enforced in code:

- Exactly the displayed IDs in their original order; no extra fields.
- Two to four distinct valid facts per candidate, including available hours and essential requirements.
- Original scores, five-candidate retention, warnings, and approval notice preserved.
- One provider attempt; ten-second request timeout; 800 output tokens; no tools.
- Invalid JSON, invented facts, changed candidates, API failure, or missing configuration uses the full factual-template fallback.
- No eligible candidates skips the model call entirely.

Temperature 0.2 reduces variation in fact selection. It does not guarantee deterministic output or enforce staffing restrictions. Ranking remains deterministic regardless of model output.

## Run

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the ignored `.env`, then:

```bash
npm run demo:gemini
npm run demo:gemini -- fixtures/request-no-match.json
```

Results are saved to ignored `artifacts/gemini-demo.json`, with the untouched run, explanation source, and validated fact selections. This opt-in CLI demo uses fictional data only and does not post to Slack or update Excel. The separate Slack demo integration is unchanged and continues using factual templates.

## Future roles

Gemini could interpret natural-language requests into a validated request schema. Missing hours, essential skills, or timing should be clarified before scoring. It could propose weight changes for manager review, but must not apply them silently. Date-aware capacity, manager authorization, approval writes to both Excel datasets, reconciliation, and operations notifications remain future work.

References: [Google system instructions](https://ai.google.dev/gemini-api/docs/text-generation#system-instructions-and-other-configurations), [Google structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
