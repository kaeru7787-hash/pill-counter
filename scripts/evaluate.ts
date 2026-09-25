import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import sharp from "sharp";
import { analyze } from "../src/vision/pipeline";
import { metrics } from "../src/vision/metrics";
import { positionMetrics } from "../src/vision/positionMetrics";
import type { Settings, Analysis } from "../src/types";
const ground = JSON.parse(
  readFileSync("tests/ground-truth.json", "utf8"),
) as Record<string, number>;
const metadata = JSON.parse(readFileSync("tests/metadata.json", "utf8"));
const rows: {
  file: string;
  kind: string;
  truth: number;
  predicted: number;
  error: number;
  absolutePercentageError: number | null;
  confidence: Analysis["confidence"]["level"];
  counts: Analysis["counts"];
  category: string;
  notes: string;
  reasons: string[];
  absoluteCountError: number;
  position?: ReturnType<typeof positionMetrics>;
}[] = [];
const orphaned = readdirSync("tests/images").filter(
  (f) => /\.(png|jpe?g|webp)$/i.test(f) && !(f in ground),
);
if (orphaned.length)
  throw new Error(`正解個数が未登録: ${orphaned.join(", ")}`);
for (const [file, truth] of Object.entries(ground)) {
  if (!Number.isInteger(truth) || truth < 0)
    throw new Error(`Invalid ground truth: ${file}`);
  const { data, info } = await sharp(`tests/images/${file}`)
    .rotate()
    .resize({
      width: 2048,
      height: 2048,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = await analyze(
    {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    },
    {
      scene: (metadata[file]?.scene || "tray") as Settings["scene"],
      autoROI: true,
      debug: false,
    },
  );
  const predicted = result.detections.length,
    error = predicted - truth;
  const annotationPath = `tests/annotations/${file.replace(/\.[^.]+$/, ".json")}`;
  let position: ReturnType<typeof positionMetrics> | undefined;
  if (existsSync(annotationPath)) {
    const annotation = JSON.parse(readFileSync(annotationPath, "utf8"));
    const centers = annotation.centers.map(([x, y]: number[]) => ({
      x: (x * info.width) / annotation.width,
      y: (y * info.height) / annotation.height,
    }));
    if (centers.length !== truth)
      throw new Error(
        "Position annotation count differs from count ground truth",
      );
    position = positionMetrics(
      result.detections.map((d) => d.center),
      centers,
      (annotation.tolerance * info.width) / annotation.width,
    );
    mkdirSync("tests/reports/positions", { recursive: true });
    const matched = new Set(position.matchedPredictions);
    const svg = `<svg width="${info.width}" height="${info.height}">${result.detections.map((d, i) => `<polygon points="${d.contour.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${matched.has(i) ? "#00cc66" : "#ff3344"}" stroke-width="2"/><text x="${d.center.x}" y="${d.center.y}" fill="${matched.has(i) ? "#00cc66" : "#ff3344"}" font-size="16">${i + 1}</text>`).join("")}${position.missingTruth.map((i) => `<circle cx="${centers[i].x}" cy="${centers[i].y}" r="15" fill="none" stroke="#3388ff" stroke-width="4"/>`).join("")}</svg>`;
    await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toFile(`tests/reports/positions/${file.replace(/\.[^.]+$/, ".png")}`);
  }
  if (
    metadata[file]?.kind === "real" &&
    (Math.abs(error) > 1 || (position && (position.fp > 0 || position.fn > 1)))
  )
    process.exitCode = 1;
  const row = {
    file,
    kind: metadata[file]?.kind || "real",
    truth,
    predicted,
    error,
    absolutePercentageError: truth ? Math.abs(error) / truth : null,
    confidence: result.confidence.level,
    counts: result.counts,
    category: error ? metadata[file]?.category || "Unclassified" : "None",
    notes: error
      ? "合成ケースの想定原因。位置アノテーションとの精査が必要"
      : "",
    reasons: result.confidence.reasons,
    absoluteCountError: Math.abs(error),
    position,
  };
  rows.push(row);
  console.log(
    `${file}: 正解 ${truth} / 検出 ${predicted} / 誤差 ${error} / ${result.confidence.level}${position ? ` / TP ${position.tp} FP ${position.fp} FN ${position.fn}` : ""}`,
  );
}
const report = {
  generatedAt: new Date().toISOString(),
  scope:
    "One development real image plus synthetic regression fixtures. Not an independent clinical validation set.",
  metrics: metrics(rows),
  byKind: Object.fromEntries(
    [...new Set(rows.map((r) => r.kind))].map((kind) => [
      kind,
      metrics(rows.filter((r) => r.kind === kind)),
    ]),
  ),
  rows,
};
mkdirSync("tests/reports", { recursive: true });
writeFileSync(
  "tests/reports/latest.json",
  JSON.stringify(report, null, 2) + "\n",
);
let md = `# 精度評価\n\n生成: ${report.generatedAt}\n\n実写1枚と合成17枚の開発用評価です。未知の実写・調剤現場の精度を保証しません。\n\n|画像|正解|検出|誤差|絶対誤差率|信頼度|想定原因|\n|---|---:|---:|---:|---:|---|---|\n`;
for (const r of rows)
  md += `|${r.file}|${r.truth}|${r.predicted}|${r.error}|${r.absolutePercentageError === null ? "対象外" : (r.absolutePercentageError * 100).toFixed(2) + "%"}|${r.confidence}|${r.category}|\n`;
md += `\n## 指標\n\n\x60\x60\x60json\n${JSON.stringify(report.metrics, null, 2)}\n\x60\x60\x60\n\nMAPEは正解0枚を除外。要確認画像も除外せず全件評価します。\n`;
if (existsSync("tests/reports/baseline.json")) {
  const baseline = JSON.parse(
    readFileSync("tests/reports/baseline.json", "utf8"),
  );
  const regressed = rows
    .filter((r) => {
      const b = baseline.rows.find((x: { file: string }) => x.file === r.file);
      return b && Math.abs(r.error) > Math.abs(b.error);
    })
    .map((r) => r.file);
  const commonMetrics = metrics(
    rows.filter((r) =>
      baseline.rows.some((b: { file: string }) => b.file === r.file),
    ),
  );
  md += `\n## 初版の合成17枚との比較（同じ画像のみ）\n\n|指標|改善前|現在|\n|---|---:|---:|\n${["exactCountAccuracy", "meanAbsoluteError", "withinOneAccuracy"].map((k) => `|${k}|${baseline.metrics[k]}|${commonMetrics[k as keyof typeof commonMetrics]}|`).join("\n")}\n\n悪化した画像: ${regressed.length ? regressed.join(", ") : "なし"}\n`;
  if (regressed.length && process.env.CI) process.exitCode = 1;
}
for (const r of rows.filter((r) => r.position)) {
  md += `\n## ${r.file} 位置評価\n\nTP ${r.position!.tp} / FP ${r.position!.fp} / FN ${r.position!.fn} / Precision ${r.position!.precision} / Recall ${r.position!.recall} / F1 ${r.position!.f1}\n`;
}
writeFileSync("tests/reports/latest.md", md);
if (existsSync("tests/reports/accepted.json")) {
  const accepted = JSON.parse(
    readFileSync("tests/reports/accepted.json", "utf8"),
  );
  const worsened = rows.filter((r) => {
    const prior = accepted.rows.find(
      (p: { file: string }) => p.file === r.file,
    );
    return prior && Math.abs(r.error) > Math.abs(prior.error);
  });
  const missing = accepted.rows.filter(
    (p: { file: string }) => !rows.some((r) => r.file === p.file),
  );
  if (worsened.length || missing.length) {
    console.error(
      "承認済み回帰セットからの悪化・削除:",
      worsened.map((r) => r.file),
      missing.map((p: { file: string }) => p.file),
    );
    process.exitCode = 1;
  }
}
console.log(JSON.stringify(report.metrics, null, 2));
