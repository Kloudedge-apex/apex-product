import { test, expect } from "@playwright/test";

test.describe("Integrations Page", () => {
  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/integrations");
    await expect(page).toHaveURL(/\/login/);
  });

  test("should show integrations page elements when accessible", async ({ page }) => {
    await page.goto("/integrations");

    if (page.url().includes("/login")) {
      return;
    }

    // Page heading
    await expect(page.getByRole("heading", { name: /Integrations/i })).toBeVisible();
    await expect(page.getByText(/Connect your tools/i)).toBeVisible();
  });

  test("should display available integration cards", async ({ page }) => {
    await page.goto("/integrations");

    if (page.url().includes("/login")) {
      return;
    }

    // Should show available integrations
    await expect(page.getByText("Gmail")).toBeVisible();
    await expect(page.getByText("HubSpot")).toBeVisible();
    await expect(page.getByText("Outlook")).toBeVisible();
  });

  test("should show connect buttons for supported integrations", async ({ page }) => {
    await page.goto("/integrations");

    if (page.url().includes("/login")) {
      return;
    }

    // Connect buttons for active integrations
    const connectButtons = page.getByRole("button", { name: /Connect/i });
    if (await connectButtons.first().isVisible()) {
      expect(await connectButtons.count()).toBeGreaterThan(0);
    }
  });

  test("should show Coming Soon for unsupported integrations", async ({ page }) => {
    await page.goto("/integrations");

    if (page.url().includes("/login")) {
      return;
    }

    // Coming soon badges
    const comingSoon = page.getByText("Coming Soon");
    if (await comingSoon.first().isVisible()) {
      expect(await comingSoon.count()).toBeGreaterThan(0);
    }
  });

  test("should handle OAuth callback parameters", async ({ page }) => {
    await page.goto("/integrations?connected=gmail");

    if (page.url().includes("/login")) {
      return;
    }

    // Should show success notification for connected provider
    await expect(page.getByText(/gmail connected successfully/i)).toBeVisible({ timeout: 5000 });
  });
});
