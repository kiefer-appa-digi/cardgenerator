import { describe, expect, it } from "vitest";
import { emptyProductContext } from "@/lib/data/context";
import {
  createGs1UsAdapter,
  Gs1ConnectionConfigSchema,
  mapGs1ProductRecord,
  diffRemoteAgainstLocal,
  applyAcceptedFields,
} from "@/lib/gs1";
import type { Gs1Fetch, Gs1FetchResponse } from "@/lib/gs1/providers/gs1us";

function res(status: number, body: string): Gs1FetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

describe("ATTACK2", () => {
  it("A5 mixed-unit dimensions text", () => {
    const rec = mapGs1ProductRecord(
      { gtin: "00810797030124", tradeItemMeasurements: { width: { value: 4.5, unitCode: "INH" }, height: { value: 200, unitCode: "MMT" }, depth: { value: 1, unitCode: "INH" } } },
      "", "custom", "2026-01-01T00:00:00.000Z", {},
    );
    const d = diffRemoteAgainstLocal(rec!, emptyProductContext());
    console.log("A5 dims =>", JSON.stringify(d.find((x) => x.path === "custom.gs1Dimensions")?.remoteValue));
    expect(true).toBe(true);
  });

  it("A6 3xx classification", async () => {
    const cfg = Gs1ConnectionConfigSchema.parse({ provider: "custom", enabled: true, baseUrl: "https://api.test/v", authMode: "none" });
    let i = 0; const script = [res(302, ""), res(302, ""), res(302, "")];
    const a = createGs1UsAdapter(cfg, { fetch: async () => script[Math.min(i++, 2)], sleep: async () => {}, random: () => 0 });
    const r = await a.fetchProduct("810797030124");
    console.log("A6 302 =>", r.ok ? "ok" : `${r.error.code} status=${r.error.status} msg=${r.error.message}`);
    const r2 = await createGs1UsAdapter(cfg, { fetch: async () => res(418, ""), sleep: async () => {}, random: () => 0 }).fetchProduct("810797030124");
    console.log("A6 418 =>", r2.ok ? "ok" : `${r2.error.code}`);
    expect(true).toBe(true);
  });

  it("A10 timeout not enforced when fetch ignores the signal", async () => {
    const cfg = Gs1ConnectionConfigSchema.parse({
      provider: "custom", enabled: true, baseUrl: "https://api.test/v", authMode: "none", timeoutMs: 100,
      retry: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 2, jitterRatio: 0, maxRetryAfterMs: 100 },
    });
    const a = createGs1UsAdapter(cfg, { fetch: () => new Promise<Gs1FetchResponse>(() => {}), sleep: async () => {} });
    const winner = await Promise.race([
      a.fetchProduct("810797030124").then(() => "adapter-returned"),
      new Promise((r) => setTimeout(() => r("HUNG-FOREVER"), 1200)),
    ]);
    console.log("A10 =>", winner);
    expect(true).toBe(true);
  });

  it("A11 prototype pollution through an attacker-supplied diff row", () => {
    const local = emptyProductContext();
    const fake = [{ path: "__proto__.polluted", label: "x", remoteField: "x", localValue: "", remoteValue: "yes", kind: "missing-locally" as const, overwritesLocal: false, acceptable: true }];
    const out = applyAcceptedFields(local, fake, ["__proto__.polluted"]);
    console.log("A11 applied=", JSON.stringify(out.applied), "rejected=", JSON.stringify(out.rejected));
    console.log("A11 Object.prototype.polluted =", JSON.stringify(({} as Record<string, unknown>).polluted));
    delete (Object.prototype as unknown as Record<string, unknown>).polluted;
    expect(true).toBe(true);
  });

  it("A12 empty-string 200 body and array-of-nothing", async () => {
    const cfg = Gs1ConnectionConfigSchema.parse({ provider: "custom", enabled: true, baseUrl: "https://api.test/v", authMode: "none" });
    for (const body of ["", "[]", "null", '{"data":null}', '"just a string"', "123"]) {
      const a = createGs1UsAdapter(cfg, { fetch: async () => res(200, body), sleep: async () => {}, random: () => 0 });
      const r = await a.fetchProduct("810797030124");
      const v = await a.verifyGtin("810797030124");
      console.log(`A12 body=${JSON.stringify(body).padEnd(18)} fetch=${r.ok ? "OK(fabricated)" : r.error.code}  verify=${v.ok ? v.value.status : v.error.code}`);
    }
    expect(true).toBe(true);
  });
});
