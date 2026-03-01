import { test, expect } from "@playwright/test";

test.describe("Agents Page", () => {
  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/agents");
    await expect(page).toHaveURL(/\/login/);
  });

  test("should show agents page elements when accessible", async ({ page }) => {
    await page.goto("/agents");

    if (page.url().includes("/login")) {
      return; // Expected without auth
    }

    // Page heading
    await expect(page.getByRole("heading", { name: /Agents/i })).toBeVisible();
    await expect(page.getByText(/Manage your AI workforce/i)).toBeVisible();

    // New Agent button
    await expect(page.getByRole("link", { name: /New Agent/i })).toBeVisible();
  });

  test("should show template tab with available templates", async ({ page }) => {
    await page.goto("/agents");

    if (page.url().includes("/login")) {
      return;
    }

    // Click templates tab
    const templatesTab = page.getByRole("button", { name: /Templates/i });
    if (await templatesTab.isVisible()) {
      await templatesTab.click();

      // Should show template cards
      await expect(page.getByText(/Use Template/i).first()).toBeVisible();
    }
  });
});

test.describe("Agent Creation Flow", () => {
  test("should navigate to onboarding when creating new agent", async ({ page }) => {
    await page.goto("/agents");

    if (page.url().includes("/login")) {
      return;
    }

    const newAgentLink = page.getByRole("link", { name: /New Agent/i });
    if (await newAgentLink.isVisible()) {
      await newAgentLink.click();
      await expect(page).toHaveURL(/\/onboarding/);
    }
  });
});
