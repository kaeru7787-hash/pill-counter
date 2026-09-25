import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test.use({ serviceWorkers: "block" });
test("candidate pill model performs real local inference in the browser", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.PILL_AI_MODEL,
    "Optional external research model; weights are not distributed.",
  );
  test.setTimeout(180000);
  await context.route("**/models/pill-counter.onnx", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: readFileSync(process.env.PILL_AI_MODEL!),
    }),
  );
  await context.route("**/models/config.json", (route) =>
    route.fulfill({
      json: {
        format: "yolov8-detect",
        inputSize: 640,
        classes: 4,
        allowedClasses: [0, 1, 3],
        scoreThreshold: 0.25,
        iouThreshold: 0.45,
      },
    }),
  );
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:4173/") &&
      !r.url().startsWith("blob:") &&
      !r.url().startsWith("data:")
    )
      external.push(r.url());
  });
  await page.goto("./?debug=1");
  await page.locator("#auto-roi").uncheck();
  await page
    .locator("#file")
    .setInputFiles("tests/images/25-lighting-bag-dense.png");
  await expect(page.locator("#status")).toContainText("解析完了", {
    timeout: 150000,
  });
  await expect(page.locator("#ai-status")).toContainText(
    "ONNXモデルで照合済み",
  );
  await expect(page.locator("#votes")).toContainText("AI 86");
  await expect(page.locator("#confidence")).toContainText("要確認");
  expect(external).toEqual([]);
  // This is an inference-runtime test. Fusion remains an offline experiment.
  await page.screenshot({
    path: `tests/reports/ensemble/real-ai-${test.info().project.name}.png`,
    fullPage: true,
  });
});
