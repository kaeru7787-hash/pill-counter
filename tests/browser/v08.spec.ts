import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { positionMetrics } from "../../src/vision/positionMetrics";
test.use({ serviceWorkers: "block" });

test("adjacent rectangular caps and visible analysis version", async ({
  page, context,
}) => {
  const centers = Array.from({ length: 16 }, (_, i) => ({
    x: 90 + (i % 8) * 58,
    y: 95 + Math.floor(i / 8) * 110,
  }));
  const svg =
    '<svg width="620" height="500"><rect width="620" height="500" fill="#696969"/>' +
    centers
      .map(
        (p) =>
          `<rect x="${p.x - 23}" y="${p.y - 34}" width="46" height="68" rx="10" fill="#329dbf"/>`,
      )
      .join("") +
    "</svg>";
  await page.goto("./");
  await page.locator("#target").selectOption("bottle");
  await context.route('**/models/bottle-config.json',r=>r.fulfill({status:404,body:''}));
  await page
    .locator("#file")
    .setInputFiles({
      name: "rectangles.png",
      mimeType: "image/png",
      buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
    });
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("16");
  await page.getByText("解析情報", { exact: true }).click();
  await expect(page.locator("#analysis-info")).toContainText("v0.11.0");
  await expect(page.locator("#analysis-info")).toContainText(
    "写真内の形状基準 有効",
  );
});

// Private development photos are supplied locally, never committed.
for (const [name, target, count] of [
  ["36-gray-283", "pill", 283],
  ["37-square-52", "bottle", 52],
] as const)
  for (const variant of ["original", "resized-jpeg"] as const) {
    test(`v08 private ${name} ${variant}`, async ({ page, context }) => {
      const file = `work/originals/${name}.jpeg`,
        model = ".runtime/models/pill-yolo11n.onnx";
      test.skip(
        !process.env.PILL_V08_REAL ||
          !existsSync(file) ||
          !existsSync(model) ||
          !existsSync("work/new-counts.json"),
        "Optional private development image and reference",
      );
      test.setTimeout(180000);
      const config = JSON.parse(
        readFileSync("public/models/config.json", "utf8"),
      );
      await context.route(config.modelURL, (r) =>
        r.fulfill({
          contentType: "application/octet-stream",
          body: readFileSync(model),
        }),
      );
      const buffer =
        variant === "original"
          ? readFileSync(file)
          : await sharp(file)
              .rotate()
              .resize(1536, 2048)
              .jpeg({ quality: 88 })
              .toBuffer();
      await page.goto("./?debug=1");
      await page.locator("#target").selectOption(target);
      await page
        .locator("#file")
        .setInputFiles({
          name: `${name}.jpeg`,
          mimeType: "image/jpeg",
          buffer,
        });
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
      mkdirSync("tests/reports/v08-browser", { recursive: true });
      const prefix = `tests/reports/v08-browser/${test.info().project.name}-${name}-${variant}`;
      writeFileSync(`${prefix}.json`, JSON.stringify(record.analysis));
      const scale = variant === "original" ? 1 : 1536 / 1512;
      const points =
        target === "pill"
          ? JSON.parse(readFileSync("work/new-counts.json", "utf8")).runs[2].pts
          : [
              [213, 340],
              [342, 330],
              [471, 324],
              [597, 321],
              [725, 319],
              [854, 313],
              [983, 309],
              [1115, 306],
              [217, 512],
              [346, 510],
              [474, 504],
              [602, 499],
              [734, 495],
              [865, 489],
              [995, 482],
              [1122, 476],
              [218, 681],
              [345, 682],
              [476, 680],
              [607, 675],
              [740, 667],
              [871, 661],
              [1002, 655],
              [1139, 649],
              [219, 850],
              [348, 852],
              [477, 846],
              [610, 840],
              [744, 838],
              [878, 833],
              [1011, 828],
              [1146, 823],
              [211, 1036],
              [344, 1035],
              [477, 1031],
              [615, 1026],
              [750, 1022],
              [882, 1015],
              [1018, 1011],
              [1155, 1005],
              [214, 1226],
              [346, 1220],
              [481, 1218],
              [623, 1216],
              [757, 1208],
              [895, 1208],
              [1038, 1205],
              [1172, 1202],
              [336, 1383],
              [479, 1386],
              [623, 1391],
              [766, 1393],
            ].map(([x, y]) => ({ x: (x * 1512) / 1368, y: (y * 1512) / 1368 }));
      const metrics = positionMetrics(
        record.analysis.detections.map((d: any) => d.center),
        points.map((p: any) => ({ x: p.x * scale, y: p.y * scale })),
        (target === "pill" ? 25 : 45) * scale,
      );
      writeFileSync(`${prefix}-metrics.json`, JSON.stringify(metrics));
      await expect(page.locator("#count")).toHaveText(String(count));
      expect(metrics.fp).toBe(0);
      expect(metrics.fn).toBe(0);
      await expect(page.locator("#analysis-info")).toContainText("v0.9.0");
    });
  }
