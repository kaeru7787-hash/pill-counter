import test from "node:test";
import { positionMetrics } from "../src/vision/positionMetrics";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import sharp from "sharp";
import { analyze, clampROI } from "../src/vision/pipeline";
import { confidence, spatialAgreement } from "../src/vision/ensemble";
import { metrics } from "../src/vision/metrics";
import { decodeYolo } from "../src/ai/onnxDetector";
import type { Detection } from "../src/types";
function fixture(file: string) {
  const p = PNG.sync.read(readFileSync(`tests/images/${file}.png`));
  return {
    width: p.width,
    height: p.height,
    data: new Uint8ClampedArray(p.data),
  };
}
test("disagreement, unstable locations and artifacts must require review", () => {
  assert.equal(confidence({ A: 48, B: 52, C: 50 }, 1, []).level, "review");
  assert.equal(confidence({ A: 50, B: 50, C: 50 }, 0.8, []).level, "review");
  assert.equal(
    confidence({ A: 50, B: 50, C: 50 }, 1, ["reflection"]).level,
    "review",
  );
  assert.equal(confidence({ A: 0, B: 0, C: 0 }, 1, []).level, "review");
  assert.equal(confidence({ A: 50, B: 50, C: 50 }, 1, []).level, "medium");
  assert.equal(
    confidence({ A: 50, B: 50, C: 50, AI: 50 }, 1, [], 1).level,
    "high",
  );
  assert.equal(
    confidence({ A: 50, B: 51, C: 50, AI: 50 }, 1, [], 1).level,
    "medium",
  );
});
test("metrics include errors on review cases and exclude zero truth from MAPE only", () => {
  const m = metrics([
    { truth: 0, predicted: 1 },
    { truth: 10, predicted: 9 },
    { truth: 10, predicted: 10 },
  ]);
  assert.equal(m.exactCountAccuracy, 1 / 3);
  assert.equal(m.meanAbsoluteError, 2 / 3);
  assert.equal(m.meanAbsolutePercentageError, 0.05);
  assert.equal(m.withinOneAccuracy, 1);
});
test("spatial agreement is one-to-one", () => {
  const d = { center: { x: 10, y: 10 }, area: 100 } as Detection;
  assert.equal(spatialAgreement([d, d], [d]), 0.5);
});
test("ROI is clamped to image dimensions", () => {
  assert.deepEqual(
    clampROI({ x: -3, y: 98, width: 500, height: 100 }, 100, 100),
    { x: 0, y: 97, width: 100, height: 3 },
  );
});
test("YOLO boxes undo letterboxing, apply NMS and validate shape", () => {
  const config = {
    format: "yolov8-detect" as const,
    inputSize: 640,
    classes: 1,
    scoreThreshold: 0.5,
    iouThreshold: 0.45,
  };
  const output = new Float32Array([
    320, 321, 320, 321, 100, 100, 80, 80, 0.9, 0.8,
  ]);
  const ds = decodeYolo(output, [1, 5, 2], config, 2, 0, 160, {
    x: 10,
    y: 20,
    width: 320,
    height: 160,
  });
  assert.equal(ds.length, 1);
  assert.equal(ds[0].center.x, 170);
  assert.equal(ds[0].center.y, 100);
  assert.throws(() =>
    decodeYolo(output, [1, 2, 5], config, 1, 0, 0, {
      x: 0,
      y: 0,
      width: 640,
      height: 640,
    }),
  );
});
test("separated white tablets have numbered contour candidates", async () => {
  const r = await analyze(fixture("01-white-separated"), {
    scene: "tray",
    autoROI: false,
    debug: true,
  });
  assert.equal(r.detections.length, 24);
  assert.ok(r.detections.every((d) => d.contour.length > 3));
  assert.ok(r.debug.Watershed);
  assert.notEqual(r.confidence.level, "high");
});
test("touching pair is separated by watershed", async () => {
  const r = await analyze(fixture("04-touching-pairs"), {
    scene: "tray",
    autoROI: false,
    debug: false,
  });
  assert.equal(r.detections.length, 4);
  assert.equal(r.counts.A, 2);
  assert.equal(r.confidence.level, "review");
});
test("three touching tablets split into three supported lobes", async () => {
  const r = await analyze(fixture("05-touching-three"), {
    scene: "tray",
    autoROI: false,
    debug: false,
  });
  assert.equal(r.detections.length, 3);
  assert.equal(r.confidence.level, "review");
});
test("counts survive image scale changes including the maximum analysis size", async () => {
  for (const width of [320, 1280]) {
    const { data, info } = await sharp("tests/images/01-white-separated.png")
      .resize(width)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const r = await analyze(
      {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data),
      },
      { scene: "tray", autoROI: false, debug: false },
    );
    assert.equal(r.detections.length, 24, `width ${width}`);
  }
});
test("capsules remain one object each", async () => {
  const r = await analyze(fixture("03-capsules"), {
    scene: "tray",
    autoROI: false,
    debug: false,
  });
  assert.equal(r.detections.length, 12);
});
test("ROI excludes tablets outside selected region", async () => {
  const r = await analyze(fixture("01-white-separated"), {
    scene: "tray",
    autoROI: false,
    debug: false,
    roi: { x: 15, y: 15, width: 165, height: 70 },
  });
  assert.equal(r.detections.length, 2);
  assert.ok(r.detections.every((d) => d.center.x < 180));
});
test("bag and empty photos never get confident confirmation", async () => {
  for (const name of ["09-bag-artifacts", "13-empty"]) {
    const r = await analyze(fixture(name), {
      scene: name.includes("bag") ? "bag" : "tray",
      autoROI: false,
      debug: false,
    });
    assert.equal(r.confidence.level, "review");
  }
});

test("position evaluation prevents FP and FN cancellation and reassigns ambiguous matches", async () => {
  const p = positionMetrics(
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ],
    2,
  );
  assert.equal(p.tp, 1);
  assert.equal(p.fp, 1);
  assert.equal(p.fn, 1);
  const q = positionMetrics(
    [
      { x: 4, y: 0 },
      { x: 0, y: 0 },
    ],
    [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
    ],
    5,
  );
  assert.equal(q.tp, 2);
});
test("real tray is scale-stable and manual ROI debug retains image coordinates", async () => {
  const { data, info } = await sharp("tests/images/18-real-tray.jpg")
    .resize({ height: 1280 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
  const r = await analyze(image, {
    scene: "tray",
    autoROI: true,
    debug: false,
  });
  assert.equal(r.detections.length, 90);
  const roi = {
    x: info.width * 0.17,
    y: info.height * 0.24,
    width: info.width * 0.6,
    height: info.height * 0.43,
  };
  const m = await analyze(image, {
    scene: "tray",
    autoROI: false,
    debug: true,
    roi,
  });
  assert.equal(m.detections.length, 90);
  assert.deepEqual(m.debug.Threshold.origin, { x: 0, y: 0 });
  assert.ok(
    m.detections.every(
      (d) =>
        d.center.x >= roi.x &&
        d.center.x < roi.x + roi.width &&
        d.center.y >= roi.y &&
        d.center.y < roi.y + roi.height,
    ),
  );
});

test("colored pills respect a manual ROI and expose full-resolution debug layers", async () => {
  const { data, info } = await sharp("tests/images/19-bag-round.jpg")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const roi = { x: 380, y: 950, width: 490, height: 380 };
  const r = await analyze(
    {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    },
    { scene: "tray", autoROI: false, debug: true, roi },
  );
  assert.equal(r.detections.length, 12);
  assert.ok(r.algorithm?.includes("回転形状"));
  assert.equal(r.debug.Markers.width, info.width);
  assert.equal(r.debug.Watershed.height, info.height);
  assert.ok(
    r.detections.every(
      (d) =>
        d.center.x >= roi.x &&
        d.center.y >= roi.y &&
        d.center.x < roi.x + roi.width &&
        d.center.y < roi.y + roi.height,
    ),
  );
});
