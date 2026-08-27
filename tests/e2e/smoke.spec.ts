import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";

test("signed-out visitors are sent to the login gate", async ({ page }) => {
  await page.goto("/products");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Card Designer" })).toBeVisible();
});

test("bad credentials are rejected without saying which field was wrong", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("kiefer@towparts.com");
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Next injects its own aria-live route announcer with role="alert", so scope
  // to the form's own message rather than to the role alone.
  const message = page.locator("form p[role=alert]");
  await expect(message).toContainText("not recognised");
  // The message must not distinguish a wrong password from a missing account.
  await expect(message).not.toContainText(/password is|no such|not found|unknown user/i);
});

test("an unknown account gets the identical message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password").fill("whatever-this-is");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form p[role=alert]")).toContainText("not recognised");
});

test("the default account can sign in and reach the overview", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("signing out revokes the session", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  // Going back to a protected page must not resurrect the session.
  await page.goto("/products");
  await expect(page).toHaveURL(/\/login/);
});
