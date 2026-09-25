// Trial hybrid fusion. No ground truth enters this function.
import type { Detection } from "../types";
import type { AICandidate } from "./onnxDetector";
import { iou } from "./onnxDetector";
export function sameObject(a: Detection, b: Detection) {
  return (
    iou(a.box, b.box) > 0.3 &&
    Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <
      0.4 * Math.sqrt(Math.min(a.area, b.area))
  );
}
export function fuse(
  cv: Detection[],
  full: AICandidate[],
  tiles: AICandidate[],
) {
  const ai = [...full, ...tiles],
    stable: AICandidate[] = [];
  for (const a of ai
    .filter(
      (a) =>
        a.score >= 0.5 && ai.some((b) => a.view !== b.view && sameObject(a, b)),
    )
    .sort((a, b) => b.score - a.score))
    if (!stable.some((b) => sameObject(a, b))) stable.push(a);
  const areas = cv.map((d) => d.area).sort((a, b) => a - b),
    median = areas[Math.floor(areas.length / 2)] || 0;
  // Associate fragments with the independently supported object's box scale.
  // A fragment's foreground area shrinks under glare and cannot define the
  // association radius. Each CV object belongs to at most one AI object.
  const groups = stable.map((): Detection[] => []);
  for (const c of cv) {
    const choices = stable
      .map((a, index) => ({
        index,
        distance:
          Math.hypot(a.center.x - c.center.x, a.center.y - c.center.y) /
          Math.min(a.box.width, a.box.height),
        overlap: iou(a.box, c.box),
      }))
      .filter((m) => m.distance < 0.5 && m.overlap > 0.05)
      .sort((a, b) => a.distance - b.distance);
    if (choices.length) groups[choices[0].index].push(c);
  }
  const removed: Detection[] = [],
    replaced: Detection[] = [],
    added: AICandidate[] = [];
  const detections = [...cv];
  for (const [index, a] of stable.entries()) {
    const group = groups[index];
    // Merge only a small split fragment and its partial parent, not two full
    // sized touching pills. Ambiguous groups remain available for review.
    if (
      group.length === 2 &&
      group.some((c) => c.area < median * 0.4) &&
      group.some((c) => c.area >= median * 0.4) &&
      group.reduce((s, c) => s + c.area, 0) < median * 1.2
    ) {
      const sorted = [...group].sort((b, c) => c.area - b.area);
      removed.push(sorted[1]);
      replaced.push(sorted[0]);
      for (const c of group) detections.splice(detections.indexOf(c), 1);
      detections.push({
        ...a,
        flags: [...a.flags, "AI merged CV fragments: manual review required"],
      });
    } else if (!group.length) {
      detections.push({
        ...a,
        flags: [...a.flags, "AI rescue: manual review required"],
      });
      added.push(a);
    }
  }
  return {
    detections,
    stable,
    added,
    removed,
    replaced,
    requiresReview: added.length > 0 || removed.length > 0,
  };
}
