import type { Detection, ReferenceEllipse } from "../types";

export function normalizedMarker(d: Detection, reference?: ReferenceEllipse) {
  return {
    major: Math.max(
      2,
      reference?.major ||
        d.measurement?.major ||
        Math.max(d.box.width, d.box.height),
    ),
    minor: Math.max(
      2,
      reference?.minor ||
        d.measurement?.minor ||
        Math.min(d.box.width, d.box.height),
    ),
    angle: d.markerAngle ?? d.measurement?.angle ?? 0,
    uncertain:
      d.source !== "manual" &&
      (!reference ||
        !d.ellipseAssessment ||
        d.ellipseAssessment.status !== "normal"),
  };
}
export function markerPath(
  ctx: CanvasRenderingContext2D,
  d: Detection,
  reference?: ReferenceEllipse,
) {
  const m = normalizedMarker(d, reference);
  ctx.beginPath();
  ctx.ellipse(
    d.center.x,
    d.center.y,
    m.major / 2,
    m.minor / 2,
    m.angle,
    0,
    Math.PI * 2,
  );
  return m;
}
/** Shared by the interactive canvas and PNG export. No measured contour is
 * used for final tablet markers. Selection keeps an uncertain marker dashed. */
export function drawNormalizedMarkers(
  ctx: CanvasRenderingContext2D,
  d: Detection,
  reference: ReferenceEllipse | undefined,
  selected: boolean,
  width: number,
) {
  const m = markerPath(ctx, d, reference),
    line = Math.max(1.5, width / 600);
  ctx.save();
  ctx.lineWidth = line;
  ctx.strokeStyle = selected
    ? "#ffcf60"
    : m.uncertain
      ? "#f6a623"
      : d.source === "ai"
        ? "#153eab"
        : d.source === "manual"
          ? "#67b8ff"
          : "#39e0bc";
  ctx.setLineDash(m.uncertain ? [line * 3, line * 2] : []);
  if (selected) {
    ctx.fillStyle = "#ffcf6033";
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}
export function drawEllipseDebug(
  ctx: CanvasRenderingContext2D,
  objects: Detection[],
  reference: ReferenceEllipse | undefined,
  width: number,
) {
  ctx.save();
  ctx.lineWidth = Math.max(1, width / 1000);
  for (const d of objects) {
    const m = d.measurement;
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ec6af5";
    ctx.beginPath();
    d.contour.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.stroke();
    markerPath(ctx, d, reference);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle =
      d.ellipseAssessment?.status === "excluded" ? "#ff5555" : "#39e0bc";
    ctx.stroke();
    if (!m) continue;
    ctx.setLineDash([]);
    for (const [length, angle, color] of [
      [m.major, m.angle, "#ffcf60"],
      [m.minor, m.angle + Math.PI / 2, "#79baff"],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(
        d.center.x - (Math.cos(angle) * length) / 2,
        d.center.y - (Math.sin(angle) * length) / 2,
      );
      ctx.lineTo(
        d.center.x + (Math.cos(angle) * length) / 2,
        d.center.y + (Math.sin(angle) * length) / 2,
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}
