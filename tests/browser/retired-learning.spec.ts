import { test, expect } from "@playwright/test";
import sharp from "sharp";
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, context }) => {
  await context.route("**/models/config.json", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  await page.goto("./?debug=1");
});
async function seed(page: any) {
  await page.evaluate(async () => {
    for (const target of ["pill", "bottle"])
      localStorage.setItem(
        "pill-auto-learning-v1:" + target,
        '{"corrupt":"retired"}',
      );
    localStorage.setItem("user-preference", "keep");
    for (const name of ["pill-counter-learning", "pill-counter-local"])
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore("records", { keyPath: "id" });
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("records", "readwrite");
          tx.objectStore("records").put({
            id: "keep-or-delete",
            image: new Uint8Array([1, 2, 3]),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    const cache = await caches.open("pill-model-test");
    await cache.put(
      new Request(new URL("preserved-model", location.href)),
      new Response("model"),
    );
  });
}
async function photo(page: any) {
  const buffer = await sharp(
    Buffer.from(
      '<svg width="640" height="480"><rect width="640" height="480" fill="#303840"/><circle cx="140" cy="160" r="28" fill="#eee"/><circle cx="290" cy="160" r="28" fill="#eee"/><circle cx="440" cy="160" r="28" fill="#e9b153"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page
    .locator("#file")
    .setInputFiles({ name: "three.png", mimeType: "image/png", buffer });
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("3");
}
test("retired learning is removed, explicit results and model cache survive; edits stay on current photo", async ({
  page,
}) => {
  await seed(page);
  await page.addInitScript(() => {
    (window as any).cacheDeletes = [];
    const deleteCache = CacheStorage.prototype.delete;
    CacheStorage.prototype.delete = function (key) {
      (window as any).cacheDeletes.push(key);
      return deleteCache.call(this, key);
    };
    const deleteEntry = Cache.prototype.delete;
    Cache.prototype.delete = function (request, options) {
      (window as any).cacheDeletes.push(String(request));
      return deleteEntry.call(this, request, options);
    };
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(async () => ({
        keys: ["pill", "bottle"].map((t) =>
          localStorage.getItem("pill-auto-learning-v1:" + t),
        ),
        db: (await indexedDB.databases()).map((d) => d.name),
      })),
    )
    .toEqual({ keys: [null, null], db: ["pill-counter-local"] });
  expect(
    await page.evaluate(() => localStorage.getItem("user-preference")),
  ).toBe("keep");
  expect(await page.evaluate(() => (window as any).cacheDeletes)).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toContain("pill-model-test");
  // Windows WebKit loses Cache entries across reload even on a blank page.
  // Chromium verifies persistence; both engines verify no cache deletion calls.
  if (test.info().project.name === "chromium") {
    expect(
      await page.evaluate(
        async () =>
          !!(await (
            await caches.open("pill-model-test")
          ).match(new URL("preserved-model", location.href).href)),
      ),
    ).toBe(true);
  } else {
    test
      .info()
      .annotations.push({
        type: "environment",
        description:
          "Windows WebKit Cache entry persistence across reload is unavailable; deletion calls and cache container preservation are verified.",
      });
  }
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("pill-counter-local");
          req.onsuccess = () => {
            const db = req.result,
              q = db
                .transaction("records")
                .objectStore("records")
                .get("keep-or-delete");
            q.onsuccess = () => {
              resolve(q.result.image.length);
              db.close();
            };
          };
        }),
    ),
  ).toBe(3);
  await expect(page.locator("#auto-learning-status,[data-learn]")).toHaveCount(
    0,
  );
  await photo(page);
  await page.locator('[data-mode="delete"]').click();
  const b = (await page.locator("#image-canvas").boundingBox())!;
  await page.locator("#image-canvas").click({
    position: { x: (b.width * 440) / 640, y: (b.height * 160) / 480 },
  });
  await expect(page.locator("#count")).toHaveText("2");
  await page.locator("#undo").click();
  await expect(page.locator("#count")).toHaveText("3");
  await page.locator("#redo").click();
  await expect(page.locator("#count")).toHaveText("2");
  await photo(page);
  await page.reload();
  await photo(page);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pill-auto-learning-v1:pill"),
    ),
  ).toBeNull();
  await page.locator("#save").click();
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  let exported = "";
  for await (const part of (await (await pending).createReadStream())!)
    exported += part.toString();
  const record = JSON.parse(exported).records.find((r: any) => r.analysis);
  expect(record.analysis.version).toBe("0.15.0");
  expect(record.analysis.learning).toBeUndefined();
});
test("old tab blocking database deletion does not block inference, release completes deletion", async ({
  page,
  context,
}) => {
  await seed(page);
  const holder = await context.newPage();
  await holder.goto("./missing-cleanup-test");
  await holder.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const q = indexedDB.open("pill-counter-learning");
        q.onsuccess = () => {
          (window as any).heldDB = q.result;
          resolve();
        };
      }),
  );
  await page.reload();
  await photo(page);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("pill-auto-learning-v1:pill"),
    ),
  ).toBeNull();
  await holder.evaluate(() => (window as any).heldDB.close());
  await holder.close();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).some(
          (d) => d.name === "pill-counter-learning",
        ),
      ),
    )
    .toBe(false);
});
test("unavailable learning storage never prevents a new analysis", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.removeItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    IDBFactory.prototype.deleteDatabase = () => {
      throw new DOMException("denied", "SecurityError");
    };
  });
  await page.reload();
  await photo(page);
});
