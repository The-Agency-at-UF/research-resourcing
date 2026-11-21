# Research Resourcing workbook import

Research keeps staffing in a SharePoint workbook (AgencySLT2 team site) with two relevant sheets. The importer reads both by layout, not sheet name, and ranks candidates with the dated engine. It does not write to the workbook.

```bash
npm run workbook -- --sample                         # fictional workbook in the same layout
npm run workbook -- ~/Downloads/research.xlsx         # downloaded copy (Excel online: File > Create a Copy > Download)
npm run workbook -- ~/Downloads/research.xlsx my-request.json
```

Results go to ignored `artifacts/workbook-run.json`. Real member data must stay out of Git: keep downloaded workbooks out of the repo (`*.xlsx` is ignored) and never copy names into fixtures or tests.

## Layout expected

- **Roster:** a header row containing `NAME` and `ROLE`, plus `GRADUATION` (e.g. `Spring 2027`) and `HIRE DATE` (e.g. `Fall 2025`). Rows without a recognized role (section labels, the graduation summary) are skipped. `(DM)` marks department managers.
- **Grid:** section rows starting with `Analysts`, `Strategists`, or `New Hires`, with a `# of Accounts` column followed by one column per account. Each section uses its own header row, because the same column position can hold different accounts in different sections. Member cells read `Name (MM/YYYY) [note] - note`. Checked accounts are Excel cell checkboxes (`TRUE`), or `☑`, `✓`, `x`. The `Exceptions` section is skipped because its columns are not current accounts.

Row and header colours (status legend, confirmed/waiting) are not read: the colours are inconsistent (whole sections share a colour) and are fragile through Microsoft Graph. A real `Status` column would let the importer exclude inactive or stepping-back members.

## Rules and assumptions

| Topic | Rule | Status |
|---|---|---|
| Capacity | Account slots, not hours: `maxAccounts` slots (3) per person; each checked account uses one; a request needs one free slot | **Confirmed** three-account cap (Nov 2, 2026). The workbook tracks no hours. |
| Load | `max(# of Accounts, checked boxes)`; a mismatch is warned and the difference counted as unlisted accounts | Conservative |
| Assignment dates | Every checked account is assumed to run `assignmentStart`–`assignmentEnd` in `config/workbook.json` (Fall 2026: 2026-08-24 to 2026-12-11) | **Assumption**: the grid has no dates |
| Role | Roster role decides eligibility: Analyst/Data Analyst → `analyst`; Strategist/Lead Researcher → `strategist`; Department Managers are approvers, not candidates | Requests must name a role |
| Availability | From hire term start to graduation (term end, or last day of the grid's `MM/YYYY`) | Conflicting dates use the earliest and warn |
| Experience | Years from hire term start to the request start | Replaces "experience years" |
| Matching | Roster and grid rows merge by normalized name. Near misses are reported, not merged; add `{"Grid Name": "Roster Name"}` to ignored `data/private/workbook-aliases.json` after checking | Flag, don't guess |
| Missing data | No hire term, no graduation date, not on the grid, or not on the roster: excluded with the reason shown | Same policy as the original scorer |

Open questions for Research: whether checked accounts span the whole semester, whether Analyst and Data Analyst are interchangeable, and whether Lead Researchers count as strategists.

Scoring uses `config/scoring-workbook.json`. Account load has weight 0 because slots already drive bandwidth. Interests, industry, and tools count only when 1:1 profiles are imported.

## 1:1 profiles

The workbook's Interests and Dream Job columns are empty, so interests, industries, and tools come from researcher 1:1s. Those notes are personal (career plans, outside jobs, feedback), so only staffing facts are imported, from a hand-reviewed file in ignored `data/private/profiles.json`. The schema refuses any other field, so free-text notes cannot be imported.

```json
{
  "source": "Researcher 1:1s, Fall 2026",
  "accounts": { "Fictional Screening Co": ["entertainment", "media"] },
  "researchers": [
    { "name": "Roster Name", "hoursPerWeek": 4, "accountCap": 2, "availableUntil": "2026-12-11",
      "interests": ["entertainment"], "industryExperience": ["media"], "tools": ["quid"] }
  ]
}
```

| Field | Effect |
|---|---|
| `accounts` | Industry tags per grid account. The request's interests are all of them, and the first is the primary industry compared with `industryExperience`. Untagged accounts score neither, and say so. |
| `interests` | Preferred post-grad industries. Scored against the account's tags (weight 0.08). |
| `industryExperience` | Industries from internships and jobs. Scored against the primary industry (weight 0.05). |
| `tools` | Tools they already use. Offered as optional "helpful tools" on the request form. A match raises the skills score and never excludes anyone. |
| `accountCap` | Most accounts they asked to hold. Lowers their slots below the department cap. A cap below current load is held at the load, with a warning, so nothing new is added and no overbooking is reported. |
| `availableUntil` | Leaving for good before graduation. The earlier date wins, with a warning. |
| `away` | Terms away and then returning, e.g. `["Spring 2027"]` or `"2027-01-11 to 2027-04-30"`. Terms use UF's official dates from `terms` in `config/workbook.json` (first day of classes to last day of finals). A term missing from that calendar uses a wider approximate span, with a warning. An unreadable entry holds the researcher back, with the reason shown. Requests overlapping an away period exclude them, and assignments that overlap one are flagged in import warnings and HQ. |
| `hoursPerWeek` | Shown to managers only. Capacity stays in account slots. |

Names match the roster as grid rows do, including `workbook-aliases.json`. Unmatched profiles and researchers with no profile are listed in the import warnings. A missing profile scores zero on interests and industry, so researchers without 1:1s rank slightly lower when an account is tagged. Bandwidth is measured against each person's own cap, so someone who asked for one account and has none counts as fully free.

The same fields can live in two sheets instead of JSON: **Profiles** (`NAME, HOURS PER WEEK, ACCOUNT CAP, AVAILABLE UNTIL, AWAY, INTERESTS, INDUSTRY EXPERIENCE, TOOLS`) and **Account Industries** (`ACCOUNT, INDUSTRIES`), with comma-separated lists. They can go in the workbook itself or in a second file uploaded with `/resourcing import`. `npm run profiles:sheet -- data/private/profiles.json` writes them to `data/private/profiles.xlsx`; with no argument it writes an empty template. Invalid rows are reported and skipped.

Tags are slugged, so "Food and Beverage" becomes `food-and-beverage`. Keep one vocabulary across accounts and people. Try it with the fictional data: `npm run workbook -- --sample --sample-profiles`. With real files: `npm run workbook -- ~/Downloads/research.xlsx fixtures/workbook-request.json --profiles data/private/profiles.json`, or seed with `npm run seed -- --workbook <xlsx> --profiles data/private/profiles.json`.

## Not yet covered

Previous accounts and research-type preferences are not recorded anywhere. Live Microsoft Graph reads and writing approvals back are later steps.
