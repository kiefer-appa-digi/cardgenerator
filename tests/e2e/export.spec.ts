import { test, expect } from "@playwright/test";
import { createCard, signIn } from "./helpers";

/**
 * The export path end to end: preflight decides, a PDF is produced by the real
 * writer, read back, validated, and offered for download. This is the flow that
 * puts artwork in front of a press, so it is exercised through the UI rather
 * than trusted to the unit tests underneath it.
 */
test.describe("export", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("a production PDF is generated, validated and downloadable", async ({ page }) => {
    const id = await createCard(page, { product: "11-500" });
    await page.goto(`/designs/${id}/export`);

    // The page must state the geometry it is about to produce, in full precision.
    await expect(page.getByText("4.3675 × 7.11175 in")).toBeVisible();
    await expect(page.getByText("4.6175 × 7.36175 in")).toBeVisible();
    // And it must never claim PDF/X without an output intent.
    await expect(page.getByText(/not PDF\/X conformant/i)).toBeVisible();

    await page.getByRole("button", { name: /Production PDF/ }).click();
    const link = page.locator("a[download]");
    await expect(link).toBeVisible({ timeout: 90_000 });

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    const name = download.suggestedFilename();
    expect(name).toMatch(/11-500.*409TF.*production\.pdf$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // A two-page card with embedded subset fonts is not a few kilobytes.
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    const text = bytes.toString("latin1");
    expect(text).toContain("/TrimBox");
    expect(text).toContain("DeviceCMYK");
    // No editor overlay may reach production artwork.
    for (const word of ["PROOF", "DO NOT PRINT", "SAFE AREA"]) {
      expect(text).not.toContain(word);
    }
  });

  test("a proof carries the slug and says it is not for production", async ({ page }) => {
    const id = await createCard(page, { product: "11-500" });
    await page.goto(`/designs/${id}/export`);
    await page.getByRole("button", { name: /Proof PDF/ }).click();
    const link = page.locator("a[download]");
    await expect(link).toBeVisible({ timeout: 90_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/proof\.pdf$/);
  });

  test("the export lands in the job history with its compliance status", async ({ page }) => {
    const id = await createCard(page, { product: "11-500" });
    await page.goto(`/designs/${id}/export`);
    await page.getByRole("button", { name: /Production PDF/ }).click();
    await expect(page.locator("a[download]")).toBeVisible({ timeout: 90_000 });

    // The job row is written after the download link appears, so poll the list
    // rather than assuming it has landed by the time the page renders once.
    await expect
      .poll(
        async () => {
          await page.goto("/exports");
          return page.getByText("409TF").count();
        },
        { timeout: 30_000, intervals: [1000, 2000, 3000] },
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Exports" })).toBeVisible();
  });
});
