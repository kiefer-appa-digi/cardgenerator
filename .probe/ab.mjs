import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
const buf = readFileSync("docs/source/ExportAllProducts_20260826220203076.xlsx");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(ab);
console.log("ok", wb.worksheets.map(w=>[w.name,w.rowCount,w.columnCount]));
