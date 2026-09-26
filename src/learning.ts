import type { Detection, Raster, ROI } from "./types";

export const LEARNING_VERSION = 1;
export type Target = "pill" | "bottle";
export type Example = {
  x: number[];
  y: 0 | 1;
  center: { x: number; y: number };
  box: ROI;
  kind: "confirmed" | "added" | "background";
};
export type LearningRecord = {
  schemaVersion: 1;
  id: string;
  imageHash: string;
  group: string;
  target: Target;
  createdAt: string;
  appVersion: string;
  algorithm: string;
  width: number;
  height: number;
  roi: ROI;
  masks: ROI[];
  image: ArrayBuffer;
  examples: Example[];
  centers: { x: number; y: number; kind: "confirmed" | "added" }[];
  removed: {
    center: { x: number; y: number };
    reason: "unknown" | "duplicate" | "background";
  }[];
  totalCount: number;
  confirmed: true;
};
export type Model = {
  version: 1;
  target: Target;
  mean: number[];
  sd: number[];
  weights: number[];
  bias: number;
  imageHashes: string[];
  trainedAt: string;
  report: TrainingReport;
};
export type TrainingReport = {
  eligible: boolean;
  reasons: string[];
  groups: number;
  positive: number;
  negative: number;
  correct: number;
  wrong: number;
  abstained: number;
  precision: number;
};
export const FEATURE_COUNT = 18;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/** Fixed pixel appearance features; sample boxes are NOT ground-truth object boundaries. */
export function features(image: Raster, box: ROI): number[] {
  const regions: number[][] = [[], [], []];
  const rgb = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const saturation = [0, 0, 0];
  for (let gy = -8; gy <= 8; gy++)
    for (let gx = -8; gx <= 8; gx++) {
      const radius = Math.hypot(gx, gy) / 8;
      if (radius > 1.35) continue;
      const region = radius < 0.45 ? 0 : radius < 0.9 ? 1 : 2;
      const px = clamp(
        Math.round(box.x + box.width / 2 + (gx * box.width) / 12),
        0,
        image.width - 1,
      );
      const py = clamp(
        Math.round(box.y + box.height / 2 + (gy * box.height) / 12),
        0,
        image.height - 1,
      );
      const p = (py * image.width + px) * 4;
      const values = [image.data[p], image.data[p + 1], image.data[p + 2]].map(
        (v) => v / 255,
      );
      values.forEach((v, c) => (rgb[region][c] += v));
      regions[region].push(values.reduce((a, b) => a + b, 0) / 3);
      saturation[region] += Math.max(...values) - Math.min(...values);
    }
  return regions.flatMap((values, i) => {
    const n = values.length,
      mean = values.reduce((a, b) => a + b, 0) / n;
    return [
      ...rgb[i].map((v) => v / n),
      Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n),
      saturation[i] / n,
      values.filter((v) => v > 0.94).length / n,
    ];
  });
}

export function intersects(a: ROI, b: ROI) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
export function samplingBox(box: ROI): ROI {
  return {
    x: box.x - box.width / 6,
    y: box.y - box.height / 6,
    width: (box.width * 4) / 3,
    height: (box.height * 4) / 3,
  };
}
export function near(a: Detection, b: Detection) {
  return (
    Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <
    Math.min(a.box.width, a.box.height, b.box.width, b.box.height) * 0.65
  );
}

export function examplesFrom(
  image: Raster,
  corrected: Detection[],
  removed: Detection[],
  reasons: Record<string, string>,
  masks: ROI[],
  roi: ROI,
) {
  const usable = (d: Detection) => {
    const b = samplingBox(d.box);
    return (
      b.width >= 4 &&
      b.height >= 4 &&
      b.x >= roi.x &&
      b.y >= roi.y &&
      b.x + b.width <= roi.x + roi.width &&
      b.y + b.height <= roi.y + roi.height &&
      !masks.some((m) => intersects(b, m))
    );
  };
  return [
    ...corrected
      .filter(usable)
      .map((d) => ({
        x: features(image, d.box),
        y: 1 as const,
        center: d.center,
        box: d.box,
        kind:
          d.source === "manual" ? ("added" as const) : ("confirmed" as const),
      })),
    ...removed
      .filter(
        (d) =>
          reasons[d.id] === "background" &&
          usable(d) &&
          !corrected.some((c) => near(c, d)),
      )
      .map((d) => ({
        x: features(image, d.box),
        y: 0 as const,
        center: d.center,
        box: d.box,
        kind: "background" as const,
      })),
  ];
}

type Row = Example & { group: string; imageHash: string };
function fit(rows: Row[]) {
  const mean = Array.from(
    { length: FEATURE_COUNT },
    (_, i) => rows.reduce((s, r) => s + r.x[i], 0) / rows.length,
  );
  const sd = mean.map((m, i) =>
    Math.max(
      0.04,
      Math.sqrt(rows.reduce((s, r) => s + (r.x[i] - m) ** 2, 0) / rows.length),
    ),
  );
  const weights = Array(FEATURE_COUNT).fill(0);
  let bias = 0;
  const positive = rows.filter((r) => r.y === 1).length,
    negative = rows.length - positive;
  // Give each photograph/class equal weight, so a dense tray cannot dominate.
  const sizes = new Map<string, number>();
  rows.forEach((r) =>
    sizes.set(
      `${r.imageHash}:${r.y}`,
      (sizes.get(`${r.imageHash}:${r.y}`) || 0) + 1,
    ),
  );
  const classes = [
    new Set(rows.filter((r) => !r.y).map((r) => r.imageHash)).size,
    new Set(rows.filter((r) => r.y).map((r) => r.imageHash)).size,
  ];
  if (!positive || !negative) throw new Error("正例と背景例の両方が必要です");
  for (let epoch = 0; epoch < 250; epoch++) {
    const gradient = Array(FEATURE_COUNT).fill(0);
    let db = 0;
    for (const r of rows) {
      const x = r.x.map((v, i) => clamp((v - mean[i]) / sd[i], -6, 6));
      const z = bias + x.reduce((s, v, i) => s + v * weights[i], 0);
      const e =
        (1 / (1 + Math.exp(-clamp(z, -30, 30))) - r.y) /
        (2 * classes[r.y] * sizes.get(`${r.imageHash}:${r.y}`)!);
      db += e;
      x.forEach((v, i) => (gradient[i] += v * e));
    }
    bias -= 0.15 * db;
    weights.forEach((v, i) => (weights[i] -= 0.15 * (gradient[i] + 0.01 * v)));
  }
  return { mean, sd, weights, bias };
}
export function score(
  model: Pick<Model, "mean" | "sd" | "weights" | "bias">,
  x: number[],
) {
  if (x.length !== FEATURE_COUNT || x.some((v) => !Number.isFinite(v)))
    return 0.5;
  // Outside the observed appearance range: abstain instead of extrapolating.
  if (x.some((v, i) => Math.abs((v - model.mean[i]) / model.sd[i]) > 6))
    return 0.5;
  return (
    1 /
    (1 +
      Math.exp(
        -clamp(
          model.bias +
            x.reduce(
              (s, v, i) =>
                s + ((v - model.mean[i]) / model.sd[i]) * model.weights[i],
              0,
            ),
          -30,
          30,
        ),
      ))
  );
}
export function train(
  records: LearningRecord[],
  target: Target,
): { report: TrainingReport; model?: Model } {
  // A re-export of the same photo never creates an independent validation case.
  const unique = [
    ...new Map(
      records
        .filter((r) => r.target === target && r.confirmed)
        .map((r) => [r.imageHash, r]),
    ).values(),
  ];
  const rows: Row[] = unique.flatMap((r) =>
    [0, 1].flatMap((label) => {
      const examples = r.examples.filter((e) => e.y === label),
        cap = label ? 80 : 40;
      const stride = Math.max(1, Math.ceil(examples.length / cap));
      return examples
        .filter((_, i) => i % stride === 0)
        .map((e) => ({ ...e, group: r.group, imageHash: r.imageHash }));
    }),
  );
  const groups = [...new Set(rows.map((r) => r.group))];
  const report: TrainingReport = {
    eligible: false,
    reasons: [],
    groups: groups.length,
    positive: rows.filter((r) => r.y === 1).length,
    negative: rows.filter((r) => r.y === 0).length,
    correct: 0,
    wrong: 0,
    abstained: 0,
    precision: 0,
  };
  if (groups.length < 4)
    report.reasons.push("独立した撮影セットが4組以上必要です");
  if (report.positive < 20 || report.negative < 8)
    report.reasons.push(
      "確認済みの薬品20個以上・薬品以外の例8個以上が必要です",
    );
  if (
    rows.some(
      (r) =>
        r.x.length !== FEATURE_COUNT || r.x.some((v) => !Number.isFinite(v)),
    )
  )
    report.reasons.push("特徴データが不正です");
  if (report.reasons.length) return { report };
  let correctPositive = 0,
    correctNegative = 0;
  const sortedGroups = [...groups].sort(),
    folds = Math.min(5, sortedGroups.length);
  for (let fold = 0; fold < folds; fold++) {
    const heldOut = new Set(sortedGroups.filter((_, i) => i % folds === fold));
    const learning = rows.filter((r) => !heldOut.has(r.group)),
      evaluation = rows.filter((r) => heldOut.has(r.group));
    if (!learning.some((r) => r.y === 0) || !learning.some((r) => r.y === 1)) {
      report.reasons.push("撮影セットを分けると学習例が不足します");
      continue;
    }
    const m = fit(learning);
    for (const r of evaluation) {
      const s = score(m, r.x),
        decision = s >= 0.9 ? 1 : s <= 0.1 ? 0 : -1;
      if (decision === -1) report.abstained++;
      else if (decision === r.y) {
        report.correct++;
        if (decision) correctPositive++;
        else correctNegative++;
      } else report.wrong++;
    }
  }
  report.precision =
    report.correct / Math.max(1, report.correct + report.wrong);
  if (report.wrong)
    report.reasons.push(`別の撮影セットで誤判定が${report.wrong}件ありました`);
  if (correctPositive < 5 || correctNegative < 3)
    report.reasons.push(
      "別写真で正しく判定できた薬品・背景の例が不足しています",
    );
  report.eligible = report.reasons.length === 0;
  return {
    report,
    model: report.eligible
      ? {
          version: 1,
          target,
          ...fit(rows),
          imageHashes: unique.map((r) => r.imageHash),
          trainedAt: new Date().toISOString(),
          report,
        }
      : undefined,
  };
}

/** Read-only suggestions: this module never changes counts or the base detector. */
export function suggest(
  model: Model,
  image: Raster,
  detections: Detection[],
  candidates: Detection[],
) {
  const review = detections
    .filter(
      (d) =>
        d.source !== "manual" && score(model, features(image, d.box)) <= 0.1,
    )
    .slice(0, 12);
  const add: Detection[] = [];
  for (const d of candidates) {
    if ([...detections, ...add].some((c) => near(c, d))) continue;
    if (score(model, features(image, d.box)) >= 0.9) add.push(d);
    if (add.length >= 12) break;
  }
  return { review, add };
}
