import type { Parameters } from "../types";
export const fields: [keyof Parameters, string, number, number, number][] = [
  ["threshold", "前景閾値（空欄＝Otsu）", 0, 255, 1],
  ["blockSize", "適応閾値の近傍サイズ（px・奇数）", 3, 301, 2],
  ["blur", "ぼかし（px・奇数）", 1, 15, 2],
  ["morphology", "形態処理の半径（px）", 1, 20, 1],
  ["minArea", "最小面積（推定1錠の面積比）", 0.05, 1, 0.05],
  ["maxArea", "最大面積（推定1錠の面積比）", 1, 10, 0.1],
  ["minCircularity", "最小円形度", 0, 1, 0.05],
  ["minSolidity", "最小solidity", 0, 1, 0.05],
  ["minimumDistance", "Watershed中心間隔（自動値の倍率）", 0.5, 2, 0.05],
  ["diameter", "推定錠剤直径（解析画像のpx）", 3, 1000, 1],
  ["houghMin", "Hough最小半径（推定半径比）", 0.3, 1.5, 0.05],
  ["houghMax", "Hough最大半径（推定半径比）", 0.5, 3, 0.05],
  ["houghSensitivity", "Hough投票閾値（小さいほど感度増）", 5, 100, 1],
];
export const parameterHTML = `<details><summary>詳細調整（通常は自動）</summary><p class="muted">空欄は自動推定。閾値はトレー経路で明度、汎用経路でLab色差に適用。Hough調整は黒トレーの丸形錠剤の分離補助に使用します。</p>${fields.map(([key, label, min, max, step]) => `<label class="field">${label}<input type="number" data-parameter="${key}" min="${min}" max="${max}" step="${step}" placeholder="自動"></label>`).join("")}<button id="reset-parameters" type="button">調整値を自動に戻す</button></details>`;
export function readParameters(): Parameters {
  const p: Parameters = {};
  for (const [key, , min, max] of fields) {
    const el = document.querySelector<HTMLInputElement>(
      `[data-parameter="${key}"]`,
    )!;
    if (el.value.trim()) {
      const v = Number(el.value);
      if (!Number.isFinite(v) || v < min || v > max)
        throw new Error(`${key} は ${min}〜${max} の範囲で入力してください`);
      p[key] = v;
    }
  }
  if (p.houghMin && p.houghMax && p.houghMin > p.houghMax)
    throw new Error("Hough半径の最小値が最大値を超えています");
  return p;
}
