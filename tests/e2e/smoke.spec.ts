import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "kiefer@towparts.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "Crystal102309!";

test("signed-out visitors are sent to the login gate", async ({ page }) => {
  await page.goto("/products");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Card Designer" })).toBeVisible();
});

test("bad credentials are rejected without saying which field was wrong", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("not recognised");
});

test("the default account can sign in and reach the overview", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
