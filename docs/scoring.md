# Recommendation scoring

This pilot policy is derived from the Resourcing Agent Brief. Default weights and normalization choices are development proposals for manager review. Fit scores are relative scores, not probabilities.

## Eligibility before ranking

A researcher must be active, have enough remaining weekly hours, be below maximum account load, possess every essential skill, and meet minimum experience. Remaining hours = weekly capacity minus committed hours. Exactly enough capacity is eligible. Someone already on the requested account is excluded from this new-opening workflow; additional hours for an existing assignment need a separate workflow.

Missing fields, negative hours, capacity conflicts, duplicate IDs, and invalid account lists are flagged and excluded rather than inferred. Missing skills and a known empty list are distinct; the future Excel adapter must preserve that distinction.

Hours are **per researcher per week**. All openings in one request have identical requirements and share the shortlist. A candidate can fill only one opening. This is a recommendation pool, not an assignment plan. Refresh data and rerun after approved assignments. Different requirements need separate requests.

## Weighted fit

Edit `config/scoring.json`. Weights must sum to 1, be nonnegative, and give bandwidth a strictly larger weight than every other individual criterion. Display count may be 2 or 3; retention is 5.

| Criterion | Starting weight | Value from 0 to 1 |
|---|---:|---|
| Bandwidth | 50% | Remaining hours / total weekly capacity |
| Skills | 20% | Fraction of preferred skills matched; essential skills used if no preferences |
| Experience | 10% | Experience years / reference years, capped at 1 (reference starts at 3 years) |
| Interests | 8% | Fraction of requested career-interest tags matched |
| Account load | 7% | 1 minus current account count / maximum accounts |
| Industry exposure | 5% | 1 for listed experience in requested industry, otherwise 0 |

Skills, interests, and industry are inactive when no relevant criteria are requested. Their weights are removed and remaining weights are renormalized. Tags are trimmed, lowercased, and deduplicated; synonym mapping awaits the agreed skill vocabulary.

`score = 100 × sum(criterion value × effective weight)`

Bandwidth is the largest influence in a weighted score, not an absolute sorting rule. Someone with lower bandwidth can rank higher through better fit across other criteria. Bandwidth measures spare-capacity proportion, not absolute hours; eligibility still guarantees enough hours for the request. Confirm both choices with managers before using live data. Strict bandwidth-first ordering would be a different policy.

Sorting uses full precision and researcher ID for repeatable ties. Display rounds to one decimal place. Retain the top five or fewer, with explanations, criterion breakdowns, exclusions, warnings, and configuration snapshot. Display only the top two or three.

## Boundaries

The engine never approves or writes assignments. Human approval, fresh capacity checks, unique selections, and verified updates to both maintained Excel datasets are needed before confirming an assignment. Generated model text cannot change scores or eligibility.

Timing is assumed to be reflected in the current supplied availability snapshot. Semester/date-overlap eligibility and multi-opening optimization remain future work; this is not a complete staffing system.
