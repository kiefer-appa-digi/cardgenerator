import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("docs/source/ExportAllProducts_20260826220203076.xlsx");
const ws = wb.worksheets[0];
const headers = [];
ws.getRow(1).eachCell({includeEmpty:true},(c,i)=>{headers[i-1]=c.text;});
const rows = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const o = {};
  let any = false;
  headers.forEach((h,i)=>{ const t = row.getCell(i+1).text.trim(); o[h]=t; if(t) any=true; });
  if (any) rows.push(o);
}
console.log("data rows:", rows.length);
const cnt = (k) => { const m = new Map(); for (const r of rows) m.set(r[k], (m.get(r[k])||0)+1); return [...m.entries()].sort((a,b)=>b[1]-a[1]); };
console.log("brands", cnt("Brand Name"));
console.log("status", cnt("Status Label"));
const withG = rows.filter(r=>r["GTIN"]);
console.log("with GTIN", withG.length, "without", rows.length-withG.length);
function cd(s){ let sum=0; const d=s.split("").map(Number); const body=d.slice(0,-1); const rev=[...body].reverse(); rev.forEach((v,i)=> sum += v * (i%2===0?3:1)); return (10 - (sum%10))%10 === d[d.length-1]; }
console.log("valid check digits", withG.filter(r=>/^\d+$/.test(r["GTIN"]) && cd(r["GTIN"])).length);
console.log("gtin lengths", [...new Set(withG.map(r=>r["GTIN"].length))]);
const gset = new Map(); withG.forEach(r=>gset.set(r["GTIN"],(gset.get(r["GTIN"])||0)+1));
console.log("dup gtins", [...gset.entries()].filter(e=>e[1]>1).length);
const skus = rows.filter(r=>r["SKU"]);
console.log("with SKU", skus.length);
const sm = new Map(); skus.forEach(r=>sm.set(r["SKU"],(sm.get(r["SKU"])||0)+1));
console.log("dup skus (distinct sku values appearing >1)", [...sm.entries()].filter(e=>e[1]>1).length);
// org+brand+sku dup
const bs = new Map(); skus.forEach(r=>{const k=r["Brand Name"]+"|"+r["SKU"]; bs.set(k,(bs.get(k)||0)+1);});
console.log("dup brand+sku", [...bs.entries()].filter(e=>e[1]>1).length, [...bs.entries()].filter(e=>e[1]>1).slice(0,5));
// no sku rows
const nosku = rows.filter(r=>!r["SKU"]);
console.log("no sku rows", nosku.length, nosku.map(r=>[r["Product Description"], r["GTIN"], r["Brand Name"]]));
// no gtin rows
console.log("no gtin rows", rows.filter(r=>!r["GTIN"]).map(r=>[r["SKU"],r["Product Description"].slice(0,40),r["Status Label"]]));
// column emptiness
for (const h of headers) { const n = rows.filter(r=>r[h]).length; if (n < rows.length) console.log("  col", JSON.stringify(h), "nonempty", n); }
// sample of a full row with gtin
console.log(JSON.stringify(withG[0], null, 1));
// GPC etc
console.log("gpc bricks", cnt("GPC Brick").slice(0,10));
console.log("target markets", cnt("Target Markets").slice(0,5));
console.log("prefix", cnt("GS1 Company Prefix").slice(0,5));
console.log("uom1", cnt("Net Content 1 Unit of Measure").slice(0,8));
