import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("docs/source/ExportAllProducts_20260826220203076.xlsx");
const ws = wb.worksheets[0];
const seen = new Map();
for (let r=1;r<=Math.min(ws.rowCount,50);r++) for(let c=1;c<=ws.columnCount;c++){
  const v = ws.getCell(r,c).value;
  const k = v===null?"null":v===undefined?"undef":v instanceof Date?"Date":typeof v==="object"?JSON.stringify(Object.keys(v)):typeof v;
  if(!seen.has(k)) seen.set(k,{r,c,v});
}
console.log([...seen.entries()].map(([k,x])=>[k,x.r,x.c,String(x.v)]));
const d = ws.getCell(2,41).value;
console.log("date cell:", d, d instanceof Date, d instanceof Date ? d.toISOString() : "");
console.log("gtin cell:", JSON.stringify(ws.getCell(5,2).value), typeof ws.getCell(5,2).value);
