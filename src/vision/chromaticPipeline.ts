import { getCV } from "./opencv";
import { median } from "./preprocess";
import { contours } from "./shapeFilter";
import { splitWatershed } from "./watershed";
import type {
  Analysis,
  DebugImage,
  Detection,
  Raster,
  Settings,
} from "../types";

type Model = {
  x: number;
  y: number;
  r: number;
  ratio: number;
  angle: number;
  score: number;
};
const inside = (p: { x: number; y: number }, t: Model, mult = 1) => {
  const a = (t.angle * Math.PI) / 180,
    dx = p.x - t.x,
    dy = p.y - t.y,
    xx = dx * Math.cos(a) + dy * Math.sin(a),
    yy = -dx * Math.sin(a) + dy * Math.cos(a);
  return (
    Math.hypot(Math.max(0, Math.abs(xx) - t.r * (t.ratio - 1)), yy) < t.r * mult
  );
};
function overlap(c: Model, t: Model) {
  if (Math.hypot(c.x - t.x, c.y - t.y) > c.r * c.ratio + t.r * t.ratio)
    return 0;
  let area = 0,
    shared = 0;
  const step = Math.max(1, Math.round(Math.sqrt(c.r * t.r) / 5));
  for (let y = c.y - c.r * c.ratio; y < c.y + c.r * c.ratio; y += step)
    for (let x = c.x - c.r * c.ratio; x < c.x + c.r * c.ratio; x += step)
      if (inside({ x, y }, c)) {
        area++;
        if (inside({ x, y }, t)) shared++;
      }
  return shared / Math.max(1, area);
}
const conflict = (a: Model, b: Model) =>
  inside(a, b) || inside(b, a) || overlap(a, b) > 0.25 || overlap(b, a) > 0.25;

/** Uniform colored objects on a neutral background. All scale and pose estimates come from pixels. */
export async function analyzeChromatic(
  image: Raster,
  settings: Settings,
  brightOnly = false,
): Promise<Analysis | undefined> {
  const start = performance.now(),
    { cv } = await getCV(),
    owned: any[] = [];
  const own = <T>(m: T): T => {
      owned.push(m);
      return m;
    },
    mat = () => own(new cv.Mat());
  try {
    const full = own(cv.matFromImageData(image as ImageData)),
      rgbFull = mat();
    cv.cvtColor(full, rgbFull, cv.COLOR_RGBA2RGB);
    const scale = Math.min(1, 960 / Math.max(image.width, image.height)),
      w = Math.round(image.width * scale),
      h = Math.round(image.height * scale),
      rgb = mat();
    cv.resize(rgbFull, rgb, new cv.Size(w, h), 0, 0, cv.INTER_CUBIC);
    const gray = mat(),
      hsv = mat(),
      sat = own(cv.Mat.zeros(h, w, cv.CV_8UC1)),
      mask = mat(),
      smooth = mat();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const brightMask = mat();
    const brightOtsu = brightOnly
      ? cv.threshold(
          gray,
          brightMask,
          0,
          255,
          cv.THRESH_BINARY | cv.THRESH_OTSU,
        )
      : 0;
    const brightThreshold = brightOnly
      ? brightOtsu + 0.3 * (cv.minMaxLoc(gray, brightMask).maxVal - brightOtsu)
      : 0;
    const roi = settings.roi || {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    };
    let neutral = 0,
      n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          within =
            x / scale >= roi.x &&
            y / scale >= roi.y &&
            x / scale < roi.x + roi.width &&
            y / scale < roi.y + roi.height;
        sat.data[i] =
          within && (!brightOnly || gray.data[i] > brightThreshold)
            ? hsv.data[i * 3 + 1]
            : 0;
        if (within && i % 5 === 0) {
          n++;
          if (sat.data[i] < 60) {
            neutral++;
          }
        }
      }
    // Require neutral background evidence; do not assume that the selected scene is correct.
    if (neutral / Math.max(1, n) < 0.25)
      return brightOnly ? undefined : analyzeChromatic(image, settings, true);
    const otsu = cv.threshold(
      sat,
      mask,
      0,
      255,
      cv.THRESH_BINARY | cv.THRESH_OTSU,
    );
    if (otsu < (brightOnly ? 20 : 70)) return undefined;
    let hueX = 0,
      hueY = 0,
      hueN = 0;
    for (let i = 0; i < w * h; i += 5)
      if (sat.data[i] > Math.max(60, otsu * 0.65) && hsv.data[i * 3 + 2] > 60) {
        const a = (hsv.data[i * 3] * Math.PI) / 90;
        hueX += Math.cos(a);
        hueY += Math.sin(a);
        hueN++;
      }
    // Mixed-color capsules require the general path; a high-saturation-only mask would miss the paler color.
    if (Math.hypot(hueX, hueY) / Math.max(1, hueN) < 0.85) return undefined;
    const threshold = settings.parameters?.threshold ?? otsu;
    cv.threshold(sat, mask, threshold, 255, cv.THRESH_BINARY);
    const fraction = cv.countNonZero(mask) / (w * h);
    if (fraction < 0.002 || fraction > 0.45) return undefined;
    cv.GaussianBlur(gray, smooth, new cv.Size(5, 5), 0);
    const circles = mat();
    cv.HoughCircles(
      smooth,
      circles,
      cv.HOUGH_GRADIENT,
      1,
      Math.min(w, h) * 0.02,
      70,
      settings.parameters?.houghSensitivity ?? 20,
      Math.max(2, Math.round(Math.min(w, h) * 0.008)),
      Math.round(Math.min(w, h) * 0.06),
    );
    const radii: number[] = [];
    for (let i = 0; i < circles.data32F.length; i += 3) {
      const [x, y, r] = circles.data32F.subarray(i, i + 3);
      if (mask.data[Math.round(y) * w + Math.round(x)]) radii.push(r);
    }
    if (radii.length < 3) return undefined;
    let radiusCluster: number[] = [];
    for (const r of radii) {
      const near = radii.filter((v) => v > r * 0.9 && v < r * 1.1);
      if (near.length > radiusCluster.length) radiusCluster = near;
    }
    const radius = settings.parameters?.diameter
      ? (settings.parameters.diameter * scale) / 2
      : median(radiusCluster);
    const components = contours(cv, mask, "color");
    const substantial = components.filter(
      (d) => d.area > Math.PI * radius * radius * 0.2,
    );
    if (!substantial.length) return undefined;
    const pad = radius * 5,
      x0 = Math.max(
        0,
        Math.floor(Math.min(...substantial.map((d) => d.box.x)) - pad),
      ),
      y0 = Math.max(
        0,
        Math.floor(Math.min(...substantial.map((d) => d.box.y)) - pad),
      ),
      x1 = Math.min(
        w,
        Math.ceil(
          Math.max(...substantial.map((d) => d.box.x + d.box.width)) + pad,
        ),
      ),
      y1 = Math.min(
        h,
        Math.ceil(
          Math.max(...substantial.map((d) => d.box.y + d.box.height)) + pad,
        ),
      );
    const view = own(smooth.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0))),
      source = mat();
    view.convertTo(source, cv.CV_32F);
    const candidates: Model[] = [];
    const radiusChoices = [
      ...new Set(
        [0.55, 0.68, 0.95, 1.08, 1.22].map((f) =>
          Math.max(2, Math.round(radius * f)),
        ),
      ),
    ];
    for (const r of radiusChoices)
      for (const ratio of [1, 1.8, 2.1, 2.4, 3.5])
        for (let angle = 0; angle < 180; angle += 15) {
          if (
            (ratio === 1 && angle) ||
            (r < radius * 0.8 && ratio !== 3.5) ||
            (r >= radius * 0.8 && ratio === 3.5)
          )
            continue;
          const a = (angle * Math.PI) / 180,
            half = r * (ratio - 1),
            margin = r * 0.3,
            size = Math.ceil(2 * (half + r + margin)) | 1,
            mid = (size - 1) / 2;
          if (size >= source.cols || size >= source.rows) continue;
          const kernel = cv.Mat.zeros(size, size, cv.CV_32FC1),
            response = new cv.Mat();
          try {
            let pos = 0,
              neg = 0;
            for (let y = 0; y < size; y++)
              for (let x = 0; x < size; x++) {
                const xx = (x - mid) * Math.cos(a) + (y - mid) * Math.sin(a),
                  yy = -(x - mid) * Math.sin(a) + (y - mid) * Math.cos(a),
                  d = Math.hypot(Math.max(0, Math.abs(xx) - half), yy);
                if (d < r * 0.82) {
                  kernel.data32F[y * size + x] = 1;
                  pos++;
                } else if (d > r && d < r + margin) {
                  kernel.data32F[y * size + x] = -1;
                  neg++;
                }
              }
            for (let i = 0; i < size * size; i++)
              kernel.data32F[i] /= kernel.data32F[i] > 0 ? pos : neg;
            cv.matchTemplate(source, kernel, response, cv.TM_CCORR);
            const scores = response.data32F,
              colors = hsv.data;
            for (let y = 1; y < response.rows - 1; y++)
              for (let x = 1; x < response.cols - 1; x++) {
                const j = y * response.cols + x,
                  score = scores[j],
                  cx = x + x0 + mid,
                  cy = y + y0 + mid;
                if (
                  score < 15 ||
                  !mask.data[cy * w + cx] ||
                  colors[(cy * w + cx) * 3 + 1] <
                    Math.max(threshold, brightOnly ? 0 : 102)
                )
                  continue;
                let peak = true;
                for (let dy = -1; dy <= 1 && peak; dy++)
                  for (let dx = -1; dx <= 1; dx++)
                    if (scores[j + dy * response.cols + dx] > score) {
                      peak = false;
                      break;
                    }
                if (peak)
                  candidates.push({ x: cx, y: cy, r, ratio, angle, score });
              }
          } finally {
            kernel.delete();
            response.delete();
          }
        }
    candidates.sort((a, b) => b.score - a.score);
    const coverageCache = new Map<Model, number>();
    const coverage = (t: Model) => {
      const prior = coverageCache.get(t);
      if (prior !== undefined) return prior;
      let n = 0,
        good = 0;
      const step = Math.max(1, Math.round(radius / 7));
      for (
        let y = Math.max(0, Math.floor(t.y - t.r * t.ratio));
        y < Math.min(h, t.y + t.r * t.ratio);
        y += step
      )
        for (
          let x = Math.max(0, Math.floor(t.x - t.r * t.ratio));
          x < Math.min(w, t.x + t.r * t.ratio);
          x += step
        )
          if (inside({ x, y }, t)) {
            n++;
            if (
              sat.data[Math.round(y) * w + Math.round(x)] >
              Math.max(threshold * 0.85, brightOnly ? 0 : 102)
            )
              good++;
          }
      const v = good / Math.max(1, n);
      coverageCache.set(t, v);
      return v;
    };
    const select = (
      bank: Model[],
      floor: number,
      minLength = 0,
      maxLength = Infinity,
    ) => {
      const kept: Model[] = [];
      for (const c of bank) {
        if (
          c.score < floor ||
          c.r * c.ratio * 2 < minLength ||
          c.r * c.ratio * 2 > maxLength ||
          kept.some((t) => conflict(c, t)) ||
          coverage(c) < 0.85
        )
          continue;
        kept.push(c);
        if (kept.length >= 500) break;
      }
      return kept;
    };
    const roundBank = candidates.filter((c) => c.ratio === 1),
      longBank = candidates.filter((c) => c.ratio > 1),
      round = select(roundBank, 18),
      long = select(longBank, 18);
    const strength = (ds: Model[]) =>
      median(ds.slice(0, 5).map((d) => d.score * Math.sqrt(d.ratio)));
    const elongated = strength(long) > strength(round) * 1.25;
    const bank = elongated ? longBank : roundBank,
      seedSet = elongated ? long : round;
    if (seedSet.length < 3) return undefined;
    const length = median(
      seedSet
        .slice(0, Math.max(3, Math.ceil(seedSet.length * 0.6)))
        .map((c) => c.r * c.ratio * 2),
    );
    const kept = select(bank, 18, length * 0.87, length * 1.15);
    if (elongated) {
      // Resolve a merged proposal only when two independently scored, non-overlapping shapes explain it better.
      for (let iteration = 0; iteration < 2; iteration++)
        for (let i = 0; i < kept.length; i++) {
          const current = kept[i],
            others = kept.filter((_, j) => j !== i),
            alternatives: Model[] = [];
          for (const c of bank) {
            if (
              c.r * c.ratio * 2 < length * 0.7 ||
              c.r * c.ratio * 2 > length * 1.15 ||
              c.score < 18 ||
              Math.hypot(c.x - current.x, c.y - current.y) > length ||
              others.some((t) => conflict(c, t)) ||
              coverage(c) < 0.85
            )
              continue;
            if (
              alternatives.some(
                (t) =>
                  Math.hypot(t.x - c.x, t.y - c.y) < radius * 0.36 &&
                  Math.abs(t.angle - c.angle) < 25,
              )
            )
              continue;
            alternatives.push(c);
            if (alternatives.length >= 35) break;
          }
          let best: Model[] | undefined,
            gain = 0;
          for (let a = 0; a < alternatives.length; a++)
            for (let b = a + 1; b < alternatives.length; b++) {
              const aa = alternatives[a],
                bb = alternatives[b];
              if (conflict(aa, bb)) continue;
              const score = aa.score + bb.score - current.score * 1.25 - 15;
              if (score > gain) {
                gain = score;
                best = [aa, bb];
              }
            }
          if (best) {
            kept.splice(i, 1, ...best);
            i++;
          }
        }
    }
    if (!kept.length) return undefined;
    // Full-resolution watershed uses image gradients. Shape proposals supply markers, never an expected count.
    const fullHSV = mat(),
      fullMask = own(cv.Mat.zeros(image.height, image.width, cv.CV_8UC1));
    cv.cvtColor(rgbFull, fullHSV, cv.COLOR_RGB2HSV);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const i = y * image.width + x;
        fullMask.data[i] =
          x >= roi.x &&
          y >= roi.y &&
          x < roi.x + roi.width &&
          y < roi.y + roi.height &&
          fullHSV.data[i * 3 + 1] > threshold &&
          (!brightOnly ||
            0.299 * rgbFull.data[i * 3] +
              0.587 * rgbFull.data[i * 3 + 1] +
              0.114 * rgbFull.data[i * 3 + 2] >
              brightThreshold)
            ? 255
            : 0;
      }
    const marker = own(cv.Mat.zeros(image.height, image.width, cv.CV_32SC1));
    marker.setTo(new cv.Scalar(1));
    const proposals = kept.map((c) => ({
      ...c,
      x: c.x / scale,
      y: c.y / scale,
      r: c.r / scale,
    }));
    for (const c of proposals) {
      for (
        let y = Math.max(1, Math.floor(c.y - c.r * c.ratio));
        y < Math.min(image.height - 1, c.y + c.r * c.ratio);
        y++
      )
        for (
          let x = Math.max(1, Math.floor(c.x - c.r * c.ratio));
          x < Math.min(image.width - 1, c.x + c.r * c.ratio);
          x++
        )
          if (inside({ x, y }, c, 1.12))
            marker.data32S[y * image.width + x] = 0;
    }
    proposals.forEach((c, i) =>
      cv.circle(
        marker,
        new cv.Point(Math.round(c.x), Math.round(c.y)),
        Math.max(1, Math.round(c.r * 0.35)),
        new cv.Scalar(i + 2),
        -1,
      ),
    );
    const seeds = own(marker.clone());
    cv.watershed(rgbFull, marker);
    const region = own(cv.Mat.zeros(image.height, image.width, cv.CV_8UC1)),
      detections: Detection[] = [];
    for (let i = 0; i < proposals.length; i++) {
      const c = proposals[i];
      region.setTo(new cv.Scalar(0));
      for (
        let y = Math.max(1, Math.floor(c.y - c.r * c.ratio * 1.15));
        y < Math.min(image.height - 1, c.y + c.r * c.ratio * 1.15);
        y++
      )
        for (
          let x = Math.max(1, Math.floor(c.x - c.r * c.ratio * 1.15));
          x < Math.min(image.width - 1, c.x + c.r * c.ratio * 1.15);
          x++
        ) {
          const k = y * image.width + x;
          if (marker.data32S[k] === i + 2 && fullMask.data[k])
            region.data[k] = 255;
        }
      const parts = contours(cv, region, "chromatic").sort(
          (a, b) => b.area - a.area,
        ),
        d = parts[0];
      if (d && d.area > Math.PI * c.r * c.r * 0.15) {
        d.center = { x: c.x, y: c.y };
        d.id = "cv-" + (i + 1);
        d.flags.push("袋・刻印・重なりを目視確認");
        detections.push(d);
      }
    }
    // A score line or dark writing can split one elongated face into two compact basins.
    // Merge only two small nearby fragments whose joint hull fits the observed single-pill scale.
    let fragmentMerges = 0;
    if (elongated) {
      const referenceArea = median(detections.map((d) => d.area)),
        expectedLength = length / scale;
      for (let i = 0; i < detections.length; i++)
        for (let j = i + 1; j < detections.length; j++) {
          const a = detections[i],
            b = detections[j];
          if (
            a.shape!.aspect > 1.35 ||
            b.shape!.aspect > 1.35 ||
            a.area > referenceArea * 0.7 ||
            b.area > referenceArea * 0.7 ||
            Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) >
              (radius / scale) * 2.6
          )
            continue;
          const points = cv.matFromArray(
              a.contour.length + b.contour.length,
              1,
              cv.CV_32SC2,
              [...a.contour, ...b.contour].flatMap((p) => [p.x, p.y]),
            ),
            hull = new cv.Mat();
          try {
            cv.convexHull(points, hull);
            const rr = cv.minAreaRect(hull),
              major = Math.max(rr.size.width, rr.size.height),
              minor = Math.min(rr.size.width, rr.size.height),
              area = cv.contourArea(hull);
            if (
              major < expectedLength * 0.7 ||
              major > expectedLength * 1.25 ||
              major / minor < 1.4 ||
              area > referenceArea * 1.3 ||
              (a.area + b.area) / area < 0.65
            )
              continue;
            const contour = [];
            for (let k = 0; k < hull.data32S.length; k += 2)
              contour.push({ x: hull.data32S[k], y: hull.data32S[k + 1] });
            const m = cv.moments(hull),
              box = cv.boundingRect(hull),
              perimeter = cv.arcLength(hull, true);
            detections[i] = {
              ...a,
              contour,
              center: { x: m.m10 / m.m00, y: m.m01 / m.m00 },
              area,
              box: { x: box.x, y: box.y, width: box.width, height: box.height },
              shape: {
                aspect: major / minor,
                solidity: 1,
                circularity: (4 * Math.PI * area) / (perimeter * perimeter),
                perimeter,
              },
              flags: [...a.flags, "刻印・印字で分かれた領域を統合。要確認"],
            };
            detections.splice(j, 1);
            j--;
            fragmentMerges++;
          } finally {
            points.delete();
            hull.delete();
          }
        }
    }
    detections.sort(
      (a, b) => a.center.y - b.center.y || a.center.x - b.center.x,
    );
    detections.forEach((d, i) => (d.id = `cv-${i + 1}`));
    const alternate = splitWatershed(cv, mask, { x: 0, y: 0 });
    owned.push(alternate.distance, alternate.markers, alternate.seedsImage);
    const debug: Record<string, DebugImage> = {};
    if (settings.debug) {
      const raster = (m: any, mode = "gray"): DebugImage => {
        const data =
            mode === "labels"
              ? m.data32S
              : mode === "distance"
                ? m.data32F
                : m.data,
          out = new Uint8ClampedArray(data.length * 4);
        let max = 1;
        if (mode === "distance") for (const v of data) max = Math.max(max, v);
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
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
        return {
          width: m.cols,
          height: m.rows,
          data: out,
          origin: { x: 0, y: 0 },
        };
      };
      const distFull = mat();
      cv.distanceTransform(fullMask, distFull, cv.DIST_L2, 5);
      debug.Threshold = raster(fullMask);
      debug.Morphology = raster(fullMask);
      debug["Foreground mask"] = raster(fullMask);
      debug.Markers = raster(seeds, "labels");
      debug.Watershed = raster(marker, "labels");
      debug["Distance transform"] = raster(distFull, "distance");
      const grayFull = mat();
      cv.cvtColor(rgbFull, grayFull, cv.COLOR_RGB2GRAY);
      debug.Grayscale = raster(grayFull);
      const roiMask = own(cv.Mat.zeros(image.height, image.width, cv.CV_8UC1));
      cv.rectangle(
        roiMask,
        new cv.Point(roi.x, roi.y),
        new cv.Point(roi.x + roi.width - 1, roi.y + roi.height - 1),
        new cv.Scalar(255),
        -1,
      );
      debug.ROI = raster(roiMask);
    }
    return {
      version: "0.3.0",
      width: image.width,
      height: image.height,
      roi,
      detections,
      candidates: detections,
      counts: {
        A: substantial.length,
        B: detections.length,
        C: alternate.detections.filter(
          (d) => d.area > Math.PI * radius * radius * 0.35,
        ).length,
      },
      confidence: {
        level: "review",
        reasons: [
          "透明袋・着色錠剤の補助検出。反射、刻印、重なりを手動確認してください",
          "形状照合と距離分離の一致は保証されていません",
        ],
      },
      debug,
      diagnostics: [
        `彩度 Otsu=${otsu.toFixed(1)} / 明度支持=${brightOnly ? brightThreshold.toFixed(1) : "なし"}`,
        `推定半径 ${(radius / scale).toFixed(1)}px / 形状評価 ${strength(round).toFixed(1)} / ${strength(long).toFixed(1)} / 形状 ${elongated ? "長円形" : "丸形"}`,
        `長軸 ${length.toFixed(1)} / 色領域 ${substantial.length} / 形状候補 ${kept.length} / 断片統合 ${fragmentMerges} / 採用 ${detections.length}`,
        `輪郭の精密化は ${image.width}×${image.height}、形状探索は ${w}×${h}`,
      ],
      elapsed: performance.now() - start,
      estimatedDiameter: (radius * 2) / scale,
      algorithm: "色成分 + 回転形状照合 + 重複抑制 + 原解像度Watershed",
    };
  } finally {
    for (const m of owned.reverse()) m.delete();
  }
}
