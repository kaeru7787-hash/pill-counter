import { test } from "node:test";
import assert from "node:assert/strict";
import {
  examplesFrom,
  features,
  train,
  score,
  suggest,
  type LearningRecord,
} from "../src/learning";
import type { Detection, Raster } from "../src/types";
const d = (
  id: string,
  x = 40,
  source: Detection["source"] = "cv",
): Detection => ({
  id,
  center: { x, y: 40 },
  box: { x: x - 10, y: 30, width: 20, height: 20 },
  source,
  contour: [],
  area: 300,
  flags: [],
});
const image: Raster = {
  width: 120,
  height: 80,
  data: new Uint8ClampedArray(120 * 80 * 4).fill(200),
};
const roi = { x: 0, y: 0, width: 120, height: 80 };
const records = (count = 4): LearningRecord[] =>
  Array.from({ length: count }, (_, g) => ({
    schemaVersion: 1,
    id: `photo-${g}`,
    imageHash: `hash-${g}`,
    group: `group-${g}`,
    target: "pill",
    createdAt: "",
    appVersion: "test",
    algorithm: "test",
    width: 120,
    height: 80,
    roi,
    masks: [],
    image: new ArrayBuffer(0),
    totalCount: 6,
    confirmed: true,
    centers: [],
    removed: [],
    examples: Array.from({ length: 9 }, (_, i) => ({
      x: Array(18).fill((i < 6 ? 0.8 : 0.2) + g * 0.002),
      y: i < 6 ? 1 : 0,
      center: { x: i, y: 2 },
      box: roi,
      kind: i < 6 ? "confirmed" : "background",
    })),
  }));
test("only explicitly classified background is negative; duplicates never are", () => {
  const positive = d("positive"),
    added = d("added", 75, "manual"),
    duplicate = d("duplicate", 41),
    background = d("background", 98);
  const items = examplesFrom(
    image,
    [positive, added],
    [duplicate, background],
    { duplicate: "background" },
    [],
    roi,
  );
  assert.equal(items.length, 2);
  assert.equal(items[1].kind, "added");
  const withBackground = examplesFrom(
    image,
    [positive],
    [duplicate, background],
    { duplicate: "background", background: "background" },
    [],
    roi,
  );
  assert.deepEqual(
    withBackground.map((e) => e.y),
    [1, 0],
  );
});
test("redaction excludes entire sampling windows and ROI edges", () => {
  const items = examplesFrom(
    image,
    [d("one"), d("two", 75), d("edge", 5)],
    [],
    {},
    [{ x: 25, y: 25, width: 30, height: 30 }],
    roi,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].center.x, 75);
  assert.equal(features(image, d("x").box).length, 18);
});
test("few photographs or a single class never activate a model", () => {
  assert.equal(train(records(3), "pill").model, undefined);
  const oneClass = records().map((r) => ({
    ...r,
    examples: r.examples.filter((e) => e.y),
  }));
  assert.equal(train(oneClass, "pill").model, undefined);
  assert.equal(train(records(), "bottle").model, undefined);
});
test("model really learns appearance and passes held-out photograph evaluation", () => {
  const { model, report } = train(records(), "pill");
  assert.equal(report.eligible, true);
  assert.ok(model);
  assert.equal(report.wrong, 0);
  assert.ok(score(model, Array(18).fill(0.8)) >= 0.9);
  assert.ok(score(model, Array(18).fill(0.2)) <= 0.1);
  assert.equal(score(model, Array(18).fill(100)), 0.5);
});
test("repeat submissions of one photo cannot satisfy independent group minimum", () => {
  const copies = records().map((r) => ({ ...r, imageHash: "same-photo" }));
  assert.equal(train(copies, "pill").report.groups, 1);
  assert.equal(train(copies, "pill").model, undefined);
});
test("inconsistent labels fail the deployment gate and cannot worsen automatic counts", () => {
  const rows = records();
  rows[3].examples.forEach((e) => (e.y = e.y ? 0 : 1));
  const result = train(rows, "pill");
  assert.equal(result.model, undefined);
  assert.equal(result.report.eligible, false);
  const { model } = train(records(), "pill");
  const detections = [d("one")],
    before = JSON.stringify(detections);
  suggest(model!, image, detections, [d("candidate", 80)]);
  assert.equal(JSON.stringify(detections), before);
});
