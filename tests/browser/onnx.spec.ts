import { test, expect } from "@playwright/test";
import { constantModel } from "./modelFixture";
test.use({ serviceWorkers: "block" });
test("optional ONNX model executes locally and participates in spatial agreement", async ({
  page,
  context,
}) => {
  await context.route("**/models/pill-counter.onnx", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: constantModel(),
    }),
  );
  await context.route("**/models/config.json", (route) =>
    route.fulfill({
      json: {
        format: "yolov8-detect",
        inputSize: 640,
        classes: 1,
        scoreThreshold: 0.5,
        iouThreshold: 0.45,
      },
    }),
  );
  await page.goto("./");
  await page.locator("#auto-roi").uncheck();
  const bytes = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1b1f22";
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#e0e5e1";
    ctx.beginPath();
    ctx.arc(320, 240, 20, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator("#file").setInputFiles({
    name: "one-pill.png",
    mimeType: "image/png",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#ai-status")).toContainText(
    "ONNXモデルで照合済み",
  );
  await expect(page.locator("#votes")).toContainText("AI 1");
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#confidence")).toHaveText("高");
});
