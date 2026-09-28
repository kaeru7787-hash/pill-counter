import type { Detection } from "../types";

// Display geometry only. Preserve measured contours for inference.
export function aiMarkerRadius(d: Detection, detections: Detection[]): number {
  const fallback = Math.sqrt(d.box.width * d.box.height) / 2;
  const nearby = detections
    .filter(
      (c) =>
        c.source === "cv" &&
        c.area > 0 &&
        (!c.shape || c.shape.solidity > 0.85),
    )
    .map((c) => ({
      radius: Math.sqrt(c.area / Math.PI),
      distance: Math.hypot(c.center.x - d.center.x, c.center.y - d.center.y),
    }))
    .filter(
      (c) =>
        c.radius >= fallback * 0.5 &&
        c.radius <= fallback * 2 &&
        c.distance <= fallback * 16,
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map((c) => c.radius)
    .sort((a, b) => a - b);
  return Math.max(
    2,
    nearby.length ? nearby[Math.floor(nearby.length / 2)] : fallback,
  );
}
