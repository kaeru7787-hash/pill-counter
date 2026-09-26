import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { positionMetrics } from "../../src/vision/positionMetrics";
test.use({ serviceWorkers: "block" });
test("target selector, bottle worker, units and pill AI preference", async ({
  page,
  context,
}) => {
  const config = JSON.parse(readFileSync("public/models/config.json", "utf8"));
  await context.route(config.modelURL, (r) => r.abort());
  await context.route("**/models/bottle-config.json", (r) => r.fulfill({status:404,body:""}));
  await page.goto("./");
  await expect(page.locator("#ai-enabled")).toBeChecked();
  await page.locator("#target").selectOption("bottle");
  await expect(page.locator("#ai-enabled")).toBeEnabled();
  const svg =
    '<svg width="800" height="600"><rect width="800" height="600" fill="#696969"/>' +
    [140, 350, 560]
      .map(
        (x, i) =>
          `<rect x="${x - 24}" y="150" width="48" height="110" fill="#703020"/><circle cx="${x}" cy="150" r="28" fill="${["#f52323", "#c6d21e", "#19aabe"][i]}"/>`,
      )
      .join("") +
    "</svg>";
  await page
    .locator("#file")
    .setInputFiles({
      name: "caps.png",
      mimeType: "image/png",
      buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
    });
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("3");
  await expect(page.locator(".unit")).toHaveText("本");
  await expect(page.locator("#ai-status")).toContainText(
    "点眼AIを利用できません",
  );
  await page.locator("#target").selectOption("pill");
  await expect(page.locator("#status")).toContainText("解析完了", {
    timeout: 150000,
  });
  await expect(page.locator("#ai-enabled")).toBeChecked();
  await expect(page.locator(".unit")).toHaveText("錠");
  await expect(page.locator("#target")).toHaveValue("pill");
  await expect(page.locator("#ai-enabled")).toBeEnabled();
  await page.locator('[data-mode="add"]').click();
  await page.locator("#image-canvas").click({ position: { x: 30, y: 30 } });
  const previousCount = await page.locator("#count").textContent();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#target").selectOption("bottle");
  await expect(page.locator("#target")).toHaveValue("pill");
  await expect(page.locator("#count")).toHaveText(previousCount!);
  await expect(page.locator(".unit")).toHaveText("錠");
  await expect(page.locator("#ai-enabled")).toBeEnabled();
});
// Blue remains a documented 39/41 development case, not an exact-count success.
for (const [name, target, count] of [
  ["32-gray-basket", "pill", 466],
  ["33-red-bottles", "bottle", 53],
  ["34-green-bottles", "bottle", 46],
  ["35-blue-bottles", "bottle", 39],
] as const) {
  test(`v07 real ${name}`, async ({ page, context }) => {
    const file = `work/originals/${name}.jpeg`;
    test.skip(
      !process.env.PILL_V07_REAL || !existsSync(file),
      "Optional private original",
    );
    test.setTimeout(180000);
    const config = JSON.parse(
      readFileSync("public/models/config.json", "utf8"),
    );
    await context.route(config.modelURL, (r) =>
      r.fulfill({
        contentType: "application/octet-stream",
        body: readFileSync(".runtime/models/pill-yolo11n.onnx"),
      }),
    );
    await page.goto("./?debug=1");
    await page.locator("#target").selectOption(target);
    await page.locator("#file").setInputFiles(file);
    await expect(page.locator("#status")).toContainText("解析完了", {
      timeout: 150000,
    });
    await page.locator("#save").click();
    const download = page.waitForEvent("download");
    await page.locator("#export").click();
    const stream = await (await download).createReadStream();
    let content = "";
    for await (const chunk of stream!) content += chunk;
    const record = JSON.parse(content).records.at(-1);
    mkdirSync("tests/reports/v07-browser", { recursive: true });
    writeFileSync(
      `tests/reports/v07-browser/${test.info().project.name}-${name}.json`,
      JSON.stringify(record.analysis),
    );
    if (count) await expect(page.locator("#count")).toHaveText(String(count));
    if (target === "pill") {
      const points = JSON.parse(
        readFileSync("work/basket-final.json", "utf8"),
      ).points;
      const scores = positionMetrics(
        record.analysis.detections.map((d: any) => d.center),
        points,
        24,
      );
      expect(scores.fp).toBe(0);
      expect(scores.fn).toBe(0);
    }
    await page.screenshot({
      path: `tests/reports/v07-browser/${test.info().project.name}-${name}.png`,
      fullPage: true,
    });
  });
}
