import type { Detection, Raster, ROI } from "../types";
import { getCV } from "../vision/opencv";
import { reviewRegions } from "./refinement";
export type ModelConfig = {
  modelURL?: string;
  sha256?: string;
  format: "yolov8-detect";
  inputSize: number;
  classes: number;
  /** Winning classes that represent countable pills; other objects are excluded. */
  allowedClasses?: number[];
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
    if (
      score < config.scoreThreshold ||
      (config.allowedClasses && !config.allowedClasses.includes(cls))
    )
      continue;
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
        score,
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
export type AICandidate = Detection & { score: number; view: string };
export async function detectAI(
  image: Raster,
  roi: ROI,
  baseURL: string,
  cvCandidates: Detection[] = [],
): Promise<{
  detections?: AICandidate[];
  tiles?: AICandidate[];
  status: string;
  failed?: boolean;
}> {
  try {
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
      (config.allowedClasses !== undefined &&
        (!Array.isArray(config.allowedClasses) ||
          !config.allowedClasses.length ||
          config.allowedClasses.some(
            (c) => !Number.isInteger(c) || c < 0 || c >= config.classes,
          ))) ||
      !Number.isFinite(config.scoreThreshold) ||
      !Number.isFinite(config.iouThreshold) ||
      config.scoreThreshold <= 0 ||
      config.scoreThreshold >= 1 ||
      config.iouThreshold <= 0 ||
      config.iouThreshold >= 1
    )
      throw new Error("モデル設定が不正または未対応です");
    const modelURL = new URL(
      config.modelURL || "models/pill-counter.onnx",
      baseURL,
    );
    if (
      modelURL.origin !== new URL(baseURL).origin &&
      (modelURL.protocol !== "https:" ||
        !config.sha256?.match(/^[a-f0-9]{64}$/))
    )
      throw new Error("外部モデルにはHTTPSとSHA-256の指定が必要です");
    // Cache verified model bytes separately from the application shell. Photos
    // are never sent in a request; only this fixed public model URL is fetched.
    let cache: Cache | undefined;
    try {
      cache = await caches.open("pill-counter-ai-model-v1");
    } catch {
      /* Private browsing may disable persistent storage. */
    }
    let response = await cache?.match(modelURL.href);
    if (!response)
      response = await fetch(modelURL, {
        signal: AbortSignal.timeout(60000),
        credentials: "omit",
      });
    if (response.status === 404)
      return { status: "AIモデル未導入（画像処理のみ）" };
    if (!response.ok) throw new Error(`モデル取得 HTTP ${response.status}`);
    const model = new Uint8Array(await response.arrayBuffer());
    if (
      new TextDecoder().decode(model.slice(0, 100)).trimStart().startsWith("<")
    )
      return { status: "AIモデル未導入（画像処理のみ）" };
    if (config.sha256) {
      const actual = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", model)),
      )
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== config.sha256) {
        await cache?.delete(modelURL.href);
        throw new Error("AIモデルの検証に失敗しました。再解析してください");
      }
      try {
        await cache?.put(
          modelURL.href,
          new Response(model, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        );
      } catch {
        /* Inference can continue without persistence. */
      }
    }
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", baseURL).href;
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
    });
    try {
      return await inferViews(image, roi, config, session, ort, cvCandidates);
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

/** Shared by browser inference and the reproducible offline evaluation. */
export async function inferViews(
  image: Raster,
  roi: ROI,
  config: ModelConfig,
  session: import("onnxruntime-web").InferenceSession,
  ort: typeof import("onnxruntime-web"),
  cvCandidates: Detection[] = [],
  refine = true,
) {
  const infer = async (
    roi: ROI,
    view: string,
    normalize = false,
  ): Promise<AICandidate[]> => {
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
    let low = 0,
      gain = 1;
    if (normalize) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < resizedPixels.length; i += 4)
        hist[
          Math.round(
            (resizedPixels[i] + resizedPixels[i + 1] + resizedPixels[i + 2]) /
              3,
          )
        ]++;
      let sum = 0,
        high = 255;
      for (let i = 0; i < 256; i++) {
        sum += hist[i];
        if (sum < w * h * 0.1) low = i;
        if (sum < w * h * 0.95) high = i;
      }
      gain = Math.min(1.6, 220 / Math.max(60, high - low));
      low = Math.max(0, low - 15);
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++)
          tensor[c * size * size + (y + py) * size + x + px] =
            Math.max(
              0,
              Math.min(255, (resizedPixels[(y * w + x) * 4 + c] - low) * gain),
            ) / 255;
    src.delete();
    part.delete();
    resized.delete();
    const input = new ort.Tensor("float32", tensor, [1, 3, size, size]);
    try {
      const output = await session.run({ [session.inputNames[0]]: input });
      try {
        const t = output[session.outputNames[0]];
        return decodeYolo(
          t.data as Float32Array,
          t.dims,
          config,
          scale,
          px,
          py,
          roi,
        ).map((d) => ({ ...d, score: d.score || 0, view }));
      } finally {
        Object.values(output).forEach((t) => t.dispose());
      }
    } finally {
      input.dispose();
    }
  };
  const detections = await infer(roi, "full");
  const tiles: AICandidate[] = [];
  const tw = Math.round(roi.width * 0.65),
    th = Math.round(roi.height * 0.65);
  // Sequential inference bounds peak memory on iPhone Safari.
  for (const [x, y] of [
    [roi.x, roi.y],
    [roi.x + roi.width - tw, roi.y],
    [roi.x, roi.y + roi.height - th],
    [roi.x + roi.width - tw, roi.y + roi.height - th],
  ]) {
    const ds = await infer({ x, y, width: tw, height: th }, `tile-${x}-${y}`);
    tiles.push(
      ...ds.filter(
        (d) =>
          (x === roi.x || d.box.x > x + 2) &&
          (y === roi.y || d.box.y > y + 2) &&
          (x + tw === roi.x + roi.width ||
            d.box.x + d.box.width < x + tw - 2) &&
          (y + th === roi.y + roi.height ||
            d.box.y + d.box.height < y + th - 2),
      ),
    );
  }
  const regions = refine
    ? reviewRegions(image, roi, [...detections, ...tiles], cvCandidates)
    : [];
  for (const [i, r] of regions.entries()) {
    for (const normalized of [false, true]) {
      const ds = await infer(
        r,
        "review-" + i + (normalized ? "-contrast" : "-original"),
        normalized,
      );
      tiles.push(
        ...ds.filter(
          (d) =>
            (r.x === roi.x || d.box.x > r.x + 2) &&
            (r.y === roi.y || d.box.y > r.y + 2) &&
            (r.x + r.width === roi.x + roi.width ||
              d.box.x + d.box.width < r.x + r.width - 2) &&
            (r.y + r.height === roi.y + roi.height ||
              d.box.y + d.box.height < r.y + r.height - 2),
        ),
      );
    }
  }
  return {
    regions,
    detections,
    tiles,
    status: `ONNXモデルで照合済み（全体＋4区画） / 局所再解析 ${regions.length}領域`,
  };
}
