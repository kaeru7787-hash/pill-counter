import { test } from "node:test";
import assert from "node:assert/strict";
import {
  learnCorrections,
  applyLearning,
  mergeModels,
  emptyModel,
  validModel,
} from "../src/autoLearning";
import { AutoLearningStore, MODEL_KEY } from "../src/autoLearningStore";
import type { Analysis, Detection, Raster } from "../src/types";
const d = (
  id: string,
  x: number,
  y: number,
  source: Detection["source"] = "cv",
): Detection => ({
  id,
  center: { x, y },
  box: { x: x - 10, y: y - 10, width: 20, height: 20 },
  contour: [],
  area: 314,
  source,
  flags: [],
});
function scene(offset = 0) {
  const image: Raster = {
    width: 160,
    height: 100,
    data: new Uint8ClampedArray(160 * 100 * 4),
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([25, 30, 35, 255], i);
  }
  for (const [cx, cy, color] of [
    [35 + offset, 35, 220],
    [90 + offset, 65, 220],
    [120 + offset, 25, 100],
  ]) {
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 160; x++)
        if (Math.hypot(x - cx, y - cy) < 9)
          image.data.set([color, color, color, 255], (y * 160 + x) * 4);
  }
  return image;
}
const analysis = (detections: Detection[]): Analysis => ({
  version: "test",
  width: 160,
  height: 100,
  roi: { x: 0, y: 0, width: 160, height: 100 },
  detections,
  counts: { A: 0, B: 0, C: 0 },
  confidence: { level: "review", reasons: [] },
  debug: {},
  diagnostics: [],
  elapsed: 0,
});
test("corrections train appearance parameters that change detection on a translated image", () => {
  const first = scene(),
    a = d("a", 35, 35),
    b = d("b", 90, 65, "manual"),
    bad = d("bad", 120, 25);
  const model = learnCorrections(
    first,
    [a, bad],
    [a, b],
    analysis([]).roi,
    "pill",
  );
  assert.ok(validModel(model));
  assert.equal(
    model.units.some((u) => u.kind === "add"),
    true,
  );
  assert.equal(
    model.units.some((u) => u.kind === "remove"),
    true,
  );
  const next = scene(5),
    result = analysis([d("a", 40, 35), d("bad", 125, 25)]);
  result.rejectedCandidates = [d("missing", 95, 65)];
  const output = applyLearning(next, result, model);
  assert.equal(output.learning?.removed, 1);
  assert.equal(output.learning?.added, 1);
  assert.equal(output.detections.length, 2);
  assert.ok(
    output.detections.some(
      (x) => Math.hypot(x.center.x - 95, x.center.y - 65) < 3,
    ),
  );
  assert.equal(result.detections.length, 2);
  const json = JSON.stringify(model);
  assert.ok(!json.includes("center"));
  assert.ok(!json.includes("image"));
  assert.ok(!json.includes("bad"));
});
test("a missing item can be recovered without an original proposal", () => {
  const img = scene(),
    a = d("a", 35, 35),
    b = d("b", 90, 65, "manual");
  const model = learnCorrections(img, [a], [a, b], analysis([]).roi, "pill");
  const output = applyLearning(img, analysis([a]), model);
  assert.equal(output.detections.length, 2);
  assert.equal(output.learning?.added, 1);
});
test("deleting a duplicate is not learned as background; unfinished ROI is excluded", () => {
  const a = d("a", 35, 35),
    duplicate = d("dup", 37, 35),
    edge = d("edge", 1, 1);
  const model = learnCorrections(
    scene(),
    [a, duplicate, edge],
    [a],
    analysis([]).roi,
    "pill",
  );
  assert.ok(model.units.every((u) => u.kind !== "remove"));
});
test("training is durable before exit, activated on finish/recovery, and undo replaces the current contribution", () => {
  const values = new Map<string, string>(),
    storage = {
      getItem: (k: string) => values.get(k) || null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
    };
  const store = new AutoLearningStore(storage),
    a = d("a", 35, 35),
    bad = d("bad", 120, 25),
    img = scene();
  const initial = learnCorrections(
    img,
    [a, bad],
    [a, bad],
    analysis([]).roi,
    "pill",
  );
  const edited = learnCorrections(img, [a, bad], [a], analysis([]).roi, "pill");
  store.stage("photo", edited);
  assert.equal(store.model("pill").updates, 0);
  new AutoLearningStore(storage).recover();
  assert.equal(store.model("pill").updates, 1);
  assert.ok(store.model("pill").units.some((u) => u.kind === "remove"));
  store.stage("photo", initial);
  store.finish("pill");
  assert.ok(store.model("pill").units.every((u) => u.kind !== "remove"));
  assert.equal(store.model("pill").updates, 0);
  store.finish("pill");
  assert.equal(store.model("pill").updates, 0);
  assert.equal(store.model("bottle").updates, 0);
  assert.equal(values.size, 1);
  assert.ok(values.has(MODEL_KEY + "pill"));
});
test("models remain bounded and wrong targets/corrupt data are rejected", () => {
  let model = emptyModel("pill");
  for (let i = 0; i < 200; i++)
    model = mergeModels(model, {
      version: 1,
      target: "pill",
      updates: 1,
      units: [
        {
          kind: "add",
          mean: Array(18).fill(i / 200),
          mass: 1,
          width: 0.1,
          height: 0.1,
        },
      ],
    });
  assert.ok(model.units.length <= 32);
  assert.ok(validModel(model));
  assert.throws(() => mergeModels(model, emptyModel("bottle")));
  assert.equal(
    validModel({ ...model, units: [{ ...model.units[0], mean: [NaN] }] }),
    false,
  );
  const store = new AutoLearningStore({
    getItem: () => "{bad",
    setItem: () => {},
  });
  assert.throws(() => store.recover());
});
test("storage failure does not claim completion or erase the last durable model", () => {
  const store = new AutoLearningStore({
    getItem: () => null,
    setItem: () => {
      throw Error("quota");
    },
  });
  assert.throws(() => store.stage("x", emptyModel("pill")), /quota/);
});

// Different exposure and object scale exercise generalization, not saved coordinates.
test("exposure changes preserve a learned removal without erasing accepted objects", () => {
  const a = d("a", 35, 35),
    bad = d("bad", 120, 25);
  const model = learnCorrections(
    scene(),
    [a, bad],
    [a],
    analysis([]).roi,
    "pill",
  );
  const next = scene(5);
  for (let i = 0; i < next.data.length; i++)
    if (i % 4 !== 3) next.data[i] += 20;
  const out = applyLearning(
    next,
    analysis([d("a", 40, 35), d("bad", 125, 25)]),
    model,
  );
  assert.equal(out.learning?.removed, 1);
  assert.equal(out.detections.length, 1);
});
test("untouched results are not counted as supervised corrections", () => {
  const a = d("a", 35, 35);
  const model = learnCorrections(scene(), [a], [a], analysis([]).roi, "pill");
  assert.equal(model.updates, 0);
  assert.equal(model.units.length, 0);
});
test("learned additions follow current object scale, without saved proposals", () => {
  const make = (scale: number) => {
    const im: Raster = {
      width: 220,
      height: 150,
      data: new Uint8ClampedArray(220 * 150 * 4),
    };
    for (let i = 0; i < im.data.length; i += 4)
      im.data.set([25, 30, 35, 255], i);
    const ds = [
      [40, 40],
      [110, 40],
      [180, 40],
      [110, 110],
    ].map(([x, y], i) => {
      for (let py = 0; py < 150; py++)
        for (let px = 0; px < 220; px++)
          if (Math.hypot(px - x, py - y) < 9 * scale)
            im.data.set([220, 220, 220, 255], (py * 220 + px) * 4);
      return {
        ...d(String(i), x, y),
        box: {
          x: x - 10 * scale,
          y: y - 10 * scale,
          width: 20 * scale,
          height: 20 * scale,
        },
      };
    });
    return { im, ds };
  };
  const first = make(1),
    next = make(1.4),
    roi = { x: 0, y: 0, width: 220, height: 150 };
  const model = learnCorrections(
    first.im,
    first.ds.slice(0, 3),
    first.ds.map((d, i) => (i === 3 ? { ...d, source: "manual" } : d)),
    roi,
    "pill",
  );
  const out = applyLearning(
    next.im,
    { ...analysis(next.ds.slice(0, 3)), width: 220, height: 150, roi },
    model,
  );
  assert.equal(out.detections.length, 4);
  assert.equal(out.learning?.added, 1);
  assert.ok(
    out.detections.some(
      (d) => Math.hypot(d.center.x - 110, d.center.y - 110) < 5,
    ),
  );
});
