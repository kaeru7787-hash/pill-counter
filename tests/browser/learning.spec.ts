import { test, expect } from "@playwright/test";
import sharp from "sharp";
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, context }) => {
  await context.route("**/models/config.json", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  await context.addInitScript(() =>
    localStorage.setItem("pill-ai-enabled", "false"),
  );
  await page.goto("./");
});
const model = async (page: any) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("pill-auto-learning-v1:pill") || "null"),
  );
async function sample(shift = 0) {
  return sharp(
    Buffer.from(
      `<svg width="640" height="480"><rect width="640" height="480" fill="#303840"/><circle cx="${140 + shift}" cy="160" r="28" fill="#eee"/><circle cx="${290 + shift}" cy="160" r="28" fill="#eee"/><circle cx="${440 + shift}" cy="160" r="28" fill="#e9b153"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}
async function load(page: any, shift = 0) {
  await page
    .locator("#file")
    .setInputFiles({
      name: "sample.png",
      mimeType: "image/png",
      buffer: await sample(shift),
    });
  await expect(page.locator("#status")).toContainText("解析完了");
}
test("correction trains immediately, next photo uses learned weights, no training images persist", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") posts.push(r.url());
  });
  await expect(page.locator("#ai-enabled")).toHaveCount(0);
  await expect(page.locator("[data-learn]")).toHaveCount(0);
  await load(page);
  await expect(page.locator("#count")).toHaveText("3");
  await page.locator('[data-mode="delete"]').click();
  const b = (await page.locator("#image-canvas").boundingBox())!;
  await page
    .locator("#image-canvas")
    .click({
      position: { x: (b.width * 440) / 640, y: (b.height * 160) / 480 },
    });
  await expect(page.locator("#count")).toHaveText("2");
  expect(
    (await model(page)).recent.model.units.some(
      (u: any) => u.kind === "remove",
    ),
  ).toBe(true);
  expect((await model(page)).recent.complete).toBe(false);
  await load(page, 35);
  await expect(page.locator("#count")).toHaveText("2");
  await page.getByText("解析情報", { exact: true }).click();
  await expect(page.locator("#analysis-info")).toContainText("除外 1");
  const stored = JSON.stringify(await model(page));
  expect(stored).not.toMatch(/imagePNG|data:image|filename|center/);
  expect(
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open("pill-counter-learning", 1);
        q.onsuccess = () => r(q.result);
      });
      const n = await new Promise((r) => {
        const q = db.transaction("records").objectStore("records").count();
        q.onsuccess = () => r(q.result);
      });
      db.close();
      return n;
    }),
  ).toBe(0);
  expect(posts).toEqual([]);
  await page.reload();
  await load(page, 10);
  await expect(page.locator("#count")).toHaveText("2");
});
test("undo replaces training, pagehide completes once, reload recovers interrupted work", async ({
  page,
}) => {
  await load(page);
  await page.locator('[data-mode="delete"]').click();
  const b = (await page.locator("#image-canvas").boundingBox())!;
  await page
    .locator("#image-canvas")
    .click({
      position: { x: (b.width * 440) / 640, y: (b.height * 160) / 480 },
    });
  await page.locator("#undo").click();
  expect(
    (await model(page)).recent.model.units.some(
      (u: any) => u.kind === "remove",
    ),
  ).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect((await model(page)).recent.complete).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect((await model(page)).recent.model.updates).toBe(1);
  await page.reload();
  await load(page, 20);
  await expect(page.locator("#count")).toHaveText("3");
});
test("persistence failure is visible without losing editing", async ({
  page,
}) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("pill-auto-learning"))
        throw new DOMException("Quota", "QuotaExceededError");
    };
  });
  await load(page);
  await expect(page.locator("#auto-learning-status")).toContainText(
    "保存できません",
  );
  await expect(page.locator("#count")).toHaveText("3");
});
test("legacy training records are removed only after actual weights are durable", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open("pill-counter-learning", 1);
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const t = db.transaction("records", "readwrite");
      t.objectStore("records").put({
        id: "legacy",
        confirmed: true,
        target: "pill",
        width: 100,
        height: 100,
        image: new ArrayBuffer(100),
        examples: [
          {
            x: Array(18).fill(0.5),
            y: 1,
            kind: "added",
            box: { width: 20, height: 20 },
          },
        ],
      });
      t.oncomplete = () => r();
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator("#auto-learning-status")).toContainText(
    "以前の補正も学習",
  );
  const s = await model(page);
  expect(s.base.units).toHaveLength(1);
  expect(s.migrated).toEqual(["legacy"]);
  await page.reload();
  expect((await model(page)).base.updates).toBe(1);
});
