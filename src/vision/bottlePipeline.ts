import type { Analysis, Detection, Raster, Settings } from "../types";
import { getCV } from "./opencv";
import { clampROI } from "./pipeline";
import { contours } from "./shapeFilter";
import { repeatedCapRegions, type RegionView } from "./capRegions";
import { recoverTiltedCaps } from "./tiltedCaps";

/** Cap-only counter. The pill model is deliberately not used for bottles. */
export async function analyzeBottles(
  image: Raster,
  settings: Settings,
): Promise<Analysis> {
  const start = performance.now(),
    { cv } = await getCV();
  const roi = clampROI(
    settings.roi || { x: 0, y: 0, width: image.width, height: image.height },
    image.width,
    image.height,
  );
  const scale = Math.min(1, 1200 / Math.max(roi.width, roi.height));
  const owned: any[] = [];
  const keep = <T>(v: T): T => {
    owned.push(v);
    return v;
  };
  const mat = () => keep(new cv.Mat());
  try {
    const full = keep(cv.matFromImageData(image as ImageData));
    const crop = keep(
        full.roi(new cv.Rect(roi.x, roi.y, roi.width, roi.height)),
      ),
      small = mat(),
      rgb = mat(),
      gray = mat(),
      hsv = mat();
    cv.resize(
      crop,
      small,
      new cv.Size(
        Math.round(roi.width * scale),
        Math.round(roi.height * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const w = small.cols,
      h = small.rows,
      minSide = Math.min(image.width, image.height) * scale;
    const color = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    const valueChannel = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    for (let i = 0; i < w * h; i++) {
      const s = hsv.data[i * 3 + 1],
        v = hsv.data[i * 3 + 2];
      // Saturation rejects clear drawers and grey reflections, retaining cap edges.
      color.data[i] = s > 55 && v > 65 ? Math.min(255, s * 0.4 + v * 0.6) : 0;
      valueChannel.data[i] = v;
    }
    const minRadius = Math.max(7, Math.round(minSide * 0.014)),
      maxRadius = Math.round(minSide * 0.075);
    type Cap = {
      x: number;
      y: number;
      r: number;
      score: number;
      hue: number;
      value: number;
      saturation: number;
      region: boolean;
    };
    const proposals: Cap[] = [];
    const stages: Record<string, number> = {};
    const reject = (reason: string) => {
      stages[reason] = (stages[reason] || 0) + 1;
    };
    const at = (m: any, x: number, y: number) =>
      m.data[
        Math.max(0, Math.min(h - 1, Math.round(y))) * w +
          Math.max(0, Math.min(w - 1, Math.round(x)))
      ];
    const consider = (
      x: number,
      y: number,
      r: number,
      channel: any,
      bonus = 0,
    ) => {
      if (x - r < 0 || y - r < 0 || x + r >= w || y + r >= h) return;
      let saturated = 0,
        n = 0,
        sin = 0,
        cos = 0,
        edge = 0,
        sectors = 0,
        value = 0,
        saturation = 0;
      const hues: number[] = [];
      for (let yy = -3; yy <= 3; yy++)
        for (let xx = -3; xx <= 3; xx++) {
          if (xx * xx + yy * yy > 9) continue;
          const px = Math.round(x + xx * r * 0.22),
            py = Math.round(y + yy * r * 0.22),
            k = (py * w + px) * 3;
          n++;
          value += hsv.data[k + 2];
          saturation += hsv.data[k + 1];
          if (hsv.data[k + 1] > 65 && hsv.data[k + 2] > 70) {
            saturated++;
            hues.push((hsv.data[k] * Math.PI) / 90);
          }
        }
      if (saturated / n < 0.65) return;
      let cluster: number[] = [];
      for (const hue of hues) {
        const near = hues.filter(
          (h) =>
            Math.abs(Math.atan2(Math.sin(h - hue), Math.cos(h - hue))) < 0.3,
        );
        if (near.length > cluster.length) cluster = near;
      }
      if (cluster.length / n < 0.58) return;
      for (const hue of cluster) {
        sin += Math.sin(hue);
        cos += Math.cos(hue);
      }
      // Rim evidence must surround the cap; one straight body edge is insufficient.
      for (let k = 0; k < 24; k++) {
        const a = (k * Math.PI) / 12;
        let strongest = 0;
        for (const rr of [0.86, 1, 1.12]) {
          const inside = at(
            channel,
            x + Math.cos(a) * r * (rr - 0.12),
            y + Math.sin(a) * r * (rr - 0.12),
          );
          const outside = at(
            channel,
            x + Math.cos(a) * r * (rr + 0.12),
            y + Math.sin(a) * r * (rr + 0.12),
          );
          strongest = Math.max(strongest, Math.abs(inside - outside));
        }
        edge += Math.min(60, strongest);
        if (strongest > 12) sectors++;
      }
      if (sectors < 15 || edge / 24 < 18) {
        reject("輪郭不足");
        return;
      }
      proposals.push({
        x,
        y,
        r,
        score: Math.min(3, sectors / 24 + edge / 1440 + saturated / n + bonus),
        hue: Math.atan2(sin, cos),
        value: value / n,
        saturation: saturation / n,
        region: bonus > 0 || channel === valueChannel,
      });
    };
    for (const channel of [gray, color, valueChannel]) {
      const smooth = mat(),
        circles = mat();
      cv.GaussianBlur(channel, smooth, new cv.Size(5, 5), 0);
      cv.HoughCircles(
        smooth,
        circles,
        cv.HOUGH_GRADIENT,
        1.2,
        minRadius * 1.5,
        80,
        23,
        minRadius,
        maxRadius,
      );
      for (let i = 0; i < circles.data32F.length; i += 3) {
        const [x, y, r] = circles.data32F.slice(i, i + 3);
        consider(x, y, r, channel);
      }
    }
    // Closed, compact color regions provide centers even when a weak rim is
    // missed by Hough. Multiple value thresholds avoid one lighting cutoff.
    const mask = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    const regionViews: RegionView[] = [];
    for (let threshold = 105; threshold <= 240; threshold += 10) {
      for (let i = 0; i < w * h; i++)
        mask.data[i] =
          hsv.data[i * 3 + 1] > 65 && hsv.data[i * 3 + 2] > threshold ? 255 : 0;
      for (const d of contours(cv, mask, "cap-region")) {
        const r = Math.sqrt(d.area / Math.PI);
        if (
          r >= minRadius &&
          r <= maxRadius &&
          d.shape &&
          d.shape.circularity > 0.62 &&
          d.shape.solidity > 0.88 &&
          d.shape.aspect < 2.3
        )
          regionViews.push({ detection: d, threshold });
        if (
          r < minRadius ||
          r > maxRadius ||
          !d.shape ||
          d.shape.circularity < 0.77 ||
          d.shape.solidity < 0.93 ||
          d.shape.aspect > 1.4
        )
          continue;
        consider(d.center.x, d.center.y, r, color, 0.25);
      }
    }
    // Robust diameter mode prevents small printed logos and wide bottle bodies counting.
    let radius = 0,
      weight = 0;
    const circlesOnly = proposals.filter((p) => !p.region);
    const strong = circlesOnly.filter((p) => p.score > 2.85),
      seeds = strong.length >= 5 ? strong : circlesOnly;
    for (const p of seeds) {
      const near = seeds.filter((q) => q.r > p.r * 0.9 && q.r < p.r * 1.1);
      const sum = near.reduce(
        (s, q) => s + Math.pow(q.score, 12) / (q.r * q.r),
        0,
      );
      if (sum > weight) {
        weight = sum;
        radius = p.r;
      }
    }
    const bank = circlesOnly.filter(
      (p) => p.r > radius * 0.8 && p.r < radius * 1.2,
    );
    let hue = 0,
      hueWeight = 0;
    const hueDistance = (a: number, b: number) =>
      Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (const p of bank) {
      const weight = bank
        .filter((q) => hueDistance(q.hue, p.hue) < 0.25)
        .reduce((s, q) => s + q.score, 0);
      if (weight > hueWeight) {
        hueWeight = weight;
        hue = p.hue;
      }
    }
    const hues: number[] = [];
    for (const p of bank) {
      if (hues.some((h) => hueDistance(h, p.hue) < 0.3)) continue;
      const count = bank.filter((q) => hueDistance(p.hue, q.hue) < 0.25).length;
      const dominant = bank.filter(
        (q) => hueDistance(hue, q.hue) < 0.25,
      ).length;
      if (count >= Math.max(2, dominant * 0.25)) hues.push(p.hue);
    }
    const typicalValue = (hue: number) => {
      const values = bank
        .filter((p) => hueDistance(p.hue, hue) < 0.3)
        .map((p) => p.value)
        .sort((a, b) => a - b);
      return values[Math.floor(values.length * 0.7)] || 0;
    };
    const kept: Cap[] = [];
    // Repeated proposals for one cap do not make a reliable photo-wide majority.
    const distinct: Cap[] = [];
    for (const p of bank)
      if (
        !distinct.some(
          (q) => Math.hypot(p.x - q.x, p.y - q.y) < Math.max(p.r, q.r) * 1.5,
        )
      )
        distinct.push(p);
    const saturations = bank.map((p) => p.saturation).sort((a, b) => a - b);
    const referenceSaturation =
      saturations[Math.floor(saturations.length * 0.6)] || 0;
    const rank = (p: Cap) =>
      p.score - Math.abs(Math.log(p.r / Math.max(1, radius))) * 1.8;
    for (const p of proposals.sort((a, b) => rank(b) - rank(a))) {
      if (
        distinct.length >= 6 &&
        (p.r < radius * 0.78 ||
          p.r > radius * 1.22 ||
          p.saturation < referenceSaturation * 0.6 ||
          !hues.some((h) => hueDistance(p.hue, h) < 0.3) ||
          p.value < typicalValue(p.hue) * 0.8)
      ) {
        reject("代表形状・色の不一致");
        continue;
      }
      if (
        kept.some(
          (q) => Math.hypot(p.x - q.x, p.y - q.y) < Math.max(p.r, q.r) * 1.75,
        )
      ) {
        reject("近接候補の重複除去");
        continue;
      }
      kept.push(p);
    }
    // Some caps have a repeated contrasting seal. Enable this evidence only
    // when the photograph itself shows it on most strong circular cap candidates.
    // A seal is never added as a bottle without a nearby supported cap circle.
    const marksMask = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    for (let i = 0; i < w * h; i++) {
      const k = i * 3;
      if (
        rgb.data[k] > 140 &&
        rgb.data[k] > rgb.data[k + 1] * 1.5 &&
        rgb.data[k] > rgb.data[k + 2] * 1.5
      )
        marksMask.data[i] = 255;
    }
    const sealRegions = contours(cv, marksMask, "seal");
    const marks = sealRegions.filter(
      (d) =>
        d.area > radius * radius * 0.012 &&
        d.area < radius * radius * 0.5 &&
        ((d.shape!.solidity > 0.7 && d.shape!.aspect < 3.5) ||
          (d.shape!.solidity > 0.55 && d.shape!.aspect < 1.5)),
    );
    const sealNear = (p: Cap, m: Detection) =>
      Math.hypot(p.x - m.center.x, p.y - m.center.y) < p.r * 1.05;
    const strongKept = kept.filter((p) => p.score > 2.8);
    let finalCaps = kept;
    let tilted: Detection[] = [];
    let unresolvedSeals = 0;
    if (
      Math.abs(hue) > 2 &&
      strongKept.length >= 8 &&
      strongKept.filter((p) => marks.some((m) => sealNear(p, m))).length /
        strongKept.length >
        0.7
    ) {
      const supported: Cap[] = [];
      for (const m of marks) {
        const choices = proposals.filter(
          (p) =>
            p.r > radius * 0.7 &&
            p.r < radius * 1.25 &&
            p.score > 2.45 &&
            hueDistance(p.hue, hue) < 0.4 &&
            sealNear(p, m),
        );
        choices.sort((a, b) => rank(b) - rank(a));
        const best = choices[0];
        if (
          best &&
          !supported.some(
            (p) => Math.hypot(p.x - best.x, p.y - best.y) < radius * 1.35,
          )
        )
          supported.push(best);
      }
      finalCaps = supported;
      // A tilted seal is often narrow and fails the upright shape filter.
      // Broader regions can trigger local inspection, never a count by themselves.
      const unmatched = sealRegions.filter(
        (m) =>
          m.area > radius * radius * 0.012 &&
          m.area < radius * radius * 0.5 &&
          m.shape!.solidity > 0.4 &&
          m.shape!.aspect < 8 &&
          !supported.some((p) => sealNear(p, m)),
      );
      tilted = recoverTiltedCaps(cv, gray, hsv, unmatched, radius, hue).filter(
        (d) =>
          !supported.some(
            (p) => Math.hypot(p.x - d.center.x, p.y - d.center.y) < radius,
          ),
      );
      unresolvedSeals = Math.max(0, unmatched.length - tilted.length);
    }
    let detections: Detection[] = finalCaps
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((p, i) => {
        const x = roi.x + p.x / scale,
          y = roi.y + p.y / scale,
          r = p.r / scale;
        return {
          id: `cap-${i + 1}`,
          center: { x, y },
          area: Math.PI * r * r,
          box: { x: x - r, y: y - r, width: 2 * r, height: 2 * r },
          contour: Array.from({ length: 32 }, (_, k) => ({
            x: x + r * Math.cos((k * Math.PI) / 16),
            y: y + r * Math.sin((k * Math.PI) / 16),
          })),
          source: "cv",
          flags: ["キャップ輪郭からの試験検出"],
          score: p.score / 3,
        };
      });
    const regions = repeatedCapRegions(regionViews);
    if (regions.enabled) {
      detections = regions.detections.map((d) => ({
        ...d,
        center: {
          x: roi.x + d.center.x / scale,
          y: roi.y + d.center.y / scale,
        },
        box: {
          x: roi.x + d.box.x / scale,
          y: roi.y + d.box.y / scale,
          width: d.box.width / scale,
          height: d.box.height / scale,
        },
        area: d.area / (scale * scale),
        contour: d.contour.map((p) => ({
          x: roi.x + p.x / scale,
          y: roi.y + p.y / scale,
        })),
      }));
    }
    if (!regions.enabled)
      detections.push(
        ...tilted.map((d) => ({
          ...d,
          center: {
            x: roi.x + d.center.x / scale,
            y: roi.y + d.center.y / scale,
          },
          box: {
            x: roi.x + d.box.x / scale,
            y: roi.y + d.box.y / scale,
            width: d.box.width / scale,
            height: d.box.height / scale,
          },
          area: d.area / (scale * scale),
          contour: d.contour.map((p) => ({
            x: roi.x + p.x / scale,
            y: roi.y + p.y / scale,
          })),
        })),
      );
    detections.sort(
      (a, b) => a.center.y - b.center.y || a.center.x - b.center.x,
    );
    detections = detections.map((d, i) => ({ ...d, id: `cap-${i + 1}` }));
    return {
      version: "0.9.0",
      width: image.width,
      height: image.height,
      roi,
      detections,
      counts: {
        A: detections.length,
        B: detections.length,
        C: detections.length,
      },
      confidence: {
        level: "review",
        reasons: [
          "キャップ1個を1本として数えます。",
          "横倒し・重なり・透明や白いキャップは見逃す場合があります。番号を確認してください。",
          ...(unresolvedSeals
            ? [
                `輪郭を確定できない封印候補が${unresolvedSeals}か所あります。横倒し部分を確認してください（本数には未加算）。`,
              ]
            : []),
        ],
      },
      elapsed: performance.now() - start,
      debug: {},
      candidates: proposals.map((p, i) => ({
            id: `proposal-${i}`,
            center: { x: roi.x + p.x / scale, y: roi.y + p.y / scale },
            box: {
              x: roi.x + (p.x - p.r) / scale,
              y: roi.y + (p.y - p.r) / scale,
              width: (2 * p.r) / scale,
              height: (2 * p.r) / scale,
            },
            area: Math.PI * (p.r / scale) ** 2,
            contour: [],
            source: "cv" as const,
            score: p.score,
            flags: [p.region ? "region" : "hough"],
          })),
      diagnostics: [
        `キャップ候補 ${proposals.length} / 採用 ${detections.length}`,
        `非円形の安定領域 ${regions.stable} / 写真内の形状基準 ${regions.enabled ? "有効" : "保留"} / 形状照合で補完 ${regions.recovered || 0}`,
        `傾斜キャップの局所復元 ${tilted.length} / 未確定の封印候補 ${unresolvedSeals}`,
        ...Object.entries(stages).map(
          ([stage, n]) => `円形候補・${stage}: ${n}`,
        ),
        `代表半径 ${radius.toFixed(1)}`,
      ],
      algorithm: "点眼ボトル・色付きキャップ検出",
      aiStatus: "点眼ボトルは専用画像処理で解析（錠剤用AIは適用しません）",
    };
  } finally {
    for (const m of owned.reverse()) m.delete();
  }
}
