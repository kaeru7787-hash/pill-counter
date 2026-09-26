import type { Detection } from "../types";
import type { CV } from "./opencv";

/** Local recovery at unmatched seal candidates. A seal alone is not counted:
 * an elliptical rim must independently persist at two edge thresholds. */
export function recoverTiltedCaps(
  cv: CV,
  gray: any,
  hsv: any,
  marks: Detection[],
  radius: number,
  hue: number,
) {
  const views: { d: Detection; threshold: number; mark: string }[] = [];
  const w = gray.cols,
    h = gray.rows;
  const hueDistance = (a: number, b: number) =>
    Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (const mark of marks.slice(0, 16)) {
    const left = Math.max(0, Math.floor(mark.center.x - radius * 2)),
      top = Math.max(0, Math.floor(mark.center.y - radius * 2));
    const width = Math.min(w - left, Math.ceil(radius * 4)),
      height = Math.min(h - top, Math.ceil(radius * 4));
    const crop = gray.roi(new cv.Rect(left, top, width, height));
    try {
      for (const threshold of [20, 40, 60]) {
        const edge = new cv.Mat(),
          cs = new cv.MatVector(),
          hierarchy = new cv.Mat();
        try {
          cv.Canny(crop, edge, threshold, threshold * 2);
          cv.findContours(
            edge,
            cs,
            hierarchy,
            cv.RETR_LIST,
            cv.CHAIN_APPROX_NONE,
          );
          for (let i = 0; i < cs.size(); i++) {
            const c = cs.get(i);
            try {
              if (c.rows < 16) continue;
              const e = cv.fitEllipse(c),
                a = e.size.width / 2,
                b = e.size.height / 2;
              const major = Math.max(a, b),
                minor = Math.min(a, b),
                angle = (e.angle * Math.PI) / 180;
              if (
                major < radius * 0.75 ||
                major > radius * 1.18 ||
                minor < radius * 0.3 ||
                minor > major * 0.85
              )
                continue;
              const x = e.center.x + left,
                y = e.center.y + top;
              if (
                x - major * 1.25 < 0 ||
                y - major * 1.25 < 0 ||
                x + major * 1.25 >= w ||
                y + major * 1.25 >= h
              )
                continue;
              const dx = mark.center.x - x,
                dy = mark.center.y - y;
              if (
                ((dx * Math.cos(angle) + dy * Math.sin(angle)) / a) ** 2 +
                  ((-dx * Math.sin(angle) + dy * Math.cos(angle)) / b) ** 2 >
                1.15
              )
                continue;
              const point = (u: number, v: number) => ({
                x: x + u * a * Math.cos(angle) - v * b * Math.sin(angle),
                y: y + u * a * Math.sin(angle) + v * b * Math.cos(angle),
              });
              const value = (u: number, v: number) => {
                const p = point(u, v);
                return gray.data[Math.round(p.y) * w + Math.round(p.x)];
              };
              let matching = 0;
              for (let yy = -2; yy <= 2; yy++)
                for (let xx = -2; xx <= 2; xx++) {
                  const p = point(xx * 0.2, yy * 0.2),
                    k = (Math.round(p.y) * w + Math.round(p.x)) * 3;
                  if (
                    hsv.data[k + 1] > 65 &&
                    hsv.data[k + 2] > 70 &&
                    hueDistance((hsv.data[k] * Math.PI) / 90, hue) < 0.4
                  )
                    matching++;
                }
              if (matching < 19) continue;
              let sectors = 0,
                sum = 0;
              for (let k = 0; k < 32; k++) {
                const t = (k * Math.PI) / 16;
                let best = 0;
                for (const r of [0.9, 1, 1.1])
                  best = Math.max(
                    best,
                    Math.abs(
                      value(
                        Math.cos(t) * (r - 0.12),
                        Math.sin(t) * (r - 0.12),
                      ) -
                        value(
                          Math.cos(t) * (r + 0.12),
                          Math.sin(t) * (r + 0.12),
                        ),
                    ),
                  );
                if (best > 12) sectors++;
                sum += Math.min(60, best);
              }
              if (sectors < 24 || sum / 32 < 24) continue;
              const contour = Array.from({ length: 32 }, (_, k) =>
                point(
                  Math.cos((k * Math.PI) / 16),
                  Math.sin((k * Math.PI) / 16),
                ),
              );
              const xs = contour.map((p) => p.x),
                ys = contour.map((p) => p.y);
              views.push({
                threshold,
                mark: mark.id,
                d: {
                  id: `tilted-${views.length}`,
                  center: { x, y },
                  box: {
                    x: Math.min(...xs),
                    y: Math.min(...ys),
                    width: Math.max(...xs) - Math.min(...xs),
                    height: Math.max(...ys) - Math.min(...ys),
                  },
                  area: Math.PI * a * b,
                  contour,
                  source: "cv",
                  score: sectors / 32 + sum / 1920,
                  flags: ["傾斜キャップの楕円外周を局所再解析"],
                },
              });
            } finally {
              c.delete();
            }
          }
        } finally {
          edge.delete();
          cs.delete();
          hierarchy.delete();
        }
      }
    } finally {
      crop.delete();
    }
  }
  const result: Detection[] = [];
  for (const m of marks) {
    const candidates = views
      .filter((v) => v.mark === m.id)
      .sort((a, b) => (b.d.score || 0) - (a.d.score || 0));
    const chosen = candidates.find((a) =>
      candidates.some(
        (b) =>
          a.threshold !== b.threshold &&
          Math.hypot(a.d.center.x - b.d.center.x, a.d.center.y - b.d.center.y) <
            radius * 0.25,
      ),
    );
    if (
      chosen &&
      !result.some(
        (d) =>
          Math.hypot(
            d.center.x - chosen.d.center.x,
            d.center.y - chosen.d.center.y,
          ) < radius,
      )
    )
      result.push(chosen.d);
  }
  return result;
}
