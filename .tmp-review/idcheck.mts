import { neon } from "@neondatabase/serverless";
import { checkIdentifier, canonicalGtin14 } from "@/components/product/identifier-check";
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql.query(`select product_id, kind, value, valid from product_identifiers`) as any[];
const byState: Record<string, number> = {};
const disagree: any[] = [];
for (const r of rows) {
  const s = checkIdentifier(r.kind, r.value);
  byState[s.state] = (byState[s.state] ?? 0) + 1;
  const agrees = (s.state === "valid" || s.state === "not-applicable") === r.valid;
  if (!agrees) disagree.push({ ...r, state: s.state, note: s.note });
}
console.log("states:", byState);
console.log("disagreements:", disagree.length, JSON.stringify(disagree.slice(0, 5), null, 1));
// canonical gtin14 coverage
const prods = await sql.query(`select p.id, p.part_number,
  coalesce((select value from product_identifiers where product_id=p.id and kind='gtin14' limit 1),'') g14,
  coalesce((select value from product_identifiers where product_id=p.id and kind='gtin13' limit 1),'') g13,
  coalesce((select value from product_identifiers where product_id=p.id and kind='gtin12' limit 1),'') g12
  from products p`) as any[];
let none = 0, upcaImpossibleButG14 = 0;
const { normaliseUpcA } = await import("@/lib/barcode/upc");
for (const p of prods) {
  const c = canonicalGtin14([p.g14, p.g13, p.g12]);
  if (!c) { none++; continue; }
  const upca = [p.g12, p.g13, p.g14].filter(Boolean).some(v => normaliseUpcA(v).ok);
  if (!upca) upcaImpossibleButG14++;
}
console.log("products with no GTIN-14 resolvable:", none, "| resolvable GTIN-14 but no UPC-A possible:", upcaImpossibleButG14);
