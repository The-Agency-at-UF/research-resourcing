import ExcelJS from 'exceljs';

/** Fictional workbook in the same layout as the Research Resourcing sheets: roster plus person × account grid. */
export function sampleWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Research Members').addRows([
    ['RESEARCH MEMBERS'],
    ['NAME', 'ROLE', 'GRADUATION', 'GRAD NOTES', 'INTAKE', 'HIRE DATE', 'INTERESTS', 'DREAM JOB', 'NOTES'],
    ['Pat Sample (DM)', 'Department Manager', 'Spring 2027', '', true, 'Fall 2023'],
    ['Lee Lead', 'Lead Researcher', 'Spring 2028', '', true, 'Spring 2024'],
    ['Ana Alpha', 'Analyst', 'Spring 2027', '', true, 'Spring 2025'],
    ['Bo Beta', 'Data Analyst', 'Fall 2026', '', true, 'Spring 2025'],
    ['Cy Gamma', 'Strategist', 'Spring 2027', '', true, ''],
    ['Di Delta', 'Strategist', 'Spring 2028', '', true, 'Fall 2025'],
    ['Ed Epsilon', 'Strategist', '?', '', true, 'Fall 2025'],
    ['Flo Zeta', 'Strategist', 'Spring 2027', '', true, 'Fall 2025'],
    ['Gus Eta', 'Data Analyst', 'Spring 2028', '', true, 'Fall 2025'],
    ['Hal Theta', 'Strategist', 'Spring 2028', '', true, 'Fall 2025'],
    ['NEW HIRES'],
    ['Ivy Iota', 'Strategist', 'Spring 2029', '', true, 'Spring 2026'],
    ['Jo Kappa', 'Data Analyst', 'Spring 2028', '', true, 'Spring 2026'],
    [],
    ['Fall 2026', 2],
    ['HIRING NUMBERS FALL 2026:'],
  ]);
  const accounts = ['Northwind Bakery', 'Contoso Health', 'Fictional Screening Co', 'Internal Comms'];
  workbook.addWorksheet('Resourcing Grid').addRows([
    ['Legend'], ['Account Supervisor'], ['DEPT MANAGER: Pat Sample'],
    ['', '', 'CONFIRMED', '', 'WAITING'],
    ['Analysts', '# of Accounts', ...accounts],
    ['Ana Alpha (05/2027)', 2, true, '☑', false, false],
    ['Bo Beta (12/2026)* - Confirm this', 1, false, false, false, false],
    ['Strategists', '# of Accounts', ...accounts],
    ['Lee Lead (05/2028)', 3, true, true, false, 'x'],
    ['Cy Gamma (05/2027)', 1, true, false, false, false],
    ['Di Delta (05/2028)', 1, false, false, true, false],
    ['Ed Epsilon (05/2027) - Confirm this', 1, true, false, false, false],
    ['Flo Zeta (05/2026, 05/2027)', 2, true, false, false, true],
    ['Hal Tehta (05/2028)', 1, false, true, false, false],
    ['New Hires (Fall 2026) SHADOWING', '# of Accounts', 'Northwind Bakery', 'Contoso Health', 'Fictional Screening Co', 'Fabrikam Podcast'],
    ['Ivy Iota', 0, false, false, false, false],
    ['Jo Kappa', 0, false, false, false, false],
    ['Kit Other [CS Department]', 1, false, false, false, true],
    ['Exceptions', '# of Accounts', 'Old Client A'],
    ['Interested'], ['Inactive'],
  ]);
  return workbook;
}
