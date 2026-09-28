import type { Detection, Raster } from "../types";
import { appearance } from "./candidateReview";
import { contains, singleObjectContours } from "./objectIdentity";

const median = (v: number[]) =>
  [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] || 0;
// Directed transitions around the object's boundary. A neighboring bright pill
// does not provide an outward transition for a candidate centered in a gap.
export function boundaryEvidence(image: Raster, d: Detection) {
  const light = (x: number, y: number) => {
    x = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    y = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    const i = (y * image.width + x) * 4;
    return (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
  };
  const edges: number[] = [];
  for (let k = 0; k < 32; k++) {
    const angle = (k * Math.PI) / 16;
    const at = (r: number) =>
      light(
        d.center.x + Math.cos(angle) * d.box.width * 0.5 * r,
        d.center.y + Math.sin(angle) * d.box.height * 0.5 * r,
      );
    let edge = 0;
    for (const r of [0.8, 0.9, 1, 1.1, 1.2])
      edge = Math.max(edge, at(r - 0.06) - at(r + 0.06));
    edges.push(edge);
  }
  return edges.reduce((a, b) => a + b, 0) / edges.length;
}
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
  const widths = references.map((d) => d.box.width).sort((a, b) => a - b);
  const heights = references.map((d) => d.box.height).sort((a, b) => a - b);
  const consistent = (sizes: number[]) =>
    sizes[Math.floor(sizes.length * 0.9)] /
      Math.max(1, sizes[Math.floor(sizes.length * 0.1)]) <
    1.5;
  return {
    rgb,
    ready: references.length >= 8 && spread < 45 && upper < 90,
    tolerance: Math.max(60, Math.min(95, spread * 2.5 + 35)),
    area: median(references.map((d) => d.area)),
    edge: median(references.map((d) => boundaryEvidence(image, d))),
    round: median(references.map((d) => d.shape?.aspect || 1)) < 1.3,
    width: median(widths),
    height: median(heights),
    uniformSize: consistent(widths) && consistent(heights),
  };
}

/** Illumination varies across a tray. Only measured optical objects calibrate
 * local colour; newly added AI objects never bootstrap one another's acceptance.
 * A dark candidate must also have its own boundary before using this correction. */
export function contextualPixelReference(
  image: Raster,
  references: Detection[],
) {
  const global = pixelReference(image, references);
  const samples = references.map((d) => ({ d, rgb: appearance(image, d).rgb }));
  return (candidate: Detection) => {
    if (!global.ready) return global;
    const radius =
      8 *
      Math.min(
        Math.max(candidate.box.width, candidate.box.height),
        Math.max(global.width, global.height),
      );
    const near = samples
      .map((s) => ({
        ...s,
        distance: Math.hypot(
          s.d.center.x - candidate.center.x,
          s.d.center.y - candidate.center.y,
        ),
      }))
      .filter((s) => s.d !== candidate && s.distance < radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    if (near.length < 6) return global;
    const rgb = [0, 1, 2].map((i) => median(near.map((s) => s.rgb[i])));
    const light = (c: number[]) => c.reduce((a, b) => a + b, 0) / 3;
    const ratio = light(rgb) / Math.max(1, light(global.rgb));
    if (ratio >= 0.98 || ratio < 0.75) return global;
    // A detector rectangle can include padding, especially on a side-on pill.
    // Search inside it as well; the measured core must still pass colour checks.
    const edge = Math.max(
      ...[1, 0.75, 0.55].map((scale) =>
        boundaryEvidence(image, {
          ...candidate,
          box: {
            ...candidate.box,
            width: candidate.box.width * scale,
            height: candidate.box.height * scale,
          },
        }),
      ),
    );
    if (edge < Math.max(12, global.edge * 0.2)) return global;
    return { ...global, rgb };
  };
}
export function pixelRejection(
  image: Raster,
  d: Detection,
  reference: ReturnType<typeof pixelReference>,
  neighbors: Detection[] = [],
) {
  if (!reference.ready) return [];
  // A detector box includes padding and is not a foreground contour. For a
  // uniform round family, inspect at the independently measured CV size when
  // the AI box is substantially wider. Do not sample background as the pill's
  // interior or search for its boundary outside the physical tablet.
  if (
    d.source === "ai" &&
    reference.round &&
    reference.uniformSize &&
    d.box.width > reference.width * 1.3 &&
    d.box.height > reference.height * 1.3
  ) {
    d = {
      ...d,
      box: {
        x: d.center.x - reference.width / 2,
        y: d.center.y - reference.height / 2,
        width: reference.width,
        height: reference.height,
      },
    };
  }
  const { rgb, tolerance } = reference;
  let n = 0,
    matching = 0,
    freeMatching = 0,
    occupied = 0,
    ownedMatching = 0;
  const singles = singleObjectContours(neighbors).filter(
    (p) =>
      p !== d &&
      p.box.x <= d.box.x + d.box.width &&
      p.box.x + p.box.width >= d.box.x &&
      p.box.y <= d.box.y + d.box.height &&
      p.box.y + p.box.height >= d.box.y,
  );
  const lights: number[] = [],
    outer: number[] = [],
    chroma: number[] = [];
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
      chroma.push(c[0] - c[2]);
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
        if (singles.some((p) => contains(p, { x: px, y: py }))) ownedMatching++;
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
  // A neutral specular highlight cannot supply the chromatic body of a
  // consistent coloured family. Brightness alone previously passed this test.
  if (rgb[0] - rgb[2] > 35 && median(chroma) < (rgb[0] - rgb[2]) * 0.35)
    return ["錠剤群の色成分がない", "無彩色の反射・背景の可能性"];
  const edge = boundaryEvidence(image, d);
  // Only use a sharp, round, photo-local reference. Weakly lit or elongated
  // tablets retain the conservative color checks below.
  if (reference.round && reference.edge > 50) {
    if (edge < reference.edge * 0.18 && center < refLight * 0.92)
      return ["候補自身の外周が確認できない", "周辺錠剤・背景の領域"];
    if (
      !d.flags.includes("独立した円周支持") &&
      d.area < reference.area * 0.65 &&
      edge < reference.edge * 0.6 &&
      (d.shape?.circularity ?? 1) < 0.78
    )
      return ["錠剤群より小さく外周が弱い", "反射・分割片の可能性"];
  }
  // Three independent signs: unlike reference, dark interior, no brighter object.
  // A dark score line alone cannot fail the sampled interior coverage.
  if (matching / n < 0.25 && center < refLight * 0.84 && center - surround < 12)
    return ["内部が錠剤群の色と異なる", "周囲から独立した錠剤領域がない"];
  // Bright existing tablets are not new foreground either. Use measured
  // single-body contours here, not padded AI boxes or display circles.
  if (matching >= n * 0.25 && ownedMatching / matching > 0.9)
    return [
      "検出済み輪郭の画素を再利用する候補",
      "新しい1錠分の内部領域がない",
    ];
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
