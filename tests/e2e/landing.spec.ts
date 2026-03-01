import { test, expect } from "@playwright/test";

test.describe("Landing Page", () => {
  test("should load the landing page with hero section", async ({ page }) => {
    await page.goto("/");

    // Check page title
    await expect(page).toHaveTitle(/Apex/);

    // Hero section
    await expect(page.getByRole("heading", { name: /Your AI Workforce/i })).toBeVisible();
    await expect(page.getByText(/Deployed in 5 Minutes/i)).toBeVisible();

    // CTA buttons
    await expect(page.getByRole("link", { name: /Start Free Trial/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Watch Demo/i })).toBeVisible();
  });

  test("should show navigation links", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /Sign In/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Get Started Free/i })).toBeVisible();
  });

  test("should display integration logos", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Integrates with")).toBeVisible();
    await expect(page.getByText("Gmail")).toBeVisible();
    await expect(page.getByText("HubSpot")).toBeVisible();
    await expect(page.getByText("OpenAI")).toBeVisible();
  });

  test("should show How It Works section", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /How It Works/i })).toBeVisible();
    await expect(page.getByText("Sign Up")).toBeVisible();
    await expect(page.getByText("Pick Your Agent")).toBeVisible();
    await expect(page.getByText("Connect Your Tools")).toBeVisible();
    await expect(page.getByText("Deploy & Watch")).toBeVisible();
  });

  test("should show pricing section", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Simple, Transparent Pricing/i })).toBeVisible();
  });

  test("should show FAQ section", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Frequently Asked Questions/i })).toBeVisible();
    await expect(page.getByText("How do AI agents work?")).toBeVisible();
  });

  test("should show footer with legal links", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Privacy Policy/i })).toBeVisible();
    await expect(page.getByText(/Kloudedge Apex LLP/)).toBeVisible();
  });

  test("should navigate to sign up page", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: /Get Started Free/i }).click();

    await expect(page).toHaveURL(/\/signup/);
  });

  test("should navigate to sign in page", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: /Sign In/i }).click();

    await expect(page).toHaveURL(/\/login/);
  });
});
