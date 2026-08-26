import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("docs/source/ExportAllProducts_20260826220203076.xlsx");
const ws = wb.worksheets[0];
const headers = [];
ws.getRow(1).eachCell({includeEmpty:true},(c,i)=>{headers[i-1]=c.text;});
const rows = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r); const o = {}; let any=false;
  headers.forEach((h,i)=>{ const t=row.getCell(i+1).text.trim(); o[h]=t; if(t) any=true; });
  if (any) rows.push(o);
}
const skus = rows.filter(r=>r["SKU"]);
const m = new Map(); skus.forEach(r=>{ if(!m.has(r["SKU"])) m.set(r["SKU"],[]); m.get(r["SKU"]).push(r); });
const dupGroups = [...m.entries()].filter(e=>e[1].length>1);
console.log("distinct dup SKU values:", dupGroups.length);
console.log("rows in dup groups:", dupGroups.reduce((a,e)=>a+e[1].length,0));
console.log("extra rows beyond first:", dupGroups.reduce((a,e)=>a+e[1].length-1,0));
// brand+sku
const bm = new Map(); skus.forEach(r=>{const k=r["Brand Name"]+"|"+r["SKU"]; if(!bm.has(k)) bm.set(k,[]); bm.get(k).push(r);});
const bd = [...bm.entries()].filter(e=>e[1].length>1);
console.log("distinct dup brand+sku:", bd.length, "rows:", bd.reduce((a,e)=>a+e[1].length,0), "extras:", bd.reduce((a,e)=>a+e[1].length-1,0));
console.log("dup groups spanning >1 brand:", dupGroups.filter(g=>new Set(g[1].map(r=>r["Brand Name"])).size>1).length);
