import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import sharp from "sharp";
import { positionMetrics } from "../../src/vision/positionMetrics";

// These exercise the CV fallback and editing UI. Real hybrid inference has its
// own suite so this regression suite remains deterministic and offline.
test.beforeEach(async ({ context }) => {
  await context.route('**/models/config.json',r=>r.fulfill({status:404,body:''}));
  await context.addInitScript(() => localStorage.setItem("pill-ai-enabled", "false"));
});
test("JPEG EXIF orientation is applied before overlay coordinates", async ({
  page,
}) => {
  const jpeg = await sharp("tests/images/01-white-separated.png")
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await page.goto("./?debug=1");
  await page.locator("#file").setInputFiles({
    name: "oriented.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#image-meta")).toHaveText("480 × 640");
  await expect(page.locator("#count")).toHaveText("24");
});
test("camera controls, analysis, numbering, corrections, ROI, debug and local export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const outgoing: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (
      ["http:", "https:"].includes(u.protocol) &&
      !u.hostname.match(/^(127\.0\.0\.1|localhost)$/) &&
      !(r.method() === "GET" && u.href === "https://huggingface.co/piky/yolo11/resolve/9ec04d28c48d342906ccaee863a08a6a6394dbc1/yolo11n.onnx")
    )
      outgoing.push(r.url());
  });
  await page.goto("./?debug=1");
  await expect(page.locator("#camera")).toHaveAttribute(
    "capture",
    "environment",
  );
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("24");
  await expect(page.locator("#list button")).toHaveCount(24);
  // SW requests bypass route interception on WebKit: disabled model = medium,
  // failed download = review. Neither path may claim high confidence.
  await expect(page.locator("#confidence")).toHaveText(/^(中|低・要確認)$/);
  await page.locator('[data-mode="add"]').click();
  const canvas = page.locator("#image-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: box.width * 0.88, y: box.height * 0.85 },
  });
  await expect(page.locator("#count")).toHaveText("25");
  await page.locator("#undo").click();
  await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#redo").click();
  await expect(page.locator("#count")).toHaveText("25");
  await page.locator("#reset-detections").click();
  await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#detection-list summary").click();
  await page.locator("#list button").first().click();
  await page.locator("#delete-selected").click();
  await expect(page.locator("#count")).toHaveText("23");
  await page.locator("#confirmed").check();
  await expect(page.locator("#count-label")).toHaveText("目視確認済みの個数");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("この端末に保存");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let text = "";
  for await (const part of stream!) text += part.toString();
  const data = JSON.parse(text);
  expect(data.records[0].corrected).toHaveLength(23);
  expect(data.records[0].analysis.detections).toHaveLength(24);
  expect(data.records[0].original).toMatch(/^data:image\/png;base64,/);
  expect(data.records[0].confirmed).toBe(true);
  page.on("dialog", (d) => d.accept());
  await page.locator("#debug").check();
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#layer").selectOption("Distance transform");
  await expect(page.locator("#diagnostics")).toContainText("Otsu");
  await page.locator('[data-mode="roi"]').click();
  await page.locator("#canvas-wrap").evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
    el.scrollIntoView({ block: "start" });
  });
  const rect = (await canvas.boundingBox())!;
  await page.mouse.move(
    rect.x + (rect.width * 15) / 640,
    rect.y + (rect.height * 15) / 480,
  );
  await page.mouse.down();
  await page.mouse.move(
    rect.x + (rect.width * 180) / 640,
    rect.y + (rect.height * 85) / 480,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(page.locator("#count")).toHaveText("2");
  await expect(page.locator("#status")).toContainText("解析完了");
  await page.locator("#reset-roi").click();
  await expect(page.locator("#count")).toHaveText("24");
  expect(outgoing).toEqual([]);
  expect(errors).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: `tests/reports/ui-${test.info().project.name}.png`,
    fullPage: true,
  });
});
test("PWA reload and fresh analysis work with the origin server stopped", async ({
  page,
}) => {
  // Stop a real origin: WebKit offline emulation rejects SW navigation (Playwright #42775).
  const root = resolve("dist"),
    mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".wasm": "application/wasm",
    };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      const rel = url.pathname.replace(/^\/pill-counter\//, "") || "index.html";
      const file = resolve(root, rel);
      if (!file.startsWith(root + sep)) throw new Error("invalid path");
      const bytes = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  try {
    await page.goto(`http://127.0.0.1:${address.port}/pill-counter/`);
    await expect(page.locator("#offline")).toHaveText("オフライン対応");
    await page.locator("#demo").click();
    await expect(page.locator("#count")).toHaveText("24");
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((e) => (e ? reject(e) : done())),
    );
    await page.reload();
    await page
      .locator("#file")
      .setInputFiles("tests/images/04-touching-pairs.png");
    await expect(page.locator("#status")).toContainText("解析完了");
    await expect(page.locator("#count")).toHaveText("4");
    await expect(page.locator("#confidence")).toContainText("要確認");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("real tray: 90 spatially supported detections, debug layers and batch correction", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("./?debug=1");
  await page.locator("#debug").check();
  await page.locator("#file").setInputFiles("tests/images/18-real-tray.jpg");
  await expect(page.locator("#status")).toContainText("解析完了", {
    timeout: 60000,
  });
  await expect(page.locator("#count")).toHaveText("90");
  await expect(page.locator("#list button")).toHaveCount(90);
  await expect(page.locator("#image-meta")).toHaveText("1536 × 2048");
  await expect(page.locator("#confidence")).toContainText("要確認");
  for (const layer of [
    "Original",
    "ROI",
    "Grayscale",
    "Threshold",
    "Morphology",
    "Distance transform",
    "Markers",
    "Watershed",
    "Contours",
    "Final detections",
  ])
    await page.locator("#layer").selectOption(layer);
  await page.locator('[data-mode="batch"]').click();
  const canvas = page.locator("#image-canvas");
  await page.locator("#canvas-wrap").evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
    el.scrollIntoView({ block: "start" });
  });
  const r = (await canvas.boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.19, r.y + r.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.44, r.y + r.height * 0.39, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(page.locator("#count")).not.toHaveText("90");
  await page.locator("#undo").click();
  await expect(page.locator("#count")).toHaveText("90");
  await page.screenshot({
    path: `tests/reports/real-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("colored tablets in bags and trays: positions and counts survive browser decoding", async ({
  page,
}) => {
  test.setTimeout(300000);
  for (const [file, count] of [
    ["19-bag-round.jpg", 12],
    ["20-bag-oblong.jpg", 36],
    ["21-yellow-tray-round.png", 12],
    ["22-yellow-tray-oblong.png", 36],
  ] as const) {
    await page.goto("./?debug=1");
    await page.locator("#file").setInputFiles("tests/images/" + file);
    await expect(page.locator("#status")).toContainText("解析完了", {
      timeout: 90000,
    });
    await expect(page.locator("#count")).toHaveText(String(count));
    await expect(page.locator("#list button")).toHaveCount(count);
    await expect(page.locator("#confidence")).toContainText("要確認");
    await page.locator("#save").click();
    await expect(page.locator("#status")).toContainText("この端末に保存");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export").click();
    const stream = await (await downloadPromise).createReadStream();
    let exported = "";
    for await (const chunk of stream!) exported += chunk.toString();
    const record = JSON.parse(exported).records.find(
      (r: { filename: string }) => r.filename === file,
    );
    const annotation = JSON.parse(
      await readFile(
        "tests/annotations/" + file.replace(/\.[^.]+$/, ".json"),
        "utf8",
      ),
    );
    const centers = annotation.centers.map(([x, y]: number[]) => ({
      x: (x * record.analysis.width) / annotation.width,
      y: (y * record.analysis.height) / annotation.height,
    }));
    const scores = positionMetrics(
      record.analysis.detections.map(
        (d: { center: { x: number; y: number } }) => d.center,
      ),
      centers,
      (annotation.tolerance * record.analysis.width) / annotation.width,
    );
    expect({ tp: scores.tp, fp: scores.fp, fn: scores.fn }).toEqual({
      tp: count,
      fp: 0,
      fn: 0,
    });
    await page.screenshot({
      path: `tests/reports/${file}-${test.info().project.name}.png`,
      fullPage: true,
    });
  }
});

test("normal screen has only counting controls; developer panels are absent from view", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "解析設定" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "検証データ" })).toBeHidden();
  await expect(page.locator("#camera")).toHaveAttribute(
    "capture",
    "environment",
  );
  await page
    .locator("#file")
    .setInputFiles("tests/images/21-yellow-tray-round.png");
  await expect(page.locator("#status")).toContainText("解析完了", {
    timeout: 60000,
  });
  await expect(page.locator("#count")).toHaveText("12");
  await expect(page.locator("#votes")).toBeHidden();
  await page.locator('[data-mode="delete"]').click();
  await page.screenshot({
    path: `tests/reports/simple-${test.info().project.name}.png`,
    fullPage: true,
  });
});

