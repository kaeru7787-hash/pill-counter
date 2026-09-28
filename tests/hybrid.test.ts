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

test("AI box shifted inside an already matched complete optical contour is not counted twice", () => {
  const cv = pills.map((d) => ({
    ...d,
    contour: Array.from({ length: 32 }, (_, i) => ({
      x: d.center.x + 20 * Math.cos((i * Math.PI) / 16),
      y: 80 + 20 * Math.sin((i * Math.PI) / 16),
    })),
  }));
  const shifted = pill(cv[0].center.x + 19);
  const missing = pill(700);
  const refs = [...cv, shifted, missing];
  const result = infer(cv, refs);
  assert.equal(result.detections.length, 9);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].center.x, 700);
  assert.ok(
    result.rejected.some((d) =>
      d.flags.includes("検出済み輪郭の内部にある重複候補"),
    ),
  );
});

test("shifted long-tablet views and imperfect optical contour count once", () => {
  const c: Detection = {
    ...pill(100),
    center: { x: 100, y: 50 },
    box: { x: 70, y: 40, width: 60, height: 20 },
    area: 900,
    contour: [
      { x: 70, y: 40 },
      { x: 130, y: 40 },
      { x: 130, y: 60 },
      { x: 70, y: 60 },
    ],
    shape: { solidity: 0.85, circularity: 0.55, aspect: 3, perimeter: 140 },
  };
  const shifted = { ...c, center: { x: 112, y: 50 }, box: { ...c.box, x: 82 } };
  assert.equal(
    fuse([c], [ai(shifted, "full")], [ai(shifted, "tile")]).detections.length,
    1,
  );
  const shiftedAgain = {
    ...c,
    center: { x: 118, y: 50 },
    box: { ...c.box, x: 88 },
  };
  const candidates = [c, shiftedAgain];
  assert.equal(
    fuse(
      [],
      candidates.map((d) => ai(d, "full")),
      candidates.map((d) => ai(d, "tile")),
    ).detections.length,
    1,
  );
});

test("neighboring long tablets survive while merged optical regions yield to AI instances", () => {
  const refs = Array.from(
    { length: 8 },
    (_, i): Detection => ({
      ...pill(60 + i * 75),
      box: { x: 30 + i * 75, y: 70, width: 60, height: 20 },
      area: 1000,
      shape: { solidity: 0.98, circularity: 0.6, aspect: 3, perimeter: 140 },
    }),
  );
  const neighbors = [
    ...refs,
    {
      ...refs[0],
      id: "lower",
      center: { x: 60, y: 105 },
      box: { x: 30, y: 95, width: 60, height: 20 },
    },
  ];
  const merged: Detection = {
    ...refs[0],
    id: "merged",
    center: { x: 60, y: 92 },
    box: { x: 30, y: 70, width: 60, height: 45 },
    area: 1900,
    contour: [
      { x: 30, y: 70 },
      { x: 90, y: 70 },
      { x: 90, y: 115 },
      { x: 30, y: 115 },
    ],
    shape: { solidity: 0.9, circularity: 0.65, aspect: 1.3, perimeter: 220 },
  };
  const result = fuse(
    [
      ...refs.slice(1),
      {
        ...refs[7],
        id: "far",
        center: { x: 800, y: 80 },
        box: { x: 770, y: 70, width: 60, height: 20 },
      },
      merged,
    ],
    neighbors.map((d) => ai(d, "full")),
    neighbors.map((d) => ai(d, "tile")),
  );
  assert.ok(result.rejected.some((d) => d.id === "merged"));
  assert.ok(
    result.detections.some((d) => d.center.x === 60 && d.center.y === 80),
  );
  assert.ok(
    result.detections.some((d) => d.center.x === 60 && d.center.y === 105),
  );
});
