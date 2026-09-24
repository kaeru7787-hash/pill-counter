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
      width: 1280,
      height: 1280,
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
      autoROI: false,
      debug: false,
    },
  );
  const predicted = result.detections.length,
    error = predicted - truth;
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
  };
  rows.push(row);
  console.log(
    `${file}: 正解 ${truth} / 検出 ${predicted} / 誤差 ${error} / ${result.confidence.level}`,
  );
}
const report = {
  generatedAt: new Date().toISOString(),
  scope:
    "Synthetic fixtures are not evidence of clinical or real-photo accuracy.",
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
let md = `# 精度評価\n\n生成: ${report.generatedAt}\n\n合成画像による回帰検証です。実写・調剤現場の精度を示しません。\n\n|画像|正解|検出|誤差|絶対誤差率|信頼度|想定原因|\n|---|---:|---:|---:|---:|---|---|\n`;
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
  md += `\n## 改善前後\n\n|指標|改善前|現在|\n|---|---:|---:|\n${["exactCountAccuracy", "meanAbsoluteError", "withinOneAccuracy"].map((k) => `|${k}|${baseline.metrics[k]}|${report.metrics[k as keyof typeof report.metrics]}|`).join("\n")}\n\n悪化した画像: ${regressed.length ? regressed.join(", ") : "なし"}\n`;
  if (regressed.length && process.env.CI) process.exitCode = 1;
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
