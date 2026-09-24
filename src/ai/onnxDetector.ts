import type { Detection, Raster, ROI } from "../types";
import { getCV } from "../vision/opencv";
type ModelConfig = {
  format: "yolov8-detect";
  inputSize: number;
  classes: number;
  scoreThreshold: number;
  iouThreshold: number;
};
const defaults: ModelConfig = {
  format: "yolov8-detect",
  inputSize: 640,
  classes: 1,
  scoreThreshold: 0.5,
  iouThreshold: 0.45,
};
export function iou(a: ROI, b: ROI) {
  const overlap =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (
    overlap / Math.max(1, a.width * a.height + b.width * b.height - overlap)
  );
}
export function decodeYolo(
  data: ArrayLike<number>,
  dims: readonly number[],
  config: ModelConfig,
  scale: number,
  padX: number,
  padY: number,
  roi: ROI,
): Detection[] {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 4 + config.classes)
    throw new Error("ONNX出力形状が未対応です。[1, 4+classes, N] が必要です");
  const n = dims[2],
    candidates: { score: number; d: Detection }[] = [];
  for (let i = 0; i < n; i++) {
    let score = 0,
      cls = 0;
    for (let c = 0; c < config.classes; c++)
      if (data[(4 + c) * n + i] > score) {
        score = data[(4 + c) * n + i];
        cls = c;
      }
    if (score < config.scoreThreshold) continue;
    const cx = (data[i] - padX) / scale + roi.x,
      cy = (data[n + i] - padY) / scale + roi.y,
      w = data[2 * n + i] / scale,
      h = data[3 * n + i] / scale;
    if (
      ![cx, cy, w, h, score].every(Number.isFinite) ||
      w <= 0 ||
      h <= 0 ||
      cx < roi.x ||
      cy < roi.y ||
      cx > roi.x + roi.width ||
      cy > roi.y + roi.height
    )
      continue;
    const box = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
    candidates.push({
      score,
      d: {
        id: `ai-${i}`,
        center: { x: cx, y: cy },
        box,
        area: w * h,
        source: "ai",
        group: `class-${cls}`,
        flags: [],
        contour: [
          { x: box.x, y: box.y },
          { x: box.x + w, y: box.y },
          { x: box.x + w, y: box.y + h },
          { x: box.x, y: box.y + h },
        ],
      },
    });
  }
  const kept: typeof candidates = [];
  for (const c of candidates.sort((a, b) => b.score - a.score))
    if (!kept.some((k) => iou(k.d.box, c.d.box) > config.iouThreshold))
      kept.push(c);
  return kept.map((c) => c.d);
}
export async function detectAI(
  image: Raster,
  roi: ROI,
  baseURL: string,
): Promise<{ detections?: Detection[]; status: string; failed?: boolean }> {
  try {
    const modelURL = new URL("models/pill-counter.onnx", baseURL);
    const response = await fetch(modelURL, {
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404)
      return { status: "AIモデル未導入（画像処理のみ）" };
    if (!response.ok) throw new Error(`モデル取得 HTTP ${response.status}`);
    const model = new Uint8Array(await response.arrayBuffer());
    if (
      new TextDecoder().decode(model.slice(0, 100)).trimStart().startsWith("<")
    )
      return { status: "AIモデル未導入（画像処理のみ）" };
    let config = { ...defaults };
    const cfg = await fetch(new URL("models/config.json", baseURL), {
      signal: AbortSignal.timeout(5000),
    });
    if (cfg.ok && cfg.headers.get("content-type")?.includes("json"))
      config = { ...config, ...(await cfg.json()) };
    if (
      config.format !== "yolov8-detect" ||
      ![320, 416, 512, 640, 960, 1280].includes(config.inputSize) ||
      !Number.isInteger(config.classes) ||
      config.classes < 1 ||
      config.classes > 100 ||
      config.scoreThreshold <= 0 ||
      config.scoreThreshold >= 1 ||
      config.iouThreshold <= 0 ||
      config.iouThreshold >= 1
    )
      throw new Error("モデル設定が不正または未対応です");
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", baseURL).href;
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
    });
    try {
      const { cv } = await getCV(),
        src = cv.matFromImageData(image as ImageData),
        part = src.roi(new cv.Rect(roi.x, roi.y, roi.width, roi.height)),
        resized = new cv.Mat();
      const size = config.inputSize,
        scale = Math.min(size / roi.width, size / roi.height),
        w = Math.round(roi.width * scale),
        h = Math.round(roi.height * scale),
        px = Math.floor((size - w) / 2),
        py = Math.floor((size - h) / 2);
      cv.resize(part, resized, new cv.Size(w, h));
      const tensor = new Float32Array(3 * size * size).fill(114 / 255);
      const resizedPixels = resized.data;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 3; c++)
            tensor[c * size * size + (y + py) * size + x + px] =
              resizedPixels[(y * w + x) * 4 + c] / 255;
      src.delete();
      part.delete();
      resized.delete();
      const input = new ort.Tensor("float32", tensor, [1, 3, size, size]);
      try {
        const output = await session.run({ [session.inputNames[0]]: input });
        try {
          const t = output[session.outputNames[0]];
          return {
            detections: decodeYolo(
              t.data as Float32Array,
              t.dims,
              config,
              scale,
              px,
              py,
              roi,
            ),
            status: "ONNXモデルで照合済み",
          };
        } finally {
          Object.values(output).forEach((t) => t.dispose());
        }
      } finally {
        input.dispose();
      }
    } finally {
      await session.release();
    }
  } catch (error) {
    return {
      status: `AI照合失敗: ${error instanceof Error ? error.message : String(error)}`,
      failed: true,
    };
  }
}
