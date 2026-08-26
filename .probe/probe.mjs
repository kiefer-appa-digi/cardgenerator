import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("docs/source/ExportAllProducts_20260826220203076.xlsx");
console.log("sheets:", wb.worksheets.map(w => [w.name, w.rowCount, w.columnCount, w.actualRowCount]));
const ws = wb.worksheets[0];
const hdr = ws.getRow(1);
const headers = [];
hdr.eachCell({includeEmpty:true},(c,i)=>{headers[i-1]=c.text;});
console.log(JSON.stringify(headers, null, 1));
console.log("headers len", headers.length);
for (const r of [2,3,4]) {
  const row = ws.getRow(r);
  const vals = [];
  row.eachCell({includeEmpty:true},(c,i)=>{vals[i-1]=c.text;});
  console.log("ROW",r,JSON.stringify(vals));
}
