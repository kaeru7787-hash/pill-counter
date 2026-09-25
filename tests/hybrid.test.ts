import { test } from "node:test";
import assert from "node:assert/strict";
import { fuse } from "../src/ai/fusion";
import { reviewRegions } from "../src/ai/refinement";
import type { Detection, Raster } from "../src/types";
import type { AICandidate } from "../src/ai/onnxDetector";

const pill = (x: number, size = 40): Detection => ({
  id: `p-${x}`,
  center: { x, y: 80 },
  box: { x: x - size / 2, y: 80 - size / 2, width: size, height: size },
  area: Math.PI * (size / 2) ** 2,
  source: "cv",
  flags: [],
  contour: [],
  shape: {
    circularity: 0.9,
    solidity: 0.98,
    aspect: 1,
    perimeter: Math.PI * size,
  },
});
const ai = (d: Detection, view: string): AICandidate => ({
  ...d,
  source: "ai",
  score: 0.9,
  view,
  area: d.box.width * d.box.height,
  shape: undefined,
});
const pills = Array.from({ length: 8 }, (_, i) => pill(60 + i * 60));
const infer = (cv: Detection[], references = pills) =>
  fuse(
    cv,
    references.map((d) => ai(d, "full")),
    references.map((d) => ai(d, "tile")),
  );

test("background speck removed without deleting an unsupported normal pill", () => {
  const small = pill(700, 6),
    normal = pill(760);
  const result = infer([...pills, small, normal]);
  assert.equal(result.detections.length, 9);
  assert.ok(result.detections.includes(normal));
  assert.deepEqual(
    result.rejected.map((d) => d.id),
    [small.id],
  );
  assert.equal(result.requiresReview, true);
});
test("irregular elongated tray mark is rejected using the image reference", () => {
  const mark = {
    ...pill(700),
    shape: { circularity: 0.35, solidity: 0.7, aspect: 3, perimeter: 250 },
  };
  assert.equal(infer([...pills, mark]).detections.length, 8);
});
test("AI absence alone never rejects a normal-sized candidate", () => {
  const extra = pill(700);
  assert.ok(infer([...pills, extra]).detections.includes(extra));
  assert.equal(fuse([extra], [], []).detections.length, 1);
});
test("mixed pill sizes disable majority-size rejection", () => {
  const refs = [
    ...pills.slice(0, 4),
    ...pills.slice(4).map((d) => pill(d.center.x, 90)),
  ];
  const small = pill(800, 12),
    r = infer([...refs, small], refs);
  assert.equal(r.profile.uniform, false);
  assert.ok(r.detections.includes(small));
});
test("AI-supported reflection fragment keeps the pill counted", () => {
  const fragment = {
    ...pills[0],
    area: pills[0].area * 0.2,
    shape: { ...pills[0].shape!, circularity: 0.3 },
  };
  const r = infer([fragment, ...pills.slice(1)]);
  assert.equal(r.detections.length, 8);
  assert.equal(r.rejected.length, 0);
});
test("local refinement has a fixed budget and stays within explicit ROI", () => {
  const image: Raster = {
    width: 1000,
    height: 800,
    data: new Uint8ClampedArray(1000 * 800 * 4),
  };
  const roi = { x: 100, y: 100, width: 600, height: 500 };
  const candidates = Array.from({ length: 12 }, (_, i) =>
    ai(
      {
        ...pill(150 + (i % 4) * 140),
        center: { x: 150 + (i % 4) * 140, y: 150 + Math.floor(i / 4) * 140 },
      },
      "full",
    ),
  );
  candidates.forEach((d) => (d.score = 0.3));
  const regions = reviewRegions(image, roi, candidates, []);
  assert.ok(regions.length > 0 && regions.length <= 3);
  for (const r of regions) {
    assert.ok(r.x >= roi.x && r.y >= roi.y);
    assert.ok(
      r.x + r.width <= roi.x + roi.width &&
        r.y + r.height <= roi.y + roi.height,
    );
  }
});
