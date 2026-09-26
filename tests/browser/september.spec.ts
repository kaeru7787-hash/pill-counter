import { test, expect } from "@playwright/test";
import fs from "node:fs";
import sharp from "sharp";
import { positionMetrics } from "../../src/vision/positionMetrics";
test.use({ serviceWorkers: "block" });
const root = "work/september-18";
const cases =
  process.env.PILL_SEPTEMBER && fs.existsSync(`${root}/manifest.json`)
    ? JSON.parse(fs.readFileSync(`${root}/manifest.json`, "utf8"))
    : [];
for (const c of cases.flatMap((c: any) =>
  c.id === 17 ? [c, { ...c, resized: true }] : [c],
))
  test(`18-photo operation and positions ${c.id}${c.resized ? " resized" : ""}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180000);
    const config = JSON.parse(
      fs.readFileSync("public/models/config.json", "utf8"),
    );
    await context.route(config.modelURL, (r) =>
      r.fulfill({
        body: fs.readFileSync(".runtime/models/pill-yolo11n.onnx"),
        contentType: "application/octet-stream",
      }),
    );
    await page.goto("./?debug=1");
    await page.locator("#target").selectOption(c.target);
    await page
      .locator("#file")
      .setInputFiles(
        c.resized
          ? {
              name: "orange-resized.jpg",
              mimeType: "image/jpeg",
              buffer: await sharp(c.file)
                .rotate()
                .resize(1536, 2048)
                .jpeg({ quality: 88 })
                .toBuffer(),
            }
          : c.file,
      );
    await expect(page.locator("#status")).toContainText("解析完了", {
      timeout: 150000,
    });
    if (c.target === "pill")
      await expect(page.locator("#ai-status")).toContainText(
        "ONNXモデルで照合済み",
      );
    await page.locator("#save").click();
    await expect(page.locator("#status")).toContainText("この端末に保存");
    const downloading = page.waitForEvent("download");
    await page.locator("#export").click();
    const stream = await (await downloading).createReadStream();
    let text = "";
    for await (const chunk of stream!) text += chunk;
    const record = JSON.parse(text).records.at(-1),
      analysis = record.analysis;
    const baseline = JSON.parse(
      fs.readFileSync(`${root}/baseline/${c.id}.json`, "utf8"),
    );
    if (c.id === 17 && fs.existsSync(`${root}/orange-review.json`)) {
      const review = JSON.parse(
        fs.readFileSync(`${root}/orange-review.json`, "utf8"),
      );
      const scale = analysis.width / review.width;
      baseline.truth = review.points.map((p: any) => ({
        x: p.x * scale,
        y: p.y * scale,
      }));
      baseline.tolerance = review.tolerance * scale;
    }
    const metrics = baseline.truth
      ? positionMetrics(
          analysis.detections.map((d: any) => d.center),
          baseline.truth,
          baseline.tolerance,
        )
      : null;
    const prefix = `${root}/browser/${test.info().project.name}-${c.id}${c.resized ? "-resized" : ""}`;
    fs.mkdirSync(`${root}/browser`, { recursive: true });
    fs.writeFileSync(
      `${prefix}.json`,
      JSON.stringify({
        id: c.id,
        count: analysis.detections.length,
        expected: baseline.row.expected,
        metrics,
        analysis,
      }),
    );
    await page.locator("#open-result-zoom").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: `${prefix}.png` });
    await page.getByRole("button", { name: "拡大画像を閉じる" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    // Operation/consistency checks; known accuracy deficits are reported, not hidden.
    await expect(page.locator("#count")).toHaveText(
      String(analysis.detections.length),
    );
    expect(new Set(analysis.detections.map((d: any) => d.id)).size).toBe(
      analysis.detections.length,
    );
    if (c.id === 17) {
      expect(analysis.detections.length).toBe(280);
      if (metrics) {
        expect(metrics.fp).toBe(0);
        expect(metrics.fn).toBe(0);
      }
    }
    if (metrics && baseline.row.metrics) {
      expect(metrics.fp).toBeLessThanOrEqual(baseline.row.metrics.fp);
      expect(metrics.fn).toBeLessThanOrEqual(baseline.row.metrics.fn);
    }
  });
