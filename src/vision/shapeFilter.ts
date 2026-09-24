import type { CV } from "./opencv";
import type { Detection } from "../types";
export function contours(
  cv: CV,
  mask: InstanceType<CV["Mat"]>,
  prefix: string,
  offset = { x: 0, y: 0 },
) {
  const cs = new cv.MatVector(),
    h = new cv.Mat(),
    list: Detection[] = [];
  cv.findContours(mask, cs, h, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < cs.size(); i++) {
    if (h.data32S[i * 4 + 3] >= 0) continue;
    const c = cs.get(i),
      hull = new cv.Mat();
    try {
      let area = cv.contourArea(c);
      for (
        let child = h.data32S[i * 4 + 2];
        child >= 0;
        child = h.data32S[child * 4]
      ) {
        const hole = cs.get(child);
        area -= cv.contourArea(hole);
        hole.delete();
      }
      if (area <= 0) continue;
      cv.convexHull(c, hull);
      const solidity = area / Math.max(1, cv.contourArea(hull));
      const perimeter = cv.arcLength(c, true),
        roundness = (4 * Math.PI * area) / (perimeter * perimeter),
        box = cv.boundingRect(c),
        m = cv.moments(c);
      const rr = cv.minAreaRect(c),
        aspect =
          Math.max(rr.size.width, rr.size.height) /
          Math.max(1, Math.min(rr.size.width, rr.size.height));
      const flags: string[] = [];
      if (solidity < 0.92) flags.push("不規則な輪郭・接触の可能性");
      if (aspect > 4.5 || roundness < 0.17)
        flags.push("細長い反射・袋の縁の可能性");
      if (
        box.x <= 1 ||
        box.y <= 1 ||
        box.x + box.width >= mask.cols - 1 ||
        box.y + box.height >= mask.rows - 1
      )
        flags.push("解析範囲の端に接触");
      if (
        box.width * box.height > mask.cols * mask.rows * 0.65 &&
        solidity < 0.35
      )
        flags.push("背景の囲み枠");
      const points = [];
      for (let j = 0; j < c.data32S.length; j += 2)
        points.push({
          x: c.data32S[j] + offset.x,
          y: c.data32S[j + 1] + offset.y,
        });
      list.push({
        id: `${prefix}-${i}`,
        center: { x: m.m10 / m.m00 + offset.x, y: m.m01 / m.m00 + offset.y },
        area,
        box: {
          x: box.x + offset.x,
          y: box.y + offset.y,
          width: box.width,
          height: box.height,
        },
        contour: points,
        source: "cv",
        flags,
      });
    } finally {
      c.delete();
      hull.delete();
    }
  }
  cs.delete();
  h.delete();
  return list;
}
export function relativeFilter(list: Detection[]) {
  const plausible = list.filter(
    (d) => !d.flags.some((f) => f.startsWith("細長い") || f === "背景の囲み枠"),
  );
  const areas = plausible.map((d) => d.area).sort((a, b) => b - a);
  // The area-weighted reference cannot be overwhelmed by hundreds of tiny print specks.
  const total = areas.reduce((a, b) => a + b, 0);
  let sum = 0,
    reference = areas[0] || 1;
  for (const area of areas) {
    sum += area;
    if (sum >= total * 0.5) {
      reference = area;
      break;
    }
  }
  const kept = plausible.filter((d) => d.area >= reference * 0.075);
  return { kept, rejected: list.length - kept.length, reference };
}
