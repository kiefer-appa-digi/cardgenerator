import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Merged");
ws.addRow(["Identity", null, "Numbers", null]);
ws.addRow(["Part", "Name", "UPC", ""]);
ws.addRow(["11-500", "Bearing Kit", "810797030001", "x"]);
ws.mergeCells("A1:B1");
ws.mergeCells("C1:D1");
const buf = await wb.xlsx.writeBuffer();
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(buf);
const s = wb2.getWorksheet("Merged");
console.log("rowCount", s.rowCount, "colCount", s.columnCount, "actualRowCount", s.actualRowCount);
for (let r=1;r<=s.rowCount;r++){
  const out=[];
  for(let c=1;c<=s.columnCount;c++){
    const cell=s.getCell(r,c);
    out.push({a:cell.address, v:cell.value, t:cell.text, merged:cell.isMerged, master:cell.master?.address});
  }
  console.log(r, JSON.stringify(out));
}
// empty sheet
const wb3 = new ExcelJS.Workbook();
wb3.addWorksheet("Empty");
const b3 = await wb3.xlsx.writeBuffer();
const wb4 = new ExcelJS.Workbook();
await wb4.xlsx.load(b3);
const e = wb4.getWorksheet("Empty");
console.log("empty:", e ? [e.name, e.rowCount, e.columnCount, e.actualRowCount] : "none", wb4.worksheets.map(w=>w.name));
console.log("typeof buf", buf.constructor?.name, buf instanceof Uint8Array, buf instanceof ArrayBuffer);
