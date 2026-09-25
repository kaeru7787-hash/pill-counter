import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.use({ serviceWorkers: "block" });
test("upstream model downloads, verifies, and is reused from device cache", async ({
  page,
  context,
}) => {
  test.skip(process.env.PILL_AI_LIVE !== "1", "Explicit network smoke test");
  test.setTimeout(180000);
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https:"))
      requests.push({ url: r.url(), method: r.method(), body: r.postData() });
  });
  await page.goto("./");
  await page
    .locator("#file")
    .setInputFiles("tests/images/21-yellow-tray-round.png");
  await expect(page.locator("#status")).toContainText("解析完了", {
    timeout: 150000,
  });
  await expect(page.locator("#ai-status")).toContainText("全体＋4区画");
  await expect(page.locator("#count")).toHaveText("12");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.method === "GET" && !r.body)).toBe(true);
  // New worker, external network unavailable: verified bytes remain usable.
  const config = JSON.parse(readFileSync("public/models/config.json", "utf8"));
  await context.route(config.modelURL, (r) => r.abort());
  await page.locator("#ai-enabled").uncheck();
  await expect(page.locator("#ai-status")).toContainText("AI併用OFF");
  await page.locator("#ai-enabled").check();
  await expect(page.locator("#ai-status")).toContainText("全体＋4区画", {
    timeout: 60000,
  });
  await expect(page.locator("#count")).toHaveText("12");
});
