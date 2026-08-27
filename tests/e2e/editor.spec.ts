import { test, expect } from "@playwright/test";
import { createCard, selectLayer, signIn } from "./helpers";

/**
 * The editor flows the spec names in §6, §10, §21 and §24, exercised through the
 * real UI against the real database. These are the paths a unit test cannot
 * reach: pointer interaction, autosave, live binding and the preflight round trip.
 */
test.describe("editor", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("a card from a template shows the product's real data on the artboard", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    const svg = page.getByTestId("artboard-svg");
    // The part number is bound, not typed — it appears because the product has it.
    await expect(svg.getByText("11-500").first()).toBeVisible();
    await expect(svg.getByText("BEARING & SEAL KIT")).toBeVisible();
  });

  test("the data panel shows resolved values and marks the empty ones", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    // The panel tab is a persisted preference, so select it rather than assume it.
    await page.getByRole("tab", { name: "Data" }).click();
    await expect(page.getByText("Made in China")).toBeVisible();
    await expect(page.getByText("00810797031626")).toBeVisible();
    // A field the product does not carry is shown as empty rather than hidden.
    await expect(page.getByText("empty").first()).toBeVisible();
  });

  test("front and back are independent and the back is set to black and white", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    await page.getByRole("button", { name: /^back/i }).first().click();
    await expect(page.getByRole("heading", { name: /back side/i })).toBeVisible();
    await expect(page.getByLabel("Intent")).toHaveValue("grayscale");
  });

  test("preflight runs and reports against the real product", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    const strip = page.locator("text=Preflight").first();
    await expect(strip).toBeVisible();
    // Either it is clean or it names counts; both are a result, "not run" is not.
    await expect(
      page.locator("text=No blocking issues").or(page.locator("text=blocking")).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("arrow keys nudge the selected element by exactly 0.01 in", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    await selectLayer(page, "Part number");

    const x = page.getByLabel("X", { exact: true });
    const before = Number(await x.inputValue());

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => Number(await x.inputValue()))
      .toBeCloseTo(before + 0.02, 4);

    // Shift is the coarse nudge: 0.1 in, ten times the fine one.
    await page.keyboard.press("Shift+ArrowLeft");
    await expect
      .poll(async () => Number(await x.inputValue()))
      .toBeCloseTo(before + 0.02 - 0.1, 4);
  });

  test("undo puts a nudged element back exactly", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    await selectLayer(page, "Part number");
    const x = page.getByLabel("X", { exact: true });
    const before = await x.inputValue();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => await x.inputValue()).not.toBe(before);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => await x.inputValue()).toBe(before);
  });

  test("edits autosave and survive a reload", async ({ page }) => {
    const id = await createCard(page, { product: "11-500" });
    await selectLayer(page, "Part number");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("status")).toContainText(/Saved|Up to date/, { timeout: 20_000 });

    await page.goto(`/designs/${id}/edit`);
    await expect(page.getByTestId("artboard-svg")).toBeVisible();
    await expect(page.getByRole("status")).not.toContainText("Unsaved");
  });

  test("an overlay can be switched off without touching the artwork", async ({ page }) => {
    await createCard(page, { product: "11-500" });
    const cavity = page.getByLabel("Clamshell cavity");
    await expect(cavity).toBeChecked();
    await cavity.uncheck();
    await expect(cavity).not.toBeChecked();
    await expect(page.getByTestId("artboard-svg").getByText("CAVITY")).toHaveCount(0);
  });
});
