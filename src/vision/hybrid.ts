import { analyze, clampROI } from "./pipeline";
import { detectAI } from "../ai/onnxDetector";
import { fuse } from "../ai/fusion";
import type { Raster, Settings } from "../types";

export async function analyzeHybrid(
  image: Raster,
  settings: Settings,
  baseURL: string,
) {
  const start = performance.now();
  const result = await analyze(image, settings);
  result.version = "0.5.0-trial";
  if (!settings.useAI) {
    result.aiStatus = "AI併用OFF（画像処理のみ）";
    result.elapsed = performance.now() - start;
    return result;
  }
  // Respect the user's explicit ROI; otherwise inspect the whole photograph,
  // as in the adoption benchmark, so a mistaken automatic crop cannot hide pills.
  const roi = clampROI(
    settings.roi || { x: 0, y: 0, width: image.width, height: image.height },
    image.width,
    image.height,
  );
  const ai = await detectAI(image, roi, baseURL);
  result.aiStatus = ai.status;
  if (ai.detections && ai.tiles) {
    const originalCount = result.detections.length;
    const f = fuse(result.detections, ai.detections, ai.tiles);
    result.counts.AI = ai.detections.length;
    result.detections = f.detections
      .filter(
        (d) =>
          d.center.x >= roi.x &&
          d.center.x <= roi.x + roi.width &&
          d.center.y >= roi.y &&
          d.center.y <= roi.y + roi.height,
      )
      .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x)
      .map((d, i) => ({ ...d, id: `hybrid-${i + 1}` }));
    result.algorithm = `AI併用（試験）＋ ${result.algorithm || "画像処理"}`;
    result.aiStatus = `AI併用（試験）：画像処理 ${originalCount} → 併用 ${result.detections.length}（追加 ${f.added.length}・重複統合 ${f.removed.length}） / ${ai.status}`;
    // Trial scores are not calibrated probabilities. Agreement does not prove
    // completeness: the known glare case still misses one pill.
    result.confidence = {
      level: "review",
      reasons: [
        ...result.confidence.reasons,
        "AI併用の試験版です。反射・重なりによる見逃しを確認してください",
      ],
    };
    result.diagnostics.push(
      `AI全体 ${ai.detections.length} / 複数範囲で支持 ${f.stable.length}`,
    );
  } else if (ai.failed) {
    result.confidence = {
      level: "review",
      reasons: [
        ...result.confidence.reasons,
        "AIを利用できなかったため、画像処理のみの結果です",
      ],
    };
  }
  result.elapsed = performance.now() - start;
  return result;
}
