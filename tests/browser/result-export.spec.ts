import { test, expect } from "@playwright/test";
import sharp from "sharp";
import fs from "node:fs";
for (const [id, target, count] of [
  [18, "pill", 466],
  [14, "bottle", 52],
] as const)
  test(`private full-size export ${target}`, async ({ page, context }) => {
    test.skip(
      !process.env.PILL_EXPORT_REAL,
      "Local private-photo export check",
    );
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
    await page.locator("#target").selectOption(target);

    await page.locator("#file").setInputFiles(`work/september-18/${id}.jpg`);
    await expect(page.locator("#status")).toContainText("解析完了", {
      timeout: 120000,
    });
    await expect(page.locator("#count")).toHaveText(String(count));
    await page.locator("#detection-list summary").click();
    await page.locator("#list button").first().click();
    await page.locator("#delete-selected").click();
    await expect(page.locator("#count")).toHaveText(String(count - 1));
    await expect(page.locator("#save-result-image")).toBeEnabled();
    const downloading = page.waitForEvent("download");
    await page.locator("#save-result-image").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`2609262016_${count - 1}.png`);
    fs.mkdirSync("work/export-check", { recursive: true });
    await download.saveAs(
      `work/export-check/${test.info().project.name}-${target}.png`,
    );
  });
test.use({ serviceWorkers: "block", timezoneId: "Asia/Tokyo" });

test.beforeEach(async ({ context, page }) => {
  await context.route('**/models/config.json',r=>r.fulfill({status:404,body:''}));
  await context.addInitScript(() => {
    localStorage.setItem("pill-ai-enabled", "false");
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(navigator, "canShare", {
      value: () => false,
      configurable: true,
    });
  });
  await page.clock.setFixedTime(new Date("2026-09-26T11:16:00Z"));
  await page.goto("./");
  await expect(page.locator("#save-result-image")).toBeDisabled();
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#save-result-image")).toBeEnabled();
});

test("PNG contains edited markers and count badge; filename follows local minute and undo", async ({
  page,
}) => {
  await page.locator('[data-mode="add"]').click();
  const box = (await page.locator("#image-canvas").boundingBox())!;
  await page
    .locator("#image-canvas")
    .click({ position: { x: box.width * 0.88, y: box.height * 0.85 } });
  await expect(page.locator("#count")).toHaveText("25");
  await expect(page.locator("#save-result-image")).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.locator("#save-result-image").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("2609262016_25.png");
  const chunks: Buffer[] = [];
  for await (const chunk of (await download.createReadStream())!)
    chunks.push(chunk);
  const png = Buffer.concat(chunks),
    metadata = await sharp(png).metadata();
  expect([metadata.width, metadata.height, metadata.format]).toEqual([
    640,
    480,
    "png",
  ]);
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
  const at = (x: number, y: number) => [
    ...pixels.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 3),
  ];
  expect(at(620, 465)).toEqual([16, 43, 59]); // opaque dark badge backing
  let white = 0;
  for (let y = 440; y < 463; y++)
    for (let x = 550; x < 626; x++) if (at(x, y).every((v) => v > 235)) white++;
  expect(white).toBeGreaterThan(25); // readable white label
  // The manual marker must survive export (not just the original photo).
  const original = await sharp("tests/images/01-white-separated.png")
    .ensureAlpha()
    .raw()
    .toBuffer();
  const marker = (408 * 640 + 563) * 4;
  expect(
    pixels
      .subarray(marker, marker + 3)
      .equals(original.subarray(marker, marker + 3)),
  ).toBe(false);
  fs.mkdirSync("work/export-check", { recursive: true });
  fs.writeFileSync(`work/export-check/${test.info().project.name}.png`, png);
  await page.locator("#undo").click();
  await expect(page.locator("#save-result-image")).toBeEnabled();
  const undoDownload = page.waitForEvent("download");
  await page.locator("#save-result-image").click();
  expect((await undoDownload).suggestedFilename()).toBe("2609262016_24.png");
  await expect(page.locator("#count")).toHaveText("24");
});

test("picture-folder picker receives PNG and cancellation never downloads", async ({
  page,
}) => {
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.evaluate(() => {
    (window as any).pickerCalls = [];
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: any) => {
        (window as any).pickerCalls.push(options);
        if ((window as any).pickerCalls.length === 1)
          throw new DOMException("cancel", "AbortError");
        return {
          createWritable: async () => ({
            write: async (file: File) => {
              (window as any).savedFile = {
                name: file.name,
                type: file.type,
                size: file.size,
              };
            },
            close: async () => {
              (window as any).closedFile = true;
            },
          }),
        };
      },
    });
  });
  await page.locator("#save-result-image").click();
  await expect(page.locator("#result-export-status")).toContainText(
    "保存を中止",
  );
  expect(downloads).toBe(0);
  await page.locator("#save-result-image").click();
  await expect(page.locator("#result-export-status")).toContainText(
    "保存しました",
  );
  const state = await page.evaluate(() => ({
    calls: (window as any).pickerCalls,
    file: (window as any).savedFile,
    closed: (window as any).closedFile,
  }));
  expect(state.calls[1]).toMatchObject({
    startIn: "pictures",
    suggestedName: "2609262016_24.png",
  });
  expect(state.file).toMatchObject({
    name: "2609262016_24.png",
    type: "image/png",
  });
  expect(state.file.size).toBeGreaterThan(1000);
  expect(state.closed).toBe(true);
});

test("photo sharing receives prepared file; errors offer explicit download fallback", async ({
  page,
}) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async ({ files }: { files: File[] }) => {
        (window as any).shared = {
          name: files[0].name,
          type: files[0].type,
          size: files[0].size,
          active: navigator.userActivation.isActive,
        };
        throw new DOMException("blocked", "NotAllowedError");
      },
    });
  });
  await page.locator("#save-result-image").click();
  await expect(page.locator("#download-result-image")).toBeVisible();
  expect(await page.evaluate(() => (window as any).shared)).toMatchObject({
    name: "2609262016_24.png",
    type: "image/png",
    active: true,
  });
  const downloading = page.waitForEvent("download");
  await page.locator("#download-result-image").click();
  expect((await downloading).suggestedFilename()).toBe("2609262016_24.png");
});
