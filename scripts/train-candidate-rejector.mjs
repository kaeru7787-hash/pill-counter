// Experimental shape/appearance logistic classifier. Not deployed: held-out positives were rejected.
import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  referenceProfile,
  candidateFeatures,
  associated,
  anomalyReasons,
} from "../.runtime/src/ai/candidateReview.js";
import { fuse } from "../.runtime/src/ai/fusion.js";
import { positionMetrics } from "../.runtime/src/vision/positionMetrics.js";
const gt = JSON.parse(readFileSync("tests/ground-truth.json"));
const rows = [];
const group = (f) => {
  let n = parseInt(f);
  return n === 18
    ? "white90"
    : [19, 21, 23].includes(n)
      ? "yellow12"
      : [20, 22, 24].includes(n)
        ? "oblong36"
        : [25, 26].includes(n)
          ? "yellow86"
          : [27, 28].includes(n)
            ? "pale28"
            : [29, 30].includes(n)
              ? "white56"
              : "white70";
};
for (const file of Object.keys(gt).filter((f) => parseInt(f) >= 18)) {
  const r = JSON.parse(
      readFileSync("tests/reports/ensemble/" + file + ".json"),
    ),
    a = JSON.parse(
      readFileSync("tests/annotations/" + file.replace(/\.[^.]+$/, ".json")),
    );
  const { data, info } = await sharp("tests/images/" + file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, data };
  const p = referenceProfile(r.cv, r.stable, image),
    truth = a.centers.map(([x, y]) => ({
      x: (x * r.width) / a.width,
      y: (y * r.height) / a.height,
    }));
  // Correct duplicates are handled by fusion; negative examples here are only background regions away from EVERY annotated pill.
  for (const d of r.cv) {
    const nearest = Math.min(
      ...truth.map((t) => Math.hypot(t.x - d.center.x, t.y - d.center.y)),
    );
    const positive = nearest < (a.tolerance * r.width) / a.width;
    const boundary = nearest < ((a.tolerance * r.width) / a.width) * 1.5;
    if (!positive && boundary) continue;
    rows.push({
      file,
      group: group(file),
      id: d.id,
      x: candidateFeatures(d, p, image),
      y: positive ? 1 : 0,
      supported: r.stable.some((a) => associated(d, a)),
      anomalies: anomalyReasons(d, p, image).length,
    });
  }
}
const train = (rs) => {
  const k = rs[0].x.length,
    mean = Array.from(
      { length: k },
      (_, i) => rs.reduce((s, r) => s + r.x[i], 0) / rs.length,
    ),
    sd = mean.map((m, i) =>
      Math.max(
        0.01,
        Math.sqrt(rs.reduce((s, r) => s + (r.x[i] - m) ** 2, 0) / rs.length),
      ),
    );
  const w = Array(k).fill(0);
  let b = 0;
  const pos = rs.filter((r) => r.y).length,
    neg = rs.length - pos;
  for (let epoch = 0; epoch < 2400; epoch++) {
    const dw = Array(k).fill(0);
    let db = 0;
    for (const r of rs) {
      const x = r.x.map((v, i) => (v - mean[i]) / sd[i]);
      const z = b + x.reduce((s, v, i) => s + v * w[i], 0);
      const err = 1 / (1 + Math.exp(-z)) - r.y;
      const weight = rs.length / (2 * (r.y ? pos : neg));
      db += err * weight;
      for (let i = 0; i < k; i++) dw[i] += err * x[i] * weight;
    }
    b -= (0.05 * db) / rs.length;
    for (let i = 0; i < k; i++)
      w[i] -= 0.05 * (dw[i] / rs.length + 0.005 * w[i]);
  }
  return {
    version: 1,
    features: [
      "logRelativeArea",
      "circularity",
      "solidity",
      "logAspect",
      "fill",
      "colorDistance",
      "texture",
    ],
    mean,
    sd,
    weights: w,
    bias: b,
  };
};
const score = (m, x) =>
  1 /
  (1 +
    Math.exp(
      -(
        m.bias +
        x.reduce((s, v, i) => s + ((v - m.mean[i]) / m.sd[i]) * m.weights[i], 0)
      ),
    ));
const folds = [];
for (const g of [...new Set(rows.map((r) => r.group))]) {
  const trainRows = rows.filter((r) => r.group !== g);
  if (!trainRows.some((r) => !r.y)) continue;
  const m = train(trainRows),
    test = rows.filter((r) => r.group === g);
  let rejectedPos = 0,
    rejectedNeg = 0;
  for (const r of test) {
    r.heldOutScore = score(m, r.x);
    const reject = !r.supported && r.anomalies > 0 && r.heldOutScore < 0.1;
    if (reject) {
      if (r.y) rejectedPos++;
      else rejectedNeg++;
    }
  }
  folds.push({
    group: g,
    positive: test.filter((r) => r.y).length,
    negative: test.filter((r) => !r.y).length,
    rejectedPos,
    rejectedNeg,
  });
}
const model = train(rows);
mkdirSync("tests/reports/rejector-training", { recursive: true });
writeFileSync(
  "tests/reports/rejector-training/model.json",
  JSON.stringify(model, null, 2),
);
writeFileSync(
  "tests/reports/rejector-training/examples.json",
  JSON.stringify(rows, null, 2),
);
writeFileSync(
  "tests/reports/rejector-training/folds.json",
  JSON.stringify(folds, null, 2),
);
console.log(JSON.stringify(folds, null, 2));
console.log(
  "examples",
  rows.length,
  "positive",
  rows.filter((r) => r.y).length,
  "negative",
  rows.filter((r) => !r.y).length,
);
console.log(
  "remaining new",
  rows
    .filter((r) => parseInt(r.file) >= 27 && !r.y)
    .map((r) => [
      r.file,
      r.id,
      r.anomalies,
      score(model, r.x).toFixed(3),
      r.supported,
    ]),
);
