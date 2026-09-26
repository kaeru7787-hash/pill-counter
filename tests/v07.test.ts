import { test } from "node:test";
import assert from "node:assert/strict";
import { fuse } from "../src/ai/fusion";
import { pixelReference, pixelRejection } from "../src/ai/pixelEvidence";
import { analyzeBottles } from "../src/vision/bottlePipeline";
import type { Detection, Raster } from "../src/types";
const disk = (x: number, y: number, r = 20): Detection => ({
  id: `${x}-${y}`,
  center: { x, y },
  box: { x: x - r, y: y - r, width: r * 2, height: r * 2 },
  area: Math.PI * r * r,
  contour: [],
  source: "cv",
  flags: [],
  shape: {
    circularity: 0.9,
    solidity: 0.98,
    aspect: 1,
    perimeter: 2 * Math.PI * r,
  },
});
function canvas(w = 640, h = 420): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([105, 105, 105, 255], i);
  return { width: w, height: h, data };
}
function draw(
  image: Raster,
  d: Detection,
  color = [220, 220, 215],
  stripe = false,
) {
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (Math.hypot(x - d.center.x, y - d.center.y) < d.box.width / 2) {
        const c = stripe && Math.abs(x - d.center.x) < 2 ? [90, 90, 90] : color;
        image.data.set([...c, 255], (y * image.width + x) * 4);
      }
}
const refs = Array.from({ length: 10 }, (_, i) => disk(45 + i * 55, 60));
test("shared pixel review rejects empty background even with repeated AI support", () => {
  const image = canvas();
  refs.forEach((d) => draw(image, d));
  const empty = disk(300, 220),
    real = disk(420, 220);
  draw(image, real, [220, 220, 215], true);
  const ai = (d: Detection, view: string) => ({
    ...d,
    source: "ai" as const,
    shape: undefined,
    view,
    score: 0.95,
    area: d.box.width * d.box.height,
  });
  const candidates = [...refs, empty, real];
  const r = fuse(
    candidates,
    candidates.map((d) => ai(d, "full")),
    candidates.map((d) => ai(d, "tile")),
    image,
  );
  assert.equal(r.detections.length, 11);
  assert.ok(
    !r.detections.some((d) => d.center.x === 300 && d.center.y === 220),
  );
  assert.ok(r.detections.some((d) => d.center.x === 420 && d.center.y === 220));
});
test("gap between existing pills does not become a rescued AI pill", () => {
  const image = canvas();
  refs.forEach((d) => draw(image, d));
  const left = disk(280, 220),
    right = disk(330, 220);
  draw(image, left);
  draw(image, right);
  const gap = { ...disk(305, 220, 19), source: "ai" as const };
  const p = pixelReference(image, refs);
  assert.ok(pixelRejection(image, gap, p, [left, right]).length > 0);
});
test("insufficient reference or mixed colors cannot enable a background veto", () => {
  const image = canvas();
  const p = pixelReference(image, refs.slice(0, 2));
  assert.deepEqual(pixelRejection(image, disk(200, 200), p), []);
  refs.forEach((d, i) =>
    draw(image, d, i % 2 ? [230, 230, 230] : [200, 35, 35]),
  );
  const mixed = pixelReference(image, refs);
  assert.equal(mixed.ready, false);
  assert.deepEqual(pixelRejection(image, disk(200, 200), mixed), []);
});
test("colored cap counter ignores grey drawer circles and counts three cap colors", async () => {
  const image = canvas(800, 600);
  const caps = [
    disk(140, 150, 28),
    disk(350, 150, 28),
    disk(560, 150, 28),
    disk(140, 380, 28),
    disk(350, 380, 28),
    disk(560, 380, 28),
  ];
  const colors = [
    [245, 35, 35],
    [198, 210, 30],
    [25, 170, 190],
  ];
  caps.forEach((d, i) => {
    for (let y = d.center.y; y < d.center.y + 110; y++)
      for (let x = d.center.x - 24; x < d.center.x + 24; x++)
        image.data.set(
          [...colors[i % 3].map((v) => Math.round(v * 0.5)), 255],
          (y * image.width + x) * 4,
        );
    draw(image, d, colors[i % 3]);
  });
  draw(image, disk(700, 270, 28), [220, 220, 220]);
  const r = await analyzeBottles(image, {
    target: "bottle",
    scene: "tray",
    autoROI: true,
    debug: false,
    useAI: true,
  });
  assert.equal(r.detections.length, 6);
  for (const p of caps)
    assert.ok(
      r.detections.some(
        (d) => Math.hypot(d.center.x - p.center.x, d.center.y - p.center.y) < 8,
      ),
    );
  const roi = await analyzeBottles(image, {
    target: "bottle",
    scene: "tray",
    autoROI: false,
    debug: false,
    roi: { x: 60, y: 60, width: 180, height: 430 },
  });
  assert.equal(roi.detections.length, 2);
});
