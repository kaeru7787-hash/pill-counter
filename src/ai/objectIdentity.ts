import type { Detection, Point } from "../types";

export function contains(d: Detection, p: Point) {
  if (
    p.x < d.box.x ||
    p.y < d.box.y ||
    p.x > d.box.x + d.box.width ||
    p.y > d.box.y + d.box.height
  )
    return false;
  let inside = false;
  for (let i = 0, j = d.contour.length - 1; i < d.contour.length; j = i++) {
    const a = d.contour[i],
      b = d.contour[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** Compare both axes, not just the short side of an elongated tablet. */
export function overlappingObject(a: Detection, b: Detection) {
  const w = Math.min(a.box.width, b.box.width);
  const h = Math.min(a.box.height, b.box.height);
  if (w <= 0 || h <= 0) return false;
  const offset = Math.hypot(
    (a.center.x - b.center.x) / w,
    (a.center.y - b.center.y) / h,
  );
  const intersection =
    Math.max(
      0,
      Math.min(a.box.x + a.box.width, b.box.x + b.box.width) -
        Math.max(a.box.x, b.box.x),
    ) *
    Math.max(
      0,
      Math.min(a.box.y + a.box.height, b.box.y + b.box.height) -
        Math.max(a.box.y, b.box.y),
    );
  const union =
    a.box.width * a.box.height + b.box.width * b.box.height - intersection;
  return offset < 0.42 && intersection / Math.max(1, union) > 0.45;
}

/** Identify measured single bodies using the photograph's optical family,
 * independent of the proposed AI box size. Merged clusters must not own
 * every candidate inside their contour. Area and axis ratio both matter. */
export function singleObjectContours(detections: Detection[]) {
  const clean = detections.filter(
    (d) =>
      d.source === "cv" &&
      d.contour.length >= 3 &&
      d.shape &&
      d.shape.solidity > 0.9 &&
      d.shape.circularity > 0.45 &&
      d.area > 0,
  );
  if (clean.length < 8) return [];
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const area = median(clean.map((d) => d.area));
  const aspect = median(clean.map((d) => d.shape!.aspect));
  return clean.filter(
    (d) =>
      d.area >= area * 0.6 &&
      d.area <= area * 1.5 &&
      d.shape!.aspect >= aspect * 0.7 &&
      d.shape!.aspect <= aspect * 1.4,
  );
}

/** A photo-calibrated single body owns its interior even when a candidate
 * is a small, off-centre fragment. Keep the old conservative fallback for
 * sparse photographs without enough optical references. */
export function duplicateOf(candidate: Detection, accepted: Detection[]) {
  const singles = new Set(singleObjectContours(accepted));
  return accepted.find((d) => {
    if (d === candidate) return false;
    const area = candidate.box.width * candidate.box.height;
    const owns =
      d.source !== "ai" &&
      d.contour.length >= 3 &&
      (d.shape?.solidity ?? 0) > 0.75 &&
      (d.shape?.circularity ?? 0) > 0.4 &&
      d.area > area * 0.32 &&
      (d.area < area * 1.45 || singles.has(d)) &&
      contains(d, candidate.center);
    return owns || overlappingObject(candidate, d);
  });
}
