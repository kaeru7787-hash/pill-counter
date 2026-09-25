import { getCV } from "./opencv";
import { automaticROI, median, preprocess } from "./preprocess";
import { segment } from "./segmentation";
import { contours, relativeFilter } from "./shapeFilter";
import { splitWatershed } from "./watershed";
import { analyzeTray } from "./trayPipeline";
import { confidence, spatialAgreement, chooseDetections } from "./ensemble";
import type { Analysis, DebugImage, Raster, Settings, ROI } from "../types";
export const VERSION = "0.2.0";
export function clampROI(roi: ROI, w: number, h: number): ROI {
  const x = Math.max(0, Math.min(w - 3, Math.floor(roi.x))),
    y = Math.max(0, Math.min(h - 3, Math.floor(roi.y)));
  return {
    x,
    y,
    width: Math.max(3, Math.min(w - x, Math.floor(roi.width))),
    height: Math.max(3, Math.min(h - y, Math.floor(roi.height))),
  };
}
export async function analyze(
  image: Raster,
  settings: Settings,
): Promise<Analysis> {
  if (settings.scene === "tray") {
    const tray = await analyzeTray(image, settings);
    if (tray) return tray;
  }
  const start = performance.now(),
    { cv } = await getCV(),
    rgb = preprocess(cv, image, settings.parameters?.blur),
    full = { x: 0, y: 0, width: image.width, height: image.height };
  const roi = clampROI(
    settings.roi ||
      (settings.autoROI && settings.scene === "tray"
        ? automaticROI(cv, rgb)
        : undefined) ||
      full,
    image.width,
    image.height,
  );
  const view = rgb.roi(new cv.Rect(roi.x, roi.y, roi.width, roi.height)),
    crop = view.clone();
  view.delete();
  rgb.delete();
  const primary = segment(cv, crop, 1, settings.parameters),
    alternate = segment(cv, crop, 0.86, settings.parameters),
    issues: string[] = [],
    diagnostics: string[] = [];
  const a = relativeFilter(contours(cv, primary.mask, "a", roi));
  // Preserve dense clusters until after splitting; remove only background enclosures.
  const clean = cv.Mat.zeros(crop.rows, crop.cols, cv.CV_8UC1);
  for (const d of contours(cv, primary.mask, "raw", roi).filter(
    (d) => !d.flags.includes("背景の囲み枠"),
  )) {
    const pts = cv.matFromArray(
      d.contour.length,
      1,
      cv.CV_32SC2,
      d.contour.flatMap((p) => [p.x - roi.x, p.y - roi.y]),
    );
    const v = new cv.MatVector();
    v.push_back(pts);
    cv.drawContours(clean, v, 0, new cv.Scalar(255), -1);
    v.delete();
    pts.delete();
  }
  cv.bitwise_and(clean, primary.mask, clean);
  const split = splitWatershed(
      cv,
      clean,
      roi,
      settings.parameters?.minimumDistance ?? 1,
    ),
    alt = splitWatershed(
      cv,
      alternate.mask,
      roi,
      (settings.parameters?.minimumDistance ?? 1) * 1.06,
    );
  const filter = (list: import("../types").Detection[]) => {
    const filtered = relativeFilter(list),
      p = settings.parameters || {};
    const reference = p.diameter
      ? Math.PI * (p.diameter / 2) ** 2
      : median(filtered.kept.map((d) => d.area));
    const kept = filtered.kept.filter(
      (d) =>
        (p.minArea === undefined || d.area >= reference * p.minArea) &&
        (p.maxArea === undefined || d.area <= reference * p.maxArea) &&
        (p.minCircularity === undefined ||
          d.shape!.circularity >= p.minCircularity) &&
        (p.minSolidity === undefined || d.shape!.solidity >= p.minSolidity),
    );
    return { ...filtered, kept, rejected: list.length - kept.length };
  };
  const b = filter(split.detections),
    c = filter(alt.detections);
  const areas = b.kept.map((d) => d.area),
    med = median(areas);
  // Re-run suspicious large regions at a closer peak spacing. Never invent seeds from area alone.
  if (
    b.kept.some(
      (d) => d.area > med * 1.8 && d.flags.some((f) => f.includes("接触")),
    )
  ) {
    const retry = splitWatershed(cv, clean, roi, 0.78),
      r = relativeFilter(retry.detections);
    if (r.kept.length !== b.kept.length) {
      diagnostics.push(`面積異常の再分割: ${b.kept.length} → ${r.kept.length}`);
      issues.push("再分割で個数が変化。接触錠剤を確認");
    }
    retry.distance.delete();
    retry.markers.delete();
    retry.seedsImage.delete();
  }
  if (settings.scene === "bag")
    issues.push("透明袋：反射・印字・溶着部の目視確認が必要");
  if (settings.autoROI && settings.scene === "tray" && !settings.roi)
    issues.push("自動解析範囲を確認してください");
  if (primary.otsu < 12) issues.push("背景との色差が小さい");
  if (split.seedLimit || alt.seedLimit)
    issues.push("候補数が処理上限に達しました");
  if (b.kept.some((d) => d.flags.length))
    issues.push("形状または境界に不確かな候補があります");
  if (a.kept.some((d) => d.flags.some((f) => f.includes("接触の可能性"))))
    issues.push("接触または不規則な形状を検出しました");
  if (areas.some((v) => v > med * 2.2))
    issues.push("面積分布に大きな候補：大型錠剤または接触の可能性");
  let clipped = 0,
    texture = 0;
  const cleanPixels = clean.data,
    colorPixels = crop.data;
  for (let p = 0; p < cleanPixels.length; p++)
    if (cleanPixels[p]) {
      if (
        colorPixels[p * 3] > 249 &&
        colorPixels[p * 3 + 1] > 249 &&
        colorPixels[p * 3 + 2] > 249
      )
        clipped++;
      if (
        p % crop.cols &&
        Math.abs(colorPixels[p * 3] - colorPixels[(p - 1) * 3]) > 45
      )
        texture++;
    }
  const foreground = cleanPixels.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  if (foreground > cleanPixels.length * 0.65)
    issues.push("前景が広すぎます。解析範囲・背景を確認");
  if (clipped / Math.max(1, foreground) > 0.22)
    issues.push("白飛びが多く、反射と錠剤の区別が不安定");
  if (texture / Math.max(1, foreground) > 0.16)
    issues.push("内部テクスチャが強い：印字・袋の可能性");
  const debug: Record<string, DebugImage> = {};
  if (settings.debug) {
    const raster = (
      data: ArrayLike<number>,
      mode: "gray" | "distance" | "labels",
    ): DebugImage => {
      const out = new Uint8ClampedArray(data.length * 4);
      let max = 1;
      if (mode === "distance")
        for (let i = 0; i < data.length; i++) max = Math.max(max, data[i]);
      for (let p = 0; p < data.length; p++) {
        const v = data[p];
        if (mode === "labels") {
          out[p * 4] = v > 1 ? (v * 67) % 255 : 0;
          out[p * 4 + 1] = v > 1 ? (v * 113) % 255 : 0;
          out[p * 4 + 2] = v > 1 ? (v * 179) % 255 : 0;
        } else {
          const g = mode === "distance" ? (v / max) * 255 : v;
          out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = g;
        }
        out[p * 4 + 3] = 255;
      }
      return { width: crop.cols, height: crop.rows, data: out };
    };
    debug["Foreground mask"] = raster(clean.data, "gray");
    debug["Threshold"] = raster(primary.threshold.data, "gray");
    debug.Morphology = raster(primary.mask.data, "gray");
    debug.Markers = raster(split.seedsImage.data32S, "labels");
    const gray = new cv.Mat();
    cv.cvtColor(crop, gray, cv.COLOR_RGB2GRAY);
    debug.Grayscale = raster(gray.data, "gray");
    gray.delete();
    debug.ROI = raster(new Uint8Array(crop.rows * crop.cols).fill(255), "gray");
    debug["Distance transform"] = raster(split.distance.data32F, "distance");
    debug["Watershed"] = raster(split.markers.data32S, "labels");
  }
  diagnostics.push(
    `除外候補: A=${a.rejected}, B=${b.rejected}, C=${c.rejected}`,
    `Lab色差 Otsu=${primary.otsu.toFixed(1)}`,
  );
  const counts = { A: a.kept.length, B: b.kept.length, C: c.kept.length },
    agreement = spatialAgreement(b.kept, c.kept);
  const chosen = chooseDetections(a.kept, b.kept, c.kept);
  diagnostics.push(`表示する検出集合: ${chosen === c.kept ? "C" : "B"}`);
  const detections = chosen
    .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x)
    .map((d, i) => ({ ...d, id: `cv-${i + 1}` }));
  crop.delete();
  primary.mask.delete();
  primary.threshold.delete();
  primary.difference.delete();
  alternate.mask.delete();
  alternate.threshold.delete();
  alternate.difference.delete();
  clean.delete();
  split.distance.delete();
  split.markers.delete();
  alt.distance.delete();
  alt.markers.delete();
  alt.seedsImage.delete();
  split.seedsImage.delete();
  return {
    version: VERSION,
    width: image.width,
    height: image.height,
    roi,
    detections,
    candidates: a.kept,
    algorithm: "Lab色差 + 輪郭 + 距離ピーク/Watershed（非円形対応）",
    counts,
    confidence: confidence(counts, agreement, issues),
    debug,
    diagnostics,
    elapsed: performance.now() - start,
  };
}
