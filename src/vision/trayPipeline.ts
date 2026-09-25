import { getCV } from "./opencv";
import { median } from "./preprocess";
import { contours } from "./shapeFilter";
import { splitWatershed } from "./watershed";
import { spatialAgreement, confidence } from "./ensemble";
import type {
  Analysis,
  Settings,
  Raster,
  Detection,
  DebugImage,
} from "../types";

/** Dark-tray path. No labels, filename, expected count or image-specific coordinates enter inference. */
export async function analyzeTray(
  image: Raster,
  settings: Settings,
): Promise<Analysis | undefined> {
  const start = performance.now(),
    { cv } = await getCV();
  const owned: any[] = [];
  const mat = () => {
    const m = new cv.Mat();
    owned.push(m);
    return m;
  };
  const keep = <T>(m: T): T => {
    owned.push(m);
    return m;
  };
  try {
    const rgba = keep(cv.matFromImageData(image as ImageData)),
      rgb = mat(),
      gray = mat(),
      smooth = mat(),
      dark = mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const p = settings.parameters || {},
      w = image.width,
      h = image.height;
    const blur = Math.max(1, Math.min(15, Math.round(p.blur ?? 3))) | 1;
    cv.GaussianBlur(gray, smooth, new cv.Size(blur, blur), 0);
    const t = cv.threshold(
      smooth,
      dark,
      0,
      255,
      cv.THRESH_BINARY_INV | cv.THRESH_OTSU,
    );
    const cs = keep(new cv.MatVector()),
      hier = mat(),
      support = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    cv.findContours(dark, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1,
      bestArea = 0;
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i),
        a = cv.contourArea(c);
      if (a > bestArea) {
        best = i;
        bestArea = a;
      }
      c.delete();
    }
    const issues: string[] = [],
      debug: Record<string, DebugImage> = {};
    const useTray = settings.autoROI && !settings.roi;
    if (useTray && best >= 0 && bestArea > w * h * 0.15)
      cv.drawContours(support, cs, best, new cv.Scalar(255), -1);
    else {
      support.setTo(new cv.Scalar(255));
      if (useTray)
        issues.push(
          "黒いトレー範囲を特定できません。手動ROIを指定してください",
        );
    }
    const roi = settings.roi || { x: 0, y: 0, width: w, height: h };
    if (settings.roi)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (
            x < roi.x ||
            y < roi.y ||
            x >= roi.x + roi.width ||
            y >= roi.y + roi.height
          )
            support.data[y * w + x] = 0;
    const primary = mat(),
      alternative = mat(),
      local = mat();
    const threshold = p.threshold ?? t;
    cv.threshold(smooth, primary, threshold, 255, cv.THRESH_BINARY);
    cv.threshold(smooth, alternative, threshold * 0.9, 255, cv.THRESH_BINARY);
    const block =
      Math.max(
        3,
        Math.min(
          Math.min(w, h) - 1,
          Math.round(p.blockSize ?? Math.min(w, h) * 0.05),
        ),
      ) | 1;
    cv.adaptiveThreshold(
      smooth,
      local,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      block,
      3,
    );
    // Color and local contrast reject saturated labels; dark support removes exterior desk and metal.
    for (const mask of [primary, alternative])
      for (let i = 0; i < w * h; i++) {
        const r = rgb.data[i * 3],
          g = rgb.data[i * 3 + 1],
          b = rgb.data[i * 3 + 2],
          sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, r, g, b);
        if (
          !support.data[i] ||
          sat > 0.48 ||
          (smooth.data[i] < threshold * 1.1 && !local.data[i])
        )
          mask.data[i] = 0;
      }
    const raw = primary.clone();
    owned.push(raw);
    // Estimate from compact single objects, never from area-weighted merged blobs.
    const initial = contours(cv, primary, "raw");
    const singles = initial.filter(
      (d) =>
        d.shape!.solidity > 0.94 &&
        d.shape!.circularity > 0.78 &&
        d.shape!.aspect < 1.45 &&
        d.area < w * h * 0.025,
    );
    const radii = singles
      .map((d) => Math.sqrt(d.area / Math.PI))
      .sort((a, b) => a - b);
    // A logarithmic mode rejects tiny dust even when it outnumbers actual pills.
    let cluster: number[] = [];
    for (const r of radii) {
      const near = radii.filter((v) => v >= r * 0.8 && v <= r * 1.25);
      if (near.length * median(near) > cluster.length * median(cluster))
        cluster = near;
    }
    // Round-object evidence is required for circle-supported markers. Capsules, mixed colors,
    // and scenes without enough isolated round objects use the general Lab/contour path.
    if (
      !p.diameter &&
      (cluster.length < 3 || median(cluster) < Math.min(w, h) * 0.003)
    )
      return undefined;
    let radius = p.diameter ? p.diameter / 2 : median(cluster);
    if (!radius) {
      radius = Math.min(w, h) * 0.02;
      issues.push("単独錠剤から大きさを推定できません");
    }
    const diameter = radius * 2,
      area = Math.PI * radius * radius;
    const kernelRadius = Math.max(
      1,
      Math.min(radius * 0.18, Math.round(p.morphology ?? radius * 0.06)),
    );
    const k = keep(
      cv.getStructuringElement(
        cv.MORPH_ELLIPSE,
        new cv.Size(
          Math.round(kernelRadius) * 2 + 1,
          Math.round(kernelRadius) * 2 + 1,
        ),
      ),
    );
    for (const mask of [primary, alternative]) {
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
      // Fill internal engraving holes, without closing gaps between different objects.
      const vs = keep(new cv.MatVector()),
        hh = mat();
      cv.findContours(mask, vs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      mask.setTo(new cv.Scalar(0));
      cv.drawContours(mask, vs, -1, new cv.Scalar(255), -1);
      cv.bitwise_and(mask, support, mask);
    }
    const components = contours(cv, primary, "component");
    // Hough supplies extra markers and a cross-check; accepted watershed contours determine the count.
    const circles = mat();
    cv.HoughCircles(
      smooth,
      circles,
      cv.HOUGH_GRADIENT,
      1,
      diameter * 0.7,
      100,
      p.houghSensitivity ?? 24,
      Math.max(1, Math.round(radius * (p.houghMin ?? 0.75))),
      Math.max(2, Math.round(radius * (p.houghMax ?? 1.3))),
    );
    const hough: Detection[] = [];
    for (let i = 0; i < circles.data32F.length; i += 3) {
      const [x, y, r] = circles.data32F.subarray(i, i + 3);
      if (
        support.data[Math.round(y) * w + Math.round(x)] &&
        primary.data[Math.round(y) * w + Math.round(x)]
      )
        hough.push({
          id: `h${i}`,
          center: { x, y },
          area: Math.PI * r * r,
          box: { x: x - r, y: y - r, width: r * 2, height: r * 2 },
          contour: [],
          flags: [],
          source: "cv",
        });
    }

    if (hough.length < 3 && !p.diameter) return undefined;
    const hints =
      median(
        singles
          .filter((d) => d.area > area * 0.6 && d.area < area * 1.6)
          .map((d) => d.shape!.aspect),
      ) < 1.45
        ? hough.map((d) => d.center)
        : [];
    const splits = splitWatershed(
      cv,
      primary,
      { x: 0, y: 0 },
      p.minimumDistance ?? 1,
      radius,
      hints,
    );
    const alternate = splitWatershed(
      cv,
      alternative,
      { x: 0, y: 0 },
      (p.minimumDistance ?? 1) * 1.06,
      radius,
    );
    for (const s of [splits, alternate]) {
      owned.push(s.distance, s.markers, s.seedsImage);
    }
    const minArea = p.minArea ?? 0.3,
      maxArea = p.maxArea ?? 2.6;
    const accept = (d: Detection) =>
      d.area >= area * minArea &&
      d.area <= area * maxArea &&
      d.shape!.aspect < 1.8 &&
      d.shape!.circularity >= (p.minCircularity ?? 0.5) &&
      d.shape!.solidity >= (p.minSolidity ?? 0.65) &&
      !!support.data[Math.round(d.center.y) * w + Math.round(d.center.x)];
    const a = components.filter(accept),
      b = splits.detections.filter(accept),
      c = alternate.detections.filter(accept);
    if (
      Math.abs(hough.length - b.length) > Math.max(2, b.length * 0.12) ||
      spatialAgreement(b, hough) < 0.85
    )
      issues.push("HoughとWatershedの位置・個数が不一致。手動確認推奨");
    if (components.some((d) => d.area > area * 2.6) && b.length === a.length)
      issues.push("大きな連結領域が未分離の可能性");
    if (b.some((d) => d.area > area * 1.7 || d.area < area * 0.5))
      issues.push("サイズ分布にばらつきがあります");
    if (useTray && bestArea < w * h * 0.15) issues.push("ROIが不明瞭");
    const detections = b
      .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x)
      .map((d, i) => ({ ...d, id: `cv-${i + 1}` }));
    const counts = { A: a.length, B: b.length, C: c.length };
    if (settings.debug) {
      const raster = (m: any, mode = "gray"): DebugImage => {
        const src =
          mode === "labels"
            ? m.data32S
            : mode === "distance"
              ? m.data32F
              : m.data;
        let max = 1;
        if (mode === "distance") for (const v of src) max = Math.max(max, v);
        const out = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const v = src[i];
          for (let j = 0; j < 3; j++)
            out[i * 4 + j] =
              mode === "labels"
                ? v > 1
                  ? (v * [67, 113, 179][j]) % 255
                  : 0
                : mode === "distance"
                  ? (v / max) * 255
                  : v;
          out[i * 4 + 3] = 255;
        }
        return { width: w, height: h, data: out, origin: { x: 0, y: 0 } };
      };
      debug.ROI = raster(support);
      debug.Grayscale = raster(gray);
      debug.Threshold = raster(raw);
      debug.Morphology = raster(primary);
      debug["Foreground mask"] = raster(primary);
      debug["Distance transform"] = raster(splits.distance, "distance");
      debug.Markers = raster(splits.seedsImage, "labels");
      debug.Watershed = raster(splits.markers, "labels");
    }
    return {
      version: "0.3.0",
      width: w,
      height: h,
      roi,
      detections,
      candidates: components,
      counts,
      confidence: confidence(counts, spatialAgreement(b, c), issues),
      debug,
      diagnostics: [
        `Otsu ${t.toFixed(1)} / threshold ${threshold.toFixed(1)}`,
        `推定直径 ${diameter.toFixed(1)}px / 単独候補 ${singles.length}`,
        `分離前 ${components.length} / 種 ${splits.seedCount} / 分離後 ${splits.detections.length} / 採用 ${b.length}`,
        `Hough ${hough.length}`,
        `トレー外除外 ${useTray ? "ON" : "手動ROIまたはOFF"}`,
      ],
      elapsed: performance.now() - start,
      algorithm:
        "トレー形状マスク + 明度/色/局所閾値 + 距離ピーク/Watershed + Hough照合",
      estimatedDiameter: diameter,
    };
  } finally {
    for (const m of owned.reverse()) m?.delete();
  }
}
