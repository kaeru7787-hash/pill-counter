import type { Detection, Raster } from "../types";
import type { AICandidate } from "./onnxDetector";

const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] || 0;
const quantile = (a: number[], q: number) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] || 0;
export function appearance(image: Raster, d: Detection) {
  const rgb = [0, 0, 0];
  let n = 0,
    square = 0,
    light = 0;
  // Small interior patch avoids surrounding foil and is scale independent.
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      if (x * x + y * y > 16) continue;
      const px = Math.round(d.center.x + (x * d.box.width) / 24),
        py = Math.round(d.center.y + (y * d.box.height) / 24);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const p = (py * image.width + px) * 4;
      const l = (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
      for (let c = 0; c < 3; c++) rgb[c] += image.data[p + c];
      light += l;
      square += l * l;
      n++;
    }
  return {
    rgb: rgb.map((v) => v / Math.max(1, n)),
    texture: Math.sqrt(
      Math.max(0, square / Math.max(1, n) - (light / Math.max(1, n)) ** 2),
    ),
  };
}
export function associated(c: Detection, a: Detection) {
  const overlap =
    Math.max(
      0,
      Math.min(c.box.x + c.box.width, a.box.x + a.box.width) -
        Math.max(c.box.x, a.box.x),
    ) *
    Math.max(
      0,
      Math.min(c.box.y + c.box.height, a.box.y + a.box.height) -
        Math.max(c.box.y, a.box.y),
    );
  return (
    Math.hypot(c.center.x - a.center.x, c.center.y - a.center.y) <
      0.5 * Math.min(a.box.width, a.box.height) &&
    overlap /
      Math.max(
        1,
        c.box.width * c.box.height + a.box.width * a.box.height - overlap,
      ) >
      0.05
  );
}
export function referenceProfile(
  cv: Detection[],
  stable: AICandidate[],
  image?: Raster,
) {
  const pairs = stable.flatMap((a) => {
    const matches = cv.filter(
      (c) =>
        associated(c, a) &&
        c.shape &&
        c.area / (a.box.width * a.box.height) > 0.35 &&
        c.area / (a.box.width * a.box.height) < 1.15,
    );
    return matches.length === 1 ? matches : [];
  });
  const clean = pairs.filter(
    (d) => d.shape!.solidity > 0.88 && d.shape!.circularity > 0.45,
  );
  const reference = clean.length >= 5 ? clean : stable;
  const areas = reference.map((d) =>
    d.source === "ai" ? d.area * 0.75 : d.area,
  );
  const colors = image ? stable.map((d) => appearance(image, d).rgb) : [];
  const rgb = [0, 1, 2].map((c) => median(colors.map((v) => v[c])));
  return {
    ready: stable.length >= 5,
    uniform:
      stable.length >= 5 &&
      quantile(
        stable.map((d) => d.area),
        0.9,
      ) /
        Math.max(
          1,
          quantile(
            stable.map((d) => d.area),
            0.1,
          ),
        ) <
        2.3,
    area: median(areas),
    aspect:
      median(clean.map((d) => d.shape!.aspect)) ||
      median(
        stable.map(
          (d) =>
            Math.max(d.box.width, d.box.height) /
            Math.min(d.box.width, d.box.height),
        ),
      ),
    circularity: median(clean.map((d) => d.shape!.circularity)) || 0.8,
    rgb,
  };
}
export type Profile = ReturnType<typeof referenceProfile>;
export function candidateFeatures(d: Detection, p: Profile, image?: Raster) {
  const a = image ? appearance(image, d) : { rgb: p.rgb, texture: 0 };
  return [
    Math.log(Math.max(0.005, Math.min(100, d.area / Math.max(1, p.area)))),
    d.shape?.circularity ?? 0.8,
    d.shape?.solidity ?? 1,
    Math.log(Math.max(1, d.shape?.aspect ?? 1)),
    d.area / Math.max(1, d.box.width * d.box.height),
    Math.hypot(...a.rgb.map((v, i) => v - p.rgb[i])) / 255,
    a.texture / 64,
  ];
}
export function anomalyReasons(d: Detection, p: Profile, image?: Raster) {
  if (!p.ready || !p.uniform || !d.shape) return [];
  const f = candidateFeatures(d, p, image),
    ratio = Math.exp(f[0]),
    reasons: string[] = [];
  if (ratio < 0.55 || ratio > 1.9) reasons.push("同一画像の標準サイズと不一致");
  if (d.shape.circularity < p.circularity * 0.8)
    reasons.push("標準形状より不規則な輪郭");
  if (d.shape.aspect > Math.max(p.aspect * 1.5, p.aspect + 0.6))
    reasons.push("標準形状より細長い");
  if (d.shape.solidity < 0.82) reasons.push("輪郭内部の欠損が大きい");
  if (image && f[5] > 0.27) reasons.push("錠剤群と色が異なる");
  return reasons;
}
