import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
const require = createRequire(import.meta.url),
  ortDir = dirname(require.resolve("onnxruntime-web/wasm"));
mkdirSync("public/vendor/ort", { recursive: true });
for (const file of readdirSync(ortDir))
  if (
    file === "ort-wasm-simd-threaded.wasm" ||
    file === "ort-wasm-simd-threaded.mjs"
  )
    cpSync(join(ortDir, file), join("public/vendor/ort", file));
for (const size of [192, 512]) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4,
        nx = (x - size / 2) / size,
        ny = (y - size / 2) / size,
        u = (nx - ny) * 0.707,
        v = (nx + ny) * 0.707;
      const capsule = Math.hypot(Math.max(0, Math.abs(u) - 0.13), v) < 0.12;
      png.data[p] = capsule ? 240 : 18;
      png.data[p + 1] = capsule ? 250 : 61;
      png.data[p + 2] = capsule ? 250 : 76;
      png.data[p + 3] = 255;
      if (capsule && Math.abs(u) < 0.014) {
        png.data[p] = 40;
        png.data[p + 1] = 179;
        png.data[p + 2] = 157;
      }
    }
  writeFileSync(`public/icon-${size}.png`, PNG.sync.write(png));
}
