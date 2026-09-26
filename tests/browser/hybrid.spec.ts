import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { positionMetrics } from "../../src/vision/positionMetrics";
test.use({ serviceWorkers: "block" });
const config = JSON.parse(readFileSync("public/models/config.json", "utf8"));
const cases = [
  ["18-real-tray.jpg", 90],
  ["19-bag-round.jpg", 12],
  ["20-bag-oblong.jpg", 36],
  ["21-yellow-tray-round.png", 12],
  ["22-yellow-tray-oblong.png", 36],
  ["23-lighting-bag-round.png", 12],
  ["24-lighting-bag-oblong.png", 36],
  ["25-lighting-bag-dense.png", 86],
  ["26-lighting-tray-dense.png", 86],
  ["27-round-tray.png", 28],
  ["28-round-bag.png", 28],
  ["29-white-tray.png", 56],
  ["30-white-bag.png", 56],
  ["31-dense-tray.png", 70],
] as const;
for (const [file, truth] of cases)
  test(`hybrid positions: ${file}`, async ({ page, context }) => {
    test.skip(
      !process.env.PILL_AI_MODEL || !existsSync("tests/images/" + file),
      "Optional local research fixture/model",
    );
    test.setTimeout(180000);
    await context.route(config.modelURL, (r) =>
      r.fulfill({
        contentType: "application/octet-stream",
        body: readFileSync(process.env.PILL_AI_MODEL!),
      }),
    );
    await page.goto("./?debug=1");
    await expect(page.locator("#ai-enabled")).toHaveCount(0);
    // Optional exact camera JPEGs exercise decoding/EXIF as well as inference.
    const jpeg =
      process.env.PILL_ORIGINALS &&
      `${process.env.PILL_ORIGINALS}/${file.replace(/\.png$/, ".jpeg")}`;
    if (jpeg && existsSync(jpeg))
      await page
        .locator("#file")
        .setInputFiles({
          name: file,
          mimeType: "image/jpeg",
          buffer: readFileSync(jpeg),
        });
    else await page.locator("#file").setInputFiles("tests/images/" + file);
    await expect(page.locator("#status")).toContainText("解析完了", {
      timeout: 150000,
    });
    await expect(page.locator("#ai-status")).toContainText("全体＋4区画");
    await expect(page.locator("#confidence")).toContainText("要確認");
    await page.locator("#save").click();
    await expect(page.locator("#status")).toContainText("この端末に保存");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export").click();
    const stream = await (await downloadPromise).createReadStream();
    let text = "";
    for await (const part of stream!) text += part.toString();
    const record = JSON.parse(text).records.find(
      (r: { filename: string }) => r.filename === file,
    );
    const a = JSON.parse(
      readFileSync(
        "tests/annotations/" + file.replace(/\.[^.]+$/, ".json"),
        "utf8",
      ),
    );
    const centers = a.centers.map(([x, y]: number[]) => ({
      x: (x * record.analysis.width) / a.width,
      y: (y * record.analysis.height) / a.height,
    }));
    const scores = positionMetrics(
      record.analysis.detections.map(
        (d: { center: { x: number; y: number } }) => d.center,
      ),
      centers,
      (a.tolerance * record.analysis.width) / a.width,
    );
    const output = {
      file,
      truth,
      detected: record.analysis.detections.length,
      ...scores,
      elapsed: record.analysis.elapsed,
      aiStatus: record.analysis.aiStatus,
      rejected: record.analysis.rejectedCandidates?.length ?? 0,
    };
    mkdirSync("tests/reports/hybrid-browser", { recursive: true });
    writeFileSync(
      `tests/reports/hybrid-browser/${test.info().project.name}-${file}.json`,
      JSON.stringify(output, null, 2),
    );
    await page.screenshot({
      path: `tests/reports/hybrid-browser/${test.info().project.name}-${file}.png`,
      fullPage: true,
    });
    expect(scores.fp).toBe(0);
    expect(scores.fn).toBeLessThanOrEqual(file.startsWith("24-") ? 1 : 0);
    expect(Math.abs(output.detected - truth)).toBeLessThanOrEqual(
      file.startsWith("24-") ? 1 : 0,
    );
    expect(
      new Set(record.analysis.detections.map((d: { id: string }) => d.id)).size,
    ).toBe(output.detected);
  });

test("failed AI request falls back visibly; AI stays automatic", async ({
  page,
  context,
}) => {
  await context.route(config.modelURL, (r) => r.abort());
  await page.goto("./");
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#ai-status")).toContainText("AI照合失敗");
  await expect(page.locator("#count")).toHaveText("24");
  await expect(page.locator("#confidence")).toContainText("要確認");
  await expect(page.locator("#ai-enabled")).toHaveCount(0);

  await expect(page.locator("#count")).toHaveText("24");
});
