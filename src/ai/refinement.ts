import type { Detection, Raster, ROI } from "../types";
import type { AICandidate } from "./onnxDetector";
import { appearance, associated } from "./candidateReview";

/** Select bounded, overlapping local views from disagreement/texture, never a count target. */
export function reviewRegions(
  image: Raster,
  roi: ROI,
  ai: AICandidate[],
  cv: Detection[],
): ROI[] {
  if (ai.length < 5) return [];
  const lengths = ai
    .map((d) => Math.max(d.box.width, d.box.height))
    .sort((a, b) => a - b);
  const side = Math.max(
    160,
    Math.round(lengths[Math.floor(lengths.length / 2)] * 4),
  );
  const candidates = ai
    .map((a) => {
      const near = cv.filter((c) => associated(c, a));
      const texture = appearance(image, a).texture;
      const uncertainty =
        (near.length > 1 ? 4 : 0) +
        (near.length === 0 ? 1 : 0) +
        texture / 15 +
        (1 - a.score);
      return { a, uncertainty, texture };
    })
    .filter((v) => v.uncertainty > 1.6)
    .sort((a, b) => b.uncertainty - a.uncertainty);
  const regions: ROI[] = [];
  for (const { a } of candidates) {
    const width = Math.min(roi.width, side),
      height = Math.min(roi.height, side);
    const r = {
      x: Math.max(
        roi.x,
        Math.min(roi.x + roi.width - width, Math.round(a.center.x - width / 2)),
      ),
      y: Math.max(
        roi.y,
        Math.min(
          roi.y + roi.height - height,
          Math.round(a.center.y - height / 2),
        ),
      ),
      width,
      height,
    };
    // Keep the budget useful: don't repeatedly examine almost the same region.
    if (
      regions.some(
        (b) =>
          Math.hypot(
            r.x + r.width / 2 - (b.x + b.width / 2),
            r.y + r.height / 2 - (b.y + b.height / 2),
          ) <
          side * 0.65,
      )
    )
      continue;
    regions.push(r);
    if (regions.length === 3) break;
  }
  return regions;
}
