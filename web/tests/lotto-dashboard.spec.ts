import { expect, test, type Page } from "@playwright/test";

test.describe("LOTTO forensic dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/lotto/");
  });

  test("opens the public forensic lab and exposes every workspace", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "LOTTO", exact: true })).toBeVisible();
    await expect(page.getByText("NOT A PREDICTION", { exact: true })).toBeVisible();

    const tabs = page.getByRole("tablist", { name: /lotto sections/i });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(tabs.getByRole("tab", { name: "Audit" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Ticket Lab" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "EV Lab" })).toBeVisible();
  });

  test("renders validated live archive freshness without changing the local labs", async ({
    page
  }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      expect(route.request().method()).toBe("GET");
      expect(route.request().postData()).toBeNull();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-09-03T18:30:00.000Z",
          data: {
            games: [
              {
                code: "lotto",
                name: "Lotto Texas",
                sourceCount: 1,
                readySources: 1,
                activeDraws: 2_388,
                observedThrough: "2026-09-02",
                lastSuccessAt: "2026-09-03T18:29:00.000Z",
                status: "fresh",
                sources: [
                  {
                    id: "lotto:lottotexas",
                    name: "lottotexas",
                    session: "",
                    lastSuccessAt: "2026-09-03T18:29:00.000Z",
                    latestDrawDate: "2026-09-02",
                    activeCount: 2_388,
                    status: "ready"
                  }
                ]
              },
              {
                code: "cash5",
                name: "Cash Five",
                sourceCount: 1,
                readySources: 1,
                activeDraws: 2_487,
                observedThrough: "2026-09-02",
                lastSuccessAt: "2026-09-03T18:28:00.000Z",
                status: "fresh",
                sources: [
                  {
                    id: "cash5:cashfive",
                    name: "cashfive",
                    session: "",
                    lastSuccessAt: "2026-09-03T18:28:00.000Z",
                    latestDrawDate: "2026-09-02",
                    activeCount: 2_487,
                    status: "ready"
                  }
                ]
              }
            ]
          }
        })
      });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Cloud archive fresh", { exact: true })).toBeVisible();
    await expect(panel.getByText("4,875", { exact: true })).toBeVisible();
    await expect(panel.getByRole("list", { name: /freshness by game/i })).toBeVisible();

    await openTab(page, "EV Lab");
    await expect(page.getByRole("button", { name: "Calculate EV" })).toBeVisible();
  });

  test("falls back gracefully when live status has an invalid shape", async ({ page }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Embedded snapshot mode", { exact: true })).toBeVisible();
    await expect(panel.getByText(/verified bundled audits/i)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Ticket Lab" })).toBeEnabled();
  });

  test("keeps the local tools available when the status service is unavailable", async ({
    page
  }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Embedded snapshot mode", { exact: true })).toBeVisible();
    await openTab(page, "Ticket Lab");
    await expect(page.getByRole("button", { name: "Generate optimized set" })).toBeEnabled();
  });

  test("shows both verified official draw archives", async ({ page }) => {
    await openTab(page, "Audit");

    const game = page.getByRole("combobox", { name: /audit game/i });
    await game.selectOption({ label: "Lotto Texas" });
    await expect(page.getByText(/verified official archive/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lotto Texas", exact: true })).toBeVisible();

    await game.selectOption({ label: "Cash Five" });
    await expect(page.getByRole("heading", { name: "Cash Five", exact: true })).toBeVisible();
    await expect(page.getByText(/verified official archive/i).first()).toBeVisible();
  });

  test("generates a deterministic, budget-aware optimized ticket set", async ({ page }) => {
    await openTab(page, "Ticket Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByLabel("Tickets", { exact: true }).fill("4");
    await page.getByLabel("Seed", { exact: true }).fill("1836");

    const results = page.locator(".lotto-results-panel");
    await results.evaluate((resultsPanel) => {
      document.documentElement.dataset.lottoBusyObserved = "false";
      const recordBusyState = () => {
        const button = document.querySelector<HTMLButtonElement>("button.lotto-submit");
        if (
          resultsPanel.getAttribute("aria-busy") === "true" &&
          button?.disabled &&
          button.textContent?.includes("Optimizing in background")
        ) {
          document.documentElement.dataset.lottoBusyObserved = "true";
        }
      };
      new MutationObserver(recordBusyState).observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true
      });
      recordBusyState();
    });

    const generate = page.getByRole("button", { name: "Generate optimized set" });
    await generate.click();

    const output = page.getByRole("list", { name: "Optimized tickets" });
    await expect(output.getByRole("listitem")).toHaveCount(4);
    await expect
      .poll(() => page.locator("html").getAttribute("data-lotto-busy-observed"))
      .toBe("true");
    await expect(results).toHaveAttribute("aria-busy", "false");
    await expect(generate).toBeEnabled();
    await expect(page.getByText(/Coverage/i).first()).toBeVisible();

    const firstRun = await output.textContent();
    await generate.click();
    await expect(output).toHaveText(firstRun ?? "");
  });

  test("calculates expected value from explicit jackpot and sales assumptions", async ({
    page
  }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i }).fill("25000000");
    await page.getByLabel(/sales/i).fill("3000000");
    await page.getByLabel(/popularity/i).fill("1");
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
  });

  test("defaults pick popularity to the neutral 1.0 multiplier", async ({ page }) => {
    await openTab(page, "EV Lab");

    const popularity = page.getByRole("spinbutton", {
      name: /pick popularity multiplier/i
    });
    expect(Number(await popularity.inputValue())).toBe(1);
  });

  test("interprets exponent-form ticket sales as the full play count", async ({ page }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i }).fill("5000000");
    await page.getByRole("spinbutton", { name: /estimated ticket sales/i }).fill("1e6");
    await page.getByRole("spinbutton", { name: /pick popularity multiplier/i }).fill("1");
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
    await page.getByText("Model assumptions", { exact: true }).click();
    await expect(page.getByText(/estimated sales: 1000000 plays\./i)).toBeVisible();
  });

  test("accepts a legitimate cash jackpot that is not a round step multiple", async ({ page }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    const jackpot = page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i });
    await jackpot.fill("3940000");
    expect(await jackpot.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
    await expect(page.locator(".lotto-form-error")).toHaveCount(0);
  });

  test("keeps the primary experience accessible without horizontal overflow on mobile", async ({
    page
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("tablist", { name: /lotto sections/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "LOTTO", exact: true })).toBeVisible();

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    await openTab(page, "Ticket Lab");
    await expect(page.getByLabel("Tickets", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Seed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate optimized set" })).toBeVisible();
  });
});

async function openTab(
  page: Page,
  name: "Overview" | "Audit" | "Ticket Lab" | "EV Lab"
): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
