import type { Detection, Raster } from "../types";
import { duplicateOf } from "./objectIdentity";
import { contextualPixelReference, pixelRejection } from "./pixelEvidence";

export const DUPLICATE = "検出済み輪郭の内部にある重複候補";
export const HARD_REJECTION = "追加抑制:背景または重複";
export function hardRejected(d: Detection) {
  return d.flags.some(
    (f) =>
      f === HARD_REJECTION ||
      /新しい1錠分の内部領域がない|内部が錠剤群の色と異なる|候補自身の外周が確認できない|錠剤群の色成分がない|重複候補|接触輪郭をAIの個体候補に置換/.test(
        f,
      ),
  );
}

/** Shared by foundation-AI additions and local learned additions. No filename,
 * expected count or global single-tray crop is used. Multiple trays are allowed. */
export function additionGuard(
  image: Raster | undefined,
  references: Detection[],
) {
  const clean = references.filter(
    (d) =>
      d.source === "cv" &&
      d.shape &&
      d.shape.solidity > 0.88 &&
      d.shape.circularity > 0.45,
  );
  const referenceFor = image
    ? contextualPixelReference(image, clean)
    : undefined;
  return (d: Detection, accepted: Detection[]): string[] => {
    if (duplicateOf(d, accepted)) return [HARD_REJECTION, DUPLICATE];
    if (!image || !referenceFor) return [];
    const reference = referenceFor(d);
    const reasons = pixelRejection(image, d, reference, accepted);
    if (reasons.length) return [HARD_REJECTION, ...reasons];
    if (!reference.ready) return [];
    // A candidate's core must belong to the locally measured tablet family.
    // Median samples tolerate printed letters and score lines; surrounding
    // bright neighbors cannot lend foreground to a dark gap or blue tray hole.
    const channels: number[][] = [[], [], []];
    for (let y = -3; y <= 3; y++)
      for (let x = -3; x <= 3; x++) {
        if (x * x + y * y > 9) continue;
        const px = Math.round(
          d.center.x + (x * Math.min(d.box.width, d.box.height)) / 20,
        );
        const py = Math.round(
          d.center.y + (y * Math.min(d.box.width, d.box.height)) / 20,
        );
        if (px < 0 || py < 0 || px >= image.width || py >= image.height)
          continue;
        const i = (py * image.width + px) * 4;
        for (let c = 0; c < 3; c++) channels[c].push(image.data[i + c]);
      }
    if (channels[0].length < 15) return [HARD_REJECTION, "画像外の追加候補"];
    const rgb = channels.map(
      (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)],
    );
    const ref = reference.rgb;
    const blueBackground =
      ref[2] - ref[0] < 8 &&
      ref[2] - ref[1] < 8 &&
      rgb[2] - rgb[0] > 18 &&
      rgb[2] - rgb[1] > 9;
    const darkCore =
      Math.hypot(...rgb.map((v, i) => v - ref[i])) > reference.tolerance &&
      rgb.reduce((a, b) => a + b, 0) < ref.reduce((a, b) => a + b, 0) * 0.84;
    return blueBackground || darkCore
      ? [HARD_REJECTION, "候補中心に錠剤の内部領域がない"]
      : [];
  };
}
