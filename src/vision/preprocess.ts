import type { CV } from "./opencv";
import type { Raster, ROI } from "../types";
export const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
export function preprocess(cv: CV, image: Raster) {
  const src = cv.matFromImageData(image as ImageData),
    rgb = new cv.Mat(),
    smooth = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();
  const pixels = rgb.data;
  // Conservative neutral-border white balance. Colored backgrounds are not forced to gray.
  const channels: number[][] = [[], [], []];
  for (let y = 0; y < image.height; y += 7)
    for (let x = 0; x < image.width; x += 7) {
      if (
        x > image.width * 0.06 &&
        x < image.width * 0.94 &&
        y > image.height * 0.06 &&
        y < image.height * 0.94
      )
        continue;
      const p = (y * image.width + x) * 3;
      for (let c = 0; c < 3; c++) channels[c].push(pixels[p + c]);
    }
  const med = channels.map(median),
    avg = med.reduce((a, b) => a + b, 0) / 3;
  if (avg > 35 && Math.max(...med) - Math.min(...med) < 30) {
    const gains = med.map((v) => Math.max(0.9, Math.min(1.1, avg / (v || 1))));
    for (let i = 0; i < pixels.length; i++)
      pixels[i] = Math.min(255, pixels[i] * gains[i % 3]);
  }
  cv.GaussianBlur(rgb, smooth, new cv.Size(3, 3), 0);
  rgb.delete();
  return smooth;
}
export function automaticROI(
  cv: CV,
  rgb: InstanceType<CV["Mat"]>,
): ROI | undefined {
  const gray = new cv.Mat(),
    dark = new cv.Mat(),
    labels = new cv.Mat(),
    stats = new cv.Mat(),
    centroids = new cv.Mat();
  try {
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.threshold(gray, dark, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    const n = cv.connectedComponentsWithStats(
      dark,
      labels,
      stats,
      centroids,
      8,
    );
    let best: ROI | undefined,
      largest = 0;
    for (let i = 1; i < n; i++) {
      const s = stats.data32S.subarray(i * 5, i * 5 + 5),
        [x, y, w, h, area] = s;
      if (
        area > largest &&
        area > rgb.rows * rgb.cols * 0.3 &&
        w > rgb.cols * 0.5 &&
        h > rgb.rows * 0.5 &&
        area / (w * h) > 0.45
      ) {
        const inset = Math.max(2, Math.round(Math.min(w, h) * 0.018));
        best = {
          x: x + inset,
          y: y + inset,
          width: w - 2 * inset,
          height: h - 2 * inset,
        };
        largest = area;
      }
    }
    return best;
  } finally {
    gray.delete();
    dark.delete();
    labels.delete();
    stats.delete();
    centroids.delete();
  }
}
