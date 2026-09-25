// Run node scripts/run.mjs tests/core.test.ts --test first to compile shared decoder.
import { createHash } from "node:crypto";
import * as ort from "onnxruntime-web/wasm";
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeYolo } from "../.runtime/src/ai/onnxDetector.js";
import { positionMetrics } from "../.runtime/src/vision/positionMetrics.js";
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(
  readFileSync(process.argv[2] || ".runtime/models/pill-yolo11n.onnx"),
  { executionProviders: ["wasm"] },
);
const rows = [];
try {
  for (const file of [
    "18-real-tray.jpg",
    "19-bag-round.jpg",
    "20-bag-oblong.jpg",
    "21-yellow-tray-round.png",
    "22-yellow-tray-oblong.png",
  ]) {
    const meta = await sharp("tests/images/" + file).metadata();
    const scale = Math.min(640 / meta.width, 640 / meta.height),
      w = Math.round(meta.width * scale),
      h = Math.round(meta.height * scale),
      px = Math.floor((640 - w) / 2),
      py = Math.floor((640 - h) / 2);
    const { data } = await sharp("tests/images/" + file)
      .resize(w, h)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = new Float32Array(3 * 640 * 640).fill(114 / 255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++)
          tensor[c * 640 * 640 + (y + py) * 640 + x + px] =
            data[(y * w + x) * 3 + c] / 255;
    const input = new ort.Tensor("float32", tensor, [1, 3, 640, 640]),
      start = performance.now();
    const out = await session.run({ images: input });
    const t = out.output0,
      raw = Float32Array.from(t.data);
    const annotation = JSON.parse(
      readFileSync("tests/annotations/" + file.replace(/\.[^.]+$/, ".json")),
    );
    const truth = annotation.centers.map(([x, y]) => ({
      x: (x * meta.width) / annotation.width,
      y: (y * meta.height) / annotation.height,
    }));
    for (const cutoff of [0.25, 0.5]) {
      const ds = decodeYolo(
        raw,
        t.dims,
        {
          format: "yolov8-detect",
          inputSize: 640,
          classes: 4,
          allowedClasses: [0, 1, 3],
          scoreThreshold: cutoff,
          iouThreshold: 0.45,
        },
        scale,
        px,
        py,
        { x: 0, y: 0, width: meta.width, height: meta.height },
      );
      const p = positionMetrics(
        ds.map((d) => d.center),
        truth,
        (annotation.tolerance * meta.width) / annotation.width,
      );
      const r = {
        file,
        threshold: cutoff,
        detected: ds.length,
        reference: truth.length,
        tp: p.tp,
        fp: p.fp,
        fn: p.fn,
        ms: Math.round(performance.now() - start),
      };
      rows.push(r);
      console.log(r);
    }
    input.dispose();
    Object.values(out).forEach((t) => t.dispose());
  }
} finally {
  await session.release();
}
writeFileSync(
  "tests/reports/ai-candidate.json",
  JSON.stringify(
    {
      model: "piky/yolo11/yolo11n.onnx",
      source: "https://huggingface.co/piky/yolo11",
      modelSha256: createHash("sha256")
        .update(
          readFileSync(process.argv[2] || ".runtime/models/pill-yolo11n.onnx"),
        )
        .digest("hex"),
      deployed: false,
      notes:
        "Development references only; tray oblong reference 36 is provisional. New lighting photographs unavailable. Model card MIT conflicts with embedded AGPL-3.0 metadata; weights not redistributed.",
      classes: [
        "capsule",
        "damaged-pill",
        "foreign-matter (excluded)",
        "tablet",
      ],
      rows,
    },
    null,
    2,
  ) + "\n",
);
