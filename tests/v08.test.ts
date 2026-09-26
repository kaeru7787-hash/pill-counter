import { test } from "node:test";
import assert from "node:assert/strict";
import { pixelReference, pixelRejection } from "../src/ai/pixelEvidence";
import { analyzeBottles } from "../src/vision/bottlePipeline";
import { repeatedCapRegions } from "../src/vision/capRegions";
import { recoverTiltedCaps } from "../src/vision/tiltedCaps";
import { getCV } from "../src/vision/opencv";
import type { Detection, Raster } from "../src/types";

function disk(x: number, y: number, r = 20): Detection {
  return {
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
  };
}
function raster(
  w: number,
  h: number,
  pixel: (x: number, y: number) => number[],
): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data.set([...pixel(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

test("bright soft reflection is rejected while a small sharp pill remains", () => {
  const refs = Array.from({ length: 10 }, (_, i) => disk(40 + i * 50, 50));
  const small = disk(350, 150, 12),
    glare = disk(200, 150, 13);
  glare.shape!.circularity = 0.68;
  const image = raster(550, 230, (x, y) => {
    if (
      [...refs, small].some(
        (d) => Math.hypot(x - d.center.x, y - d.center.y) < d.box.width / 2,
      )
    )
      return [225, 225, 225];
    const glow =
      105 + 120 * Math.exp(-(((x - 200) / 25) ** 2 + ((y - 150) / 14) ** 2));
    return [glow, glow, glow];
  });
  const reference = pixelReference(image, refs);
  assert.ok(pixelRejection(image, glare, reference).length);
  assert.deepEqual(pixelRejection(image, small, reference), []);
});

test("padded AI boxes retain dim round pills but reject empty gaps", () => {
  const refs = Array.from({ length: 10 }, (_, i) => disk(40 + i * 50, 50));
  const real = disk(140, 150),
    padded = { ...disk(140, 150, 34), source: "ai" as const };
  const empty = { ...disk(250, 150, 34), source: "ai" as const };
  const image = raster(550, 230, (x, y) => {
    if (refs.some((d) => Math.hypot(x - d.center.x, y - d.center.y) < 20))
      return [255, 205, 140];
    if (Math.hypot(x - real.center.x, y - real.center.y) < 20)
      return [230, 175, 110];
    return [100, 100, 100];
  });
  const reference = pixelReference(image, refs);
  assert.ok(reference.ready && reference.uniformSize);
  // The old perimeter-only test samples outside the real tablet and rejects it.
  assert.ok(
    pixelRejection(image, padded, { ...reference, uniformSize: false }).length,
  );
  assert.deepEqual(pixelRejection(image, padded, reference), []);
  assert.ok(pixelRejection(image, empty, reference).length);
});

test("adjacent rounded rectangular caps retain separate contours and ROI coordinates", async () => {
  const centers = Array.from({ length: 16 }, (_, i) => ({
    x: 90 + (i % 8) * 58,
    y: 95 + Math.floor(i / 8) * 110,
  }));
  const image = raster(620, 500, (x, y) => {
    for (const p of centers) {
      const dx = Math.max(Math.abs(x - p.x) - 13, 0),
        dy = Math.max(Math.abs(y - p.y) - 24, 0);
      if (dx * dx + dy * dy < 10 * 10) return [50, 157, 191];
    }
    return [105, 105, 105];
  });
  for (const roi of [undefined, { x: 55, y: 45, width: 350, height: 240 }]) {
    const result = await analyzeBottles(image, {
      target: "bottle",
      scene: "tray",
      autoROI: false,
      debug: true,
      roi,
    });
    const expected = roi ? centers.filter((p) => p.x < 390) : centers;
    assert.equal(result.detections.length, expected.length);
    for (const p of expected)
      assert.equal(
        result.detections.filter(
          (d) => Math.hypot(p.x - d.center.x, p.y - d.center.y) < 5,
        ).length,
        1,
      );
    assert.ok(result.detections.every((d) => d.box.height > d.box.width * 1.3));
  }
});

test("one elongated outlier cannot replace a repeated round cap family", () => {
  const objects = Array.from({ length: 12 }, (_, i) => disk(i * 50 + 30, 50));
  objects[0].shape!.aspect = 1.7;
  const views = objects.flatMap((d) =>
    [105, 125, 145].map((threshold) => ({ detection: d, threshold })),
  );
  assert.equal(repeatedCapRegions(views).enabled, false);
});

test("a colored seal without an elliptical cap rim cannot add a bottle", async () => {
  const { cv } = await getCV();
  const image = raster(240, 240, (x, y) =>
    Math.abs(x - 120) < 5 && Math.abs(y - 120) < 5
      ? [240, 30, 30]
      : [40, 145, 180],
  );
  const rgba = cv.matFromImageData(image as ImageData),
    rgb = new cv.Mat(),
    gray = new cv.Mat(),
    hsv = new cv.Mat();
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    assert.deepEqual(
      recoverTiltedCaps(
        cv,
        gray,
        hsv,
        [disk(120, 120, 5)],
        30,
        (hsv.data[0] * Math.PI) / 90,
      ),
      [],
    );
  } finally {
    rgba.delete();
    rgb.delete();
    gray.delete();
    hsv.delete();
  }
});

test("local recovery finds an independently bounded tilted cap", async () => {
  const { cv } = await getCV();
  const image = raster(240, 240, (x, y) => {
    if (Math.hypot(x - 129, y - 120) < 4) return [240, 30, 30];
    if (((x - 120) / 28) ** 2 + ((y - 120) / 17) ** 2 < 1)
      return [20, 190, 230];
    return [65, 65, 65];
  });
  const rgba = cv.matFromImageData(image as ImageData),
    rgb = new cv.Mat(),
    gray = new cv.Mat(),
    hsv = new cv.Mat();
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const result = recoverTiltedCaps(
      cv,
      gray,
      hsv,
      [disk(129, 120, 4)],
      30,
      (hsv.data[(120 * 240 + 115) * 3] * Math.PI) / 90,
    );
    assert.equal(result.length, 1);
    assert.ok(
      Math.hypot(result[0].center.x - 120, result[0].center.y - 120) < 3,
    );
  } finally {
    rgba.delete();
    rgb.delete();
    gray.delete();
    hsv.delete();
  }
});
