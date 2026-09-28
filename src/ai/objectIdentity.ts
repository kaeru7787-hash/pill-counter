import type { Detection, Point } from "../types";

export function contains(d: Detection, p: Point) {
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

/** A measured foreground contour takes precedence over a padded detector box.
 * Restrict ownership to compact, tablet-sized contours so a merged cluster
 * cannot swallow the separate AI objects inside it. */
export function duplicateOf(candidate: Detection, accepted: Detection[]) {
  return accepted.find((d) => {
    if (d === candidate) return false;
    const area = candidate.box.width * candidate.box.height;
    const owns =
      d.source !== "ai" &&
      d.contour.length >= 3 &&
      (d.shape?.solidity ?? 0) > 0.75 &&
      (d.shape?.circularity ?? 0) > 0.4 &&
      d.area > area * 0.32 &&
      d.area < area * 1.45 &&
      contains(d, candidate.center);
    return owns || overlappingObject(candidate, d);
  });
}
