import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() =>
    localStorage.setItem("pill-ai-enabled", "false"),
  );
  await page.goto("./");
});
test("confirmed feedback is private, redacted, persistent, deduplicated and exportable", async ({
  page,
}) => {
  const outgoing: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") outgoing.push(r.url());
  });
  await page.locator("#learning-panel > details > summary").click();
  await expect(page.locator('[data-learn="capture"]')).toBeDisabled();
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#target option[value=bottle]")).toHaveText(
    "点眼ボトル",
  );
  await page.locator("#confirmed").check();
  await page.locator('[data-learn="capture"]').click();
  const dialog = page.locator(".learning-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-action="save"]').click();
  await expect(dialog.locator('[data-action="status"]')).toContainText(
    "チェック",
  );
  await dialog.locator('[data-action="group"]').fill("丸錠A");
  // Redact the top-left region, including image background, then inspect exported bytes.
  const canvas = dialog.locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.02);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.15);
  await page.mouse.up();
  await dialog.locator('[data-action="consent"]').check();
  await dialog.locator('[data-action="save"]').click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-learn="message"]')).toContainText(
    "端末内に保存",
  );
  await page.locator('[data-learn="train"]').click();
  await expect(page.locator('[data-learn="model"]')).toContainText("4組以上");
  await expect(page.locator('[data-learn="suggest"]')).toBeDisabled();
  page.once("dialog", (d) => d.accept());
  const downloading = page.waitForEvent("download");
  await page.locator('[data-learn="export"]').click();
  const file = await downloading,
    data = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(data.records).toHaveLength(1);
  const record = data.records[0];
  expect(record.confirmed).toBe(true);
  expect(record.totalCount).toBe(24);
  expect(record.filename).toBeUndefined();
  expect(record.original).toBeUndefined();
  expect(record.examples.every((e: { y: number }) => e.y === 1)).toBe(true);
  const png = Buffer.from(record.imagePNG, "base64"),
    meta = await sharp(png).metadata();
  expect(meta.exif).toBeUndefined();
  const { data: rgb, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i =
    (Math.round(info.height * 0.08) * info.width +
      Math.round(info.width * 0.08)) *
    info.channels;
  expect([...rgb.subarray(i, i + 3)]).toEqual([0, 0, 0]);
  // A repeat save replaces the same photo, not a new training/validation case.
  await page.locator('[data-learn="capture"]').click();
  await dialog.locator('[data-action="consent"]').check();
  await dialog.locator('[data-action="save"]').click();
  await expect(page.locator('[data-learn="message"]')).toContainText(
    "同じ写真",
  );
  await page.reload();
  await page.locator("#learning-panel > details > summary").click();
  await page.getByText("保存済みデータの確認・削除", { exact: true }).click();
  await expect(page.locator(".learning-record")).toHaveCount(1);
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "このデータを削除", exact: true })
    .click();
  await expect(page.locator(".learning-record")).toHaveCount(0);
  expect(outgoing).toEqual([]);
});
test("an actual worker trains on independent sets; edits still require confirmation", async ({
  page,
}) => {
  // Synthetic records isolate training integration; not evidence of real-photo accuracy.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("pill-counter-learning", 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore("records", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      for (let g = 0; g < 4; g++)
        tx.objectStore("records").put({
          schemaVersion: 1,
          id: `test-${g}`,
          imageHash: `test-${g}`,
          group: `group-${g}`,
          target: "pill",
          createdAt: "2026-09-26",
          appVersion: "test",
          algorithm: "test",
          width: 10,
          height: 10,
          roi: { x: 0, y: 0, width: 10, height: 10 },
          masks: [],
          image: new ArrayBuffer(0),
          centers: [],
          removed: [],
          confirmed: true,
          totalCount: 6,
          examples: Array.from({ length: 9 }, (_, i) => ({
            x: Array(18).fill((i < 6 ? 0.8 : 0.2) + g * 0.002),
            y: i < 6 ? 1 : 0,
            center: { x: i, y: 2 },
            box: { x: 0, y: 0, width: 2, height: 2 },
            kind: i < 6 ? "confirmed" : "background",
          })),
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.locator("#learning-panel > details > summary").click();
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await page.locator('[data-learn="train"]').click();
  await expect(page.locator('[data-learn="model"]')).toContainText(
    "補助候補の提示に使用できます",
  );
  await expect(page.locator('[data-learn="suggest"]')).toBeEnabled();
  await page.locator('[data-learn="suggest"]').click();
  await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#confirmed").check();
  await page.locator('[data-mode="add"]').click();
  const c = page.locator("#image-canvas"),
    b = (await c.boundingBox())!;
  await c.click({ position: { x: b.width * 0.88, y: b.height * 0.85 } });
  await expect(page.locator("#count")).toHaveText("25");
  await expect(page.locator("#confirmed")).not.toBeChecked();
  await expect(page.locator('[data-learn="capture"]')).toBeDisabled();
});
