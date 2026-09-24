import type { Raster } from "./types";
export async function loadImage(file: Blob): Promise<{
  canvas: HTMLCanvasElement;
  image: Raster;
  originalWidth: number;
  originalHeight: number;
}> {
  if (file.size > 45 * 1024 * 1024)
    throw new Error("画像が大きすぎます。45MB以下の画像を選んでください");
  // Modern Safari and other browsers apply EXIF orientation during HTMLImageElement decoding.
  const url = URL.createObjectURL(file),
    img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight)
      throw new Error("画像サイズが不正です");
    const scale = Math.min(
      1,
      1280 / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    if (Math.min(canvas.width, canvas.height) < 16)
      throw new Error("画像が小さすぎます");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      canvas,
      image: { width: data.width, height: data.height, data: data.data },
      originalWidth: img.naturalWidth,
      originalHeight: img.naturalHeight,
    };
  } catch (e) {
    throw new Error(
      `画像を読み込めません。HEICが開けない場合はJPEG/PNGに変換してください。${e instanceof Error ? e.message : ""}`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
