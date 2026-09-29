import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test("normal display uses identical rotated ellipses; debug contours stay out of exported final markers", async ({
  page,
  context,
}, info) => {
  await context.route("**/models/config.json", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  await page.addInitScript(() => {
    const traces = new WeakMap<HTMLCanvasElement, number[][]>();
    const proto = CanvasRenderingContext2D.prototype,
      draw = proto.drawImage,
      ellipse = proto.ellipse;
    proto.drawImage = function (...args: any[]) {
      traces.set(this.canvas, []);
      return (draw as any).apply(this, args);
    };
    proto.ellipse = function (...args: any[]) {
      traces.get(this.canvas)?.push(args.slice(0, 5));
      return (ellipse as any).apply(this, args);
    };
    (window as any).markerTrace = (canvas: HTMLCanvasElement) =>
      traces.get(canvas);
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args: any[]) {
      (window as any).exportedMarkers = traces.get(this);
      return (toBlob as any).apply(this, args);
    };
  });
  await page.goto("./");
  await expect(
    page.getByRole("button", { name: "拡大・縮小", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#ellipse-debug")).toBeHidden();
  await page.goto("./?debug=1");
  await page.locator("#debug").check();
  await page.locator("#file").setInputFiles("tests/images/20-bag-oblong.jpg");
  await expect(page.locator("#status")).toContainText("解析完了");
  const count = Number(await page.locator("#count").textContent());
  expect(count).toBe(36);
  const markers = await page
    .locator("#image-canvas")
    .evaluate((c) => (window as any).markerTrace(c));
  expect(markers).toHaveLength(count);
  expect(new Set(markers.map((m: number[]) => `${m[2]},${m[3]}`)).size).toBe(1);
  expect(
    new Set(markers.map((m: number[]) => m[4].toFixed(2))).size,
  ).toBeGreaterThan(2);
  await expect(page.locator("#marker-legend")).toContainText("要確認");
  await page.getByText("楕円の計測・除外理由", { exact: true }).click();
  await expect(page.locator("#ellipse-debug")).toContainText("基準長径");
  await expect(page.locator("#ellipse-debug")).toContainText("IoU");
  await page.locator("#layer").selectOption("Ellipse review");
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `tests/reports/ellipse-debug-${info.project.name}.png`,
    fullPage: true,
  });
  // Export from the debug view must still draw only final normalized markers.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", {
      value: () => false,
      configurable: true,
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  const download = page.waitForEvent("download");
  await page.locator("#save-result-image").click();
  expect((await download).suggestedFilename()).toContain("_36.png");
  const exported = await page.evaluate(() => (window as any).exportedMarkers);
  expect(exported).toEqual(markers);
  await page.locator("#layer").selectOption("Final detections");
  await page.locator("#canvas-wrap").screenshot({
    path: `tests/reports/ellipse-final-${info.project.name}.png`,
  });
  // A hand-added position retains the image's reference size. No recalibration
  // on edits, mode changes or undo can make the remaining marks change size.
  await page.locator("[data-mode=add]").click();
  await page.locator("#image-canvas").click({ position: { x: 30, y: 30 } });
  await expect(page.locator("#count")).toHaveText(String(count + 1));
  const edited = await page
    .locator("#image-canvas")
    .evaluate((c) => (window as any).markerTrace(c));
  expect(edited).toHaveLength(count + 1);
  expect(edited.at(-1).slice(2, 4)).toEqual(markers[0].slice(2, 4));
  await page.locator("#undo").click();
  await expect(page.locator("#count")).toHaveText(String(count));
});
