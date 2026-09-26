import { features, near, type Target } from "./learning";
import type { Analysis, Detection, Raster, ROI } from "./types";

// Supervised, bounded radial-basis classifier. Its learned centres are appearance
// statistics, not image crops, coordinates, filenames or a replay dataset.
export type Kind = "keep" | "add" | "remove";
export type Unit = {
  mean: number[];
  mass: number;
  kind: Kind;
  width: number;
  height: number;
};
export type LocalModel = {
  version: 1;
  target: Target;
  units: Unit[];
  updates: number;
};
export const emptyModel = (target: Target): LocalModel => ({
  version: 1,
  target,
  units: [],
  updates: 0,
});
export const distance = (a: number[], b: number[]) =>
  Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);
export function validModel(m: unknown): m is LocalModel {
  const v = m as LocalModel;
  return (
    !!v &&
    v.version === 1 &&
    ["pill", "bottle"].includes(v.target) &&
    Number.isFinite(v.updates) &&
    Array.isArray(v.units) &&
    v.units.length <= 96 &&
    v.units.every(
      (u) =>
        ["keep", "add", "remove"].includes(u.kind) &&
        u.mean?.length === 18 &&
        u.mean.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) &&
        Number.isFinite(u.mass) &&
        u.mass > 0 &&
        Number.isFinite(u.width) &&
        u.width > 0 &&
        u.width <= 1 &&
        Number.isFinite(u.height) &&
        u.height > 0 &&
        u.height <= 1,
    )
  );
}
function updateUnit(units: Unit[], sample: Unit) {
  const match = units
    .filter((u) => u.kind === sample.kind)
    .sort(
      (a, b) => distance(a.mean, sample.mean) - distance(b.mean, sample.mean),
    )[0];
  if (match && distance(match.mean, sample.mean) < 0.035) {
    const rate = sample.mass / (Math.min(20, match.mass) + sample.mass);
    match.mean = match.mean.map((v, i) => v + rate * (sample.mean[i] - v));
    match.width += rate * (sample.width - match.width);
    match.height += rate * (sample.height - match.height);
    match.mass = Math.min(20, match.mass + sample.mass);
  } else units.push(structuredClone(sample));
  // Equal quotas prevent hundreds of accepted tablets from erasing corrections.
  for (const kind of ["keep", "add", "remove"] as Kind[]) {
    const same = units.filter((u) => u.kind === kind);
    if (same.length > 32) {
      const weakest = same.reduce((a, b) => (a.mass <= b.mass ? a : b));
      units.splice(units.indexOf(weakest), 1);
    }
  }
}
export function mergeModels(base: LocalModel, learned: LocalModel): LocalModel {
  if (base.target !== learned.target) throw Error("Different learning targets");
  const result = structuredClone(base);
  for (const unit of learned.units) updateUnit(result.units, unit);
  result.updates += learned.updates;
  return result;
}
const inside = (b: ROI, r: ROI) =>
  b.x >= r.x &&
  b.y >= r.y &&
  b.x + b.width <= r.x + r.width &&
  b.y + b.height <= r.y + r.height;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export function learnCorrections(
  image: Raster,
  automatic: Detection[],
  corrected: Detection[],
  roi: ROI,
  target: Target,
): LocalModel {
  const model = emptyModel(target),
    currentIDs = new Set(corrected.map((d) => d.id));
  const retained = corrected.filter((d) => d.source !== "manual");
  const width = median(retained.map((d) => d.box.width)),
    height = median(retained.map((d) => d.box.height));
  const added = corrected
    .filter((d) => d.source === "manual")
    .map((d) => ({
      ...d,
      box:
        width && height
          ? {
              x: d.center.x - width / 2,
              y: d.center.y - height / 2,
              width,
              height,
            }
          : d.box,
    }));
  const removed = automatic.filter(
    (d) =>
      !currentIDs.has(d.id) &&
      !corrected.some(
        (c) =>
          near(c, d) ||
          (c.center.x >= d.box.x &&
            c.center.x <= d.box.x + d.box.width &&
            c.center.y >= d.box.y &&
            c.center.y <= d.box.y + d.box.height),
      ),
  );
  for (const [kind, items] of [
    ["keep", retained],
    ["add", added],
    ["remove", removed],
  ] as [Kind, Detection[]][]) {
    // A dense image contributes at most 96 observations of each type.
    const step = Math.max(1, Math.ceil(items.length / 96));
    for (let i = 0; i < items.length; i += step) {
      const d = items[i];
      if (d.box.width < 4 || d.box.height < 4 || !inside(d.box, roi)) continue;
      updateUnit(model.units, {
        mean: features(image, d.box),
        mass: 1,
        kind,
        width: d.box.width / image.width,
        height: d.box.height / image.height,
      });
    }
  }
  model.updates = model.units.length ? 1 : 0;
  return model;
}
function nearest(model: LocalModel, x: number[], kinds: Kind[]) {
  return model.units
    .filter((u) => kinds.includes(u.kind))
    .reduce((n, u) => Math.min(n, distance(x, u.mean)), Infinity);
}
export function decision(model: LocalModel, x: number[]) {
  const positive = nearest(model, x, ["keep", "add"]),
    negative = nearest(model, x, ["remove"]),
    addition = nearest(model, x, ["add"]);
  return {
    remove: negative < 0.027 && negative + 0.012 < positive,
    add: addition < 0.022 && addition + 0.012 < negative,
    quality: addition,
  };
}
/** Only learned appearance close to a correction changes a count. Unknown
 * appearance falls through to the foundation detector. No saved coordinates. */
export function applyLearning(
  image: Raster,
  result: Analysis,
  model?: LocalModel,
): Analysis {
  if (!model || !validModel(model) || !model.units.length) return result;
  const kept = result.detections.filter(
    (d) => !decision(model, features(image, d.box)).remove,
  );
  const removed = result.detections.length - kept.length;
  const proposals: { d: Detection; q: number }[] = [];
  const occupied = (d: Detection) =>
    kept.some(
      (k) =>
        near(d, k) ||
        (k.center.x >= d.box.x &&
          k.center.x <= d.box.x + d.box.width &&
          k.center.y >= d.box.y &&
          k.center.y <= d.box.y + d.box.height),
    );
  const consider = (d: Detection) => {
    if (!inside(d.box, result.roi) || occupied(d)) return;
    const s = decision(model, features(image, d.box));
    if (s.add) proposals.push({ d, q: s.quality });
  };
  for (const d of [
    ...(result.candidates || []),
    ...(result.rejectedCandidates || []),
  ])
    consider(d);
  // Scan only at sizes actually learned from manual additions; bounded work in
  // the vision worker also recovers a miss absent from the original proposals.
  const sizes = model.units.filter((u) => u.kind === "add").slice(-8);
  let samples = 0;
  scan: for (const u of sizes) {
    const w = Math.max(6, u.width * image.width),
      h = Math.max(6, u.height * image.height);
    const stride = Math.max(
      4,
      Math.min(w, h) * 0.25,
      Math.sqrt((result.roi.width * result.roi.height * sizes.length) / 9000),
    );
    for (
      let y = result.roi.y + h / 2;
      y <= result.roi.y + result.roi.height - h / 2;
      y += stride
    )
      for (
        let x = result.roi.x + w / 2;
        x <= result.roi.x + result.roi.width - w / 2;
        x += stride
      ) {
        if (++samples > 10000) break scan;
        consider({
          id: "",
          center: { x, y },
          box: { x: x - w / 2, y: y - h / 2, width: w, height: h },
          area: w * h,
          contour: [],
          source: "ai",
          flags: [],
        });
      }
  }
  for (const { d } of proposals.sort((a, b) => a.q - b.q))
    if (!occupied(d))
      kept.push({
        ...d,
        id: `learned-${kept.length + 1}`,
        source: "ai",
        flags: [...d.flags, "端末内の補正学習で追加"],
      });
  const added = kept.length - (result.detections.length - removed);
  return {
    ...result,
    detections: kept
      .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x)
      .map((d, i) => ({ ...d, id: `result-${i + 1}` })),
    diagnostics: [
      ...result.diagnostics,
      `自動学習 ${model.updates}回：追加 ${added}・除外 ${removed}`,
    ],
    learning: { updates: model.updates, added, removed },
  };
}
