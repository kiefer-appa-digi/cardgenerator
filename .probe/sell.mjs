import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("docs/source/ExportAllProducts_20260826220203076.xlsx");
const ws = wb.worksheets[0];
const headers = []; ws.getRow(1).eachCell({includeEmpty:true},(c,i)=>{headers[i-1]=c.text;});
const rows=[]; for(let r=2;r<=ws.rowCount;r++){const row=ws.getRow(r);const o={};let any=false;headers.forEach((h,i)=>{const t=row.getCell(i+1).text.trim();o[h]=t;if(t)any=true;});if(any)rows.push({r,o});}
const bare = /^[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)+$/;
const isBare = (s)=> s.length>0 && s.length<=24 && !/\s/.test(s) && bare.test(s);
console.log("bare-code descriptions:", rows.filter(x=>isBare(x.o["Product Description"])).map(x=>[x.r,x.o["Product Description"],x.o["SKU"],x.o["GTIN"]]));
console.log("empty descriptions:", rows.filter(x=>!x.o["Product Description"]).length);
console.log("purchasable N:", rows.filter(x=>x.o["Is Purchasable"]!=="Y").length);
console.log("is variable Y:", rows.filter(x=>x.o["Is Variable"]==="Y").length);
// upc vs gtin consistency
let mismatch=0; for(const {o} of rows){ const g=o["GTIN"], u=o["GTIN-12 (U.P.C.)"]; if(g&&u){ if(g.replace(/^0+/,"")!==u.replace(/^0+/,"")) mismatch++; } }
console.log("gtin/upc mismatch:",mismatch);
console.log("rows with gtin but no upc:", rows.filter(x=>x.o["GTIN"]&&!x.o["GTIN-12 (U.P.C.)"]).map(x=>[x.r,x.o["GTIN"],x.o["SKU"]]));
console.log("archived:", rows.filter(x=>x.o["Status Label"]==="Archived").map(x=>[x.r,x.o["SKU"],x.o["GTIN"]]));
