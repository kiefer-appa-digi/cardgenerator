import { expect, type Page } from "@playwright/test";

export const EMAIL = process.env.E2E_EMAIL ?? "kiefer@towparts.com";
export const PASSWORD = process.env.E2E_PASSWORD ?? "Crystal102309!";

export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

/**
 * Create a card and land in the editor. Returns the design id.
 *
 * Written as a helper rather than a fixture because several specs need the card
 * to exist at different points and a shared fixture would couple their ordering.
 */
export async function createCard(
  page: Page,
  opts: { preset?: string; product?: string; template?: RegExp } = {},
): Promise<string> {
  const preset = opts.preset ?? "409TF";
  await page.goto("/designs/new");
  await page.getByRole("button", { name: new RegExp(preset) }).first().click();
  const tpl = page.getByRole("button", { name: opts.template ?? /11-500 master/ });
  if (await tpl.count()) await tpl.first().click();
  if (opts.product) {
    await page.getByLabel("Search products").fill(opts.product);
    await page.waitForTimeout(700);
    await page
      .getByRole("button")
      .filter({ hasText: new RegExp(opts.product) })
      .last()
      .click({ timeout: 20_000 });
  }
  await page.getByRole("button", { name: /Create and open editor/ }).click();
  await page.waitForURL(/\/edit$/, { timeout: 45_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByTestId("artboard-svg")).toBeVisible();
  return id;
}

/**
 * Select an element by its name in the layers panel.
 *
 * Scoped to the left panel and waiting for the list itself: matching on role and
 * text alone can transiently hit the inspector or a toolbar control while the
 * editor is still mounting, and a flaky selector makes a real regression look
 * like noise.
 */
export async function selectLayer(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "Layers" }).click();
  const panel = page.locator("aside").first();
  await expect(panel.getByRole("heading", { name: "Layers" })).toBeVisible();
  const row = panel.getByRole("button").filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  await row.click();
  // The inspector only shows geometry once something is selected.
  await expect(page.getByLabel("X", { exact: true })).toBeVisible();
}
