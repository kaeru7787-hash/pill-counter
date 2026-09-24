import type { CV } from "./opencv";
import { median } from "./preprocess";
export function segment(cv: CV, rgb: InstanceType<CV["Mat"]>, variant = 1) {
  const lab = new cv.Mat(),
    gray = new cv.Mat(),
    local = new cv.Mat(),
    difference = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC1),
    mask = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const labPixels = lab.data,
    diffPixels = difference.data;
  const samples: number[][] = [[], [], []];
  // Dominant border color avoids a few objects, labels or shadows biasing background estimation.
  const bins = new Map<string, number[]>();
  for (let y = 0; y < rgb.rows; y += 3)
    for (let x = 0; x < rgb.cols; x += 3) {
      if (
        x > rgb.cols * 0.08 &&
        x < rgb.cols * 0.92 &&
        y > rgb.rows * 0.08 &&
        y < rgb.rows * 0.92
      )
        continue;
      const p = y * rgb.cols + x,
        k = [0, 1, 2]
          .map((c) => Math.floor(labPixels[p * 3 + c] / 24))
          .join(":");
      const b = bins.get(k) || [];
      b.push(p);
      bins.set(k, b);
    }
  const dominant =
    [...bins.values()].sort((a, b) => b.length - a.length)[0] || [];
  for (const p of dominant)
    for (let c = 0; c < 3; c++) samples[c].push(labPixels[p * 3 + c]);
  const bg = samples.map(median);
  for (let p = 0; p < diffPixels.length; p++) {
    const l = labPixels[p * 3] - bg[0],
      a = labPixels[p * 3 + 1] - bg[1],
      b = labPixels[p * 3 + 2] - bg[2];
    diffPixels[p] = Math.min(255, Math.sqrt(l * l + 0.9 * (a * a + b * b)));
  }
  const otsu = cv.threshold(
    difference,
    mask,
    0,
    255,
    cv.THRESH_BINARY | cv.THRESH_OTSU,
  );
  cv.threshold(
    difference,
    mask,
    Math.max(8, otsu * variant),
    255,
    cv.THRESH_BINARY,
  );
  let block = Math.max(3, Math.round(Math.min(rgb.rows, rgb.cols) * 0.055) | 1);
  cv.adaptiveThreshold(
    gray,
    local,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY,
    block,
    3,
  );
  // Very weak color evidence needs independent local contrast support.
  const maskPixels = mask.data,
    localPixels = local.data;
  for (let p = 0; p < maskPixels.length; p++)
    if (maskPixels[p] && diffPixels[p] < otsu * 1.15 && !localPixels[p])
      maskPixels[p] = 0;
  const radius = Math.max(1, Math.round(Math.min(rgb.rows, rgb.cols) / 700));
  const kernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(radius * 2 + 1, radius * 2 + 1),
  );
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
  // Remove narrow film creases using the observed object thickness distribution.
  const dist = new cv.Mat(),
    labels = new cv.Mat();
  cv.distanceTransform(mask, dist, cv.DIST_L2, 5);
  const count = cv.connectedComponents(mask, labels, 8);
  const maxRadius = new Float32Array(count),
    dd = dist.data32F,
    ll = labels.data32S;
  for (let p = 0; p < dd.length; p++)
    if (ll[p]) maxRadius[ll[p]] = Math.max(maxRadius[ll[p]], dd[p]);
  const radii = Array.from(maxRadius)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  const typical = median(
    radii.slice(0, Math.max(1, Math.ceil(radii.length * 0.6))),
  );
  const adaptiveRadius = Math.round(typical * 0.2);
  if (
    adaptiveRadius > radius &&
    typical < Math.min(rgb.rows, rgb.cols) * 0.12
  ) {
    const thinKernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(adaptiveRadius * 2 + 1, adaptiveRadius * 2 + 1),
    );
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, thinKernel);
    thinKernel.delete();
  }
  dist.delete();
  labels.delete();
  kernel.delete();
  lab.delete();
  gray.delete();
  local.delete();
  return { mask, difference, otsu, background: bg };
}
