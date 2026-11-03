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

Scoring uses `config/scoring-workbook.json`. Account load has weight 0 because slots already drive bandwidth; skills, interests, and industry stay inactive until Research records them.

## Not yet covered

Skills, research-type interests, industry and internship experience, and previous accounts are not in the workbook. Live Microsoft Graph reads, writing approvals back, and seeding the DynamoDB pilot from the workbook are later steps.
