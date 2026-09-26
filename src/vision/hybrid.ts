import { analyze, clampROI } from "./pipeline";
import { detectAI } from "../ai/onnxDetector";
import { fuse } from "../ai/fusion";
import type { Raster, Settings } from "../types";
import { analyzeBottles } from "./bottlePipeline";
import { fuseBottles } from "../ai/bottleFusion";

export async function analyzeHybrid(
  image: Raster,
  settings: Settings,
  baseURL: string,
) {
  if (settings.target === "bottle") {
    const started=performance.now();
    const result=await analyzeBottles(image,settings);
    result.version="0.10.0";
    if(!settings.useAI){result.aiStatus="点眼AI OFF（キャップの画像処理のみ）";return result;}
    const ai=await detectAI(image,result.roi,baseURL,[],"bottle");
    if(ai.detections&&ai.tiles){
      const cvCount=result.detections.length;
      const fused=fuseBottles(result.detections,[...ai.detections,...ai.tiles]);
      result.detections=fused.detections;
      result.counts.AI=fused.bodies.length;
      result.algorithm="点眼専用AI＋キャップ検出";
      result.aiStatus=`点眼専用AI：${cvCount} → ${result.detections.length}本（AI追加 ${fused.added}・重複照合 ${fused.matched}）`;
      result.confidence={level:"review",reasons:["少数写真で学習した点眼AIです。倒れたボトル・重なり・反射を確認してください。"]};
      result.diagnostics.push(`点眼AI 全体 ${ai.detections.length} / 区画 ${ai.tiles.length} / 統合 ${fused.bodies.length}`);
    }else{
      result.aiStatus=`点眼AIを利用できません。画像処理のみ / ${ai.status}`;
      result.confidence.reasons.unshift("点眼AIを利用できなかったため、画像処理のみです。");
    }
    result.elapsed=performance.now()-started;
    return result;
  }
  const start = performance.now();
  const result = await analyze(image, settings);
  result.version = "0.10.0";
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
  const ai = await detectAI(image, roi, baseURL, result.detections);
  result.aiStatus = ai.status;
  if (ai.detections && ai.tiles) {
    const originalCount = result.detections.length;
    const f = fuse(result.detections, ai.detections, ai.tiles, image);
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
    result.rejectedCandidates = f.rejected;
    result.algorithm = `AI＋形状照合＋候補審査 / ${result.algorithm || "画像処理"}`;
    result.aiStatus = `AI併用：画像処理 ${originalCount} → 併用 ${result.detections.length}（追加 ${f.added.length}・重複統合 ${f.removed.length}・背景除外 ${f.rejected.length}） / ${ai.status}`;
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
      `背景除外 ${f.rejected.length} / 画像内形状照合 ${f.profile.uniform ? "有効" : "サイズ混在・候補不足のため保留"}`,
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
