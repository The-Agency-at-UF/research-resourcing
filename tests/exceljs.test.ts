import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

test('ExcelJS reads and writes a workbook with UUID-backed conditional formatting', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Fictional Researchers');
  sheet.addRows([['id', 'capacity'], ['sample-1', 10]]);
  sheet.addConditionalFormatting({ ref: 'B2', rules: [{ type: 'dataBar', priority: 1,
    cfvo: [{ type: 'min' }, { type: 'max' }],
  }] });
  const bytes = await workbook.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(bytes);
  assert.equal(reread.getWorksheet('Fictional Researchers')?.getCell('A2').value, 'sample-1');
  assert.equal(reread.getWorksheet('Fictional Researchers')?.getCell('B2').value, 10);
});
