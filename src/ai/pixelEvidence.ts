import type { Detection, Raster } from "../types";
import { appearance } from "./candidateReview";

const median = (v: number[]) =>
  [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] || 0;
/** Calibrated from clean CV/AI agreements, never from the requested count. */
export function pixelReference(image: Raster, references: Detection[]) {
  const colors = references.map((d) => appearance(image, d).rgb);
  const rgb = [0, 1, 2].map((i) => median(colors.map((c) => c[i])));
  const distances = colors.map((c) =>
    Math.hypot(...c.map((v, i) => v - rgb[i])),
  );
  const spread = median(distances);
  const upper =
    [...distances].sort((a, b) => a - b)[Math.floor(distances.length * 0.9)] ||
    0;
  return {
    rgb,
    ready: references.length >= 8 && spread < 45 && upper < 90,
    tolerance: Math.max(60, Math.min(95, spread * 2.5 + 35)),
  };
}
export function pixelRejection(
  image: Raster,
  d: Detection,
  reference: ReturnType<typeof pixelReference>,
  neighbors: Detection[] = [],
) {
  if (!reference.ready) return [];
  const { rgb, tolerance } = reference;
  let n = 0,
    matching = 0,
    freeMatching = 0,
    occupied = 0;
  const lights: number[] = [],
    outer: number[] = [];
  const near = neighbors.filter(
    (p) =>
      p !== d &&
      p.area > d.area * 0.4 &&
      Math.hypot(p.center.x - d.center.x, p.center.y - d.center.y) <
        Math.max(d.box.width, d.box.height) * 1.6,
  );
  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height)
      return undefined;
    const i =
      (Math.min(image.height - 1, Math.round(y)) * image.width +
        Math.min(image.width - 1, Math.round(x))) *
      4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  for (let y = -5; y <= 5; y++)
    for (let x = -5; x <= 5; x++) {
      if (x * x + y * y > 25) continue;
      const px = d.center.x + (x * d.box.width) / 14,
        py = d.center.y + (y * d.box.height) / 14;
      const c = sample(px, py);
      if (!c) continue;
      n++;
      lights.push((c[0] + c[1] + c[2]) / 3);
      const owns = near.some(
        (p) =>
          ((px - p.center.x) / (p.box.width * 0.5)) ** 2 +
            ((py - p.center.y) / (p.box.height * 0.5)) ** 2 <
          1,
      );
      if (owns) occupied++;
      if (Math.hypot(...c.map((v, i) => v - rgb[i])) < tolerance) {
        matching++;
        if (!owns) freeMatching++;
      }
    }
  for (let k = 0; k < 24; k++) {
    const a = (k * Math.PI) / 12,
      c = sample(
        d.center.x + Math.cos(a) * d.box.width * 0.62,
        d.center.y + Math.sin(a) * d.box.height * 0.62,
      );
    if (c) outer.push((c[0] + c[1] + c[2]) / 3);
  }
  if (n < 40) return [];
  const center = median(lights),
    surround = median(outer),
    refLight = rgb.reduce((a, b) => a + b) / 3;
  // Three independent signs: unlike reference, dark interior, no brighter object.
  // A dark score line alone cannot fail the sampled interior coverage.
  if (matching / n < 0.25 && center < refLight * 0.84 && center - surround < 12)
    return ["内部が錠剤群の色と異なる", "周囲から独立した錠剤領域がない"];
  // A candidate in a gap must contain new foreground, not just adjacent pills.
  if (
    occupied / n > 0.2 &&
    freeMatching / n < 0.06 &&
    matching / n < 0.45 &&
    center < refLight * 0.82
  )
    return ["隣接する検出済み錠剤を含む候補", "新しい1錠分の内部領域がない"];
  return [];
}
