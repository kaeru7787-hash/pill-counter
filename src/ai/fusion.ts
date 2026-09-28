// Trial hybrid fusion. No ground truth enters this function.
import type { Detection, Raster } from "../types";
import {
  referenceProfile,
  anomalyReasons,
  associated,
} from "./candidateReview";
import type { AICandidate } from "./onnxDetector";
import { iou } from "./onnxDetector";
import {
  contextualPixelReference,
  pixelReference,
  pixelRejection,
} from "./pixelEvidence";
import { overlappingObject, contains } from "./objectIdentity";
import { additionGuard } from "./additionGuard";
export { contains } from "./objectIdentity";
export function sameObject(a: Detection, b: Detection) {
  return (
    overlappingObject(a, b) ||
    (iou(a.box, b.box) > 0.3 &&
      Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <
        0.4 * Math.sqrt(Math.min(a.area, b.area)))
  );
}
export function fuse(
  cv: Detection[],
  full: AICandidate[],
  tiles: AICandidate[],
  image?: Raster,
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
  const profile = referenceProfile(cv, stable, image);
  const rejected: Detection[] = [];
  const references = cv.filter(
    (c) =>
      c.shape &&
      c.shape.solidity > 0.9 &&
      c.shape.circularity > 0.65 &&
      c.area > profile.area * 0.65 &&
      c.area < profile.area * 1.5 &&
      stable.some((a) => associated(c, a)),
  );
  const pixels = image
    ? contextualPixelReference(image, references)
    : undefined;
  const opticalPixels = image ? pixelReference(image, references) : undefined;
  const veto = (d: Detection, neighbors: Detection[] = []) => {
    const reasons =
      image && pixels && opticalPixels
        ? pixelRejection(
            image,
            d,
            d.source === "ai" ? pixels(d) : opticalPixels,
            neighbors,
          )
        : [];
    if (reasons.length)
      rejected.push({ ...d, flags: [...d.flags, ...reasons] });
    return reasons.length > 0;
  };
  const cleanShapes = cv.filter(
    (c) => c.shape && c.shape.solidity > 0.93 && c.shape.circularity > 0.45,
  );
  const elongatedFamily =
    cleanShapes.length >= 8 &&
    cleanShapes.filter((c) => c.shape!.aspect > 1.55).length /
      cleanShapes.length >
      0.8;
  const accepted = cv.filter((c) => {
    // A nearly square CV region in a strongly oblong family often spans parts
    // of two touching pills. Let independently supported AI instances replace
    // that merged region instead of letting it claim both foregrounds.
    if (
      elongatedFamily &&
      c.shape &&
      c.shape.aspect < 1.5 &&
      stable.some((a) => contains(c, a.center))
    ) {
      rejected.push({
        ...c,
        flags: [...c.flags, "接触輪郭をAIの個体候補に置換"],
      });
      return false;
    }
    if (veto(c, references)) return false;
    if (stable.some((a) => associated(c, a))) return true;
    const reasons = anomalyReasons(c, profile, image);
    const tiny =
      profile.ready && profile.uniform && c.area < profile.area * 0.18;
    if (reasons.length >= 2 || tiny) {
      rejected.push({
        ...c,
        flags: [
          ...c.flags,
          ...reasons,
          ...(tiny ? ["錠剤群に比べ極端に小さい"] : []),
          "AIの位置支持なし",
        ],
      });
      return false;
    }
    return true;
  });
  const areas = accepted.map((d) => d.area).sort((a, b) => a - b),
    median = areas[Math.floor(areas.length / 2)] || 0;
  // Associate fragments with the independently supported object's box scale.
  // A fragment's foreground area shrinks under glare and cannot define the
  // association radius. Each CV object belongs to at most one AI object.
  const groups = stable.map((): Detection[] => []);
  for (const c of accepted) {
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
  const detections = [...accepted];
  const guard = additionGuard(image, accepted);
  for (const [index, a] of stable.entries()) {
    const group = groups[index];
    if (veto(a, accepted)) continue;
    // Merge only a small split fragment and its partial parent, not two full
    // sized touching pills. Ambiguous groups remain available for review.
    if (
      group.length >= 2 &&
      ((group.length === 2 &&
        group.some((c) => c.area < median * 0.4) &&
        group.some((c) => c.area >= median * 0.4) &&
        group.reduce((s, c) => s + c.area, 0) < median * 1.2) ||
        (profile.uniform &&
          group.every((c) => c.area < profile.area * 0.55) &&
          group.reduce((s, c) => s + c.area, 0) < a.area * 0.9))
    ) {
      // A replacement is an addition too. Exclude only the fragments being
      // replaced; other accepted objects must still veto duplicates/background.
      const reasons = guard(
        a,
        detections.filter((d) => !group.includes(d)),
      );
      if (reasons.length) {
        rejected.push({ ...a, flags: [...a.flags, ...reasons] });
        continue;
      }
      const sorted = [...group].sort((b, c) => c.area - b.area);
      removed.push(...sorted.slice(1));
      replaced.push(sorted[0]);
      for (const c of group) detections.splice(detections.indexOf(c), 1);
      detections.push({
        ...a,
        flags: [...a.flags, "AI merged CV fragments: manual review required"],
      });
    } else if (!group.length) {
      const reasons = guard(a, detections);
      if (reasons.length) {
        rejected.push({ ...a, flags: [...a.flags, ...reasons] });
        continue;
      }
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
    rejected,
    profile,
    requiresReview:
      added.length > 0 || removed.length > 0 || rejected.length > 0,
  };
}
