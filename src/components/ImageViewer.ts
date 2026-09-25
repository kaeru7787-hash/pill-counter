import type { Analysis, Detection, Point, ROI } from "../types";
export type Mode = "select" | "add" | "delete" | "roi" | "batch";
export class ImageViewer {
  original?: HTMLCanvasElement;
  analysis?: Analysis;
  detections: Detection[] = [];
  selected?: string;
  mode: Mode = "select";
  layer = "Final detections";
  roi?: ROI;
  private start?: Point;
  private dragging?: ROI;
  onSelect: (id?: string) => void = () => {};
  onAdd: (p: Point) => void = () => {};
  onDelete: (id: string) => void = () => {};
  onROI: (roi: ROI) => void = () => {};
  onBatch: (roi: ROI) => void = () => {};
  constructor(public canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.original) return;
      this.start = this.point(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if ((this.mode === "roi" || this.mode === "batch") && this.start) {
        this.dragging = this.rectangle(this.start, this.point(e));
        this.draw();
      }
    });
    canvas.addEventListener("pointercancel", () => {
      this.start = undefined;
      this.dragging = undefined;
      this.draw();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!this.start) return;
      const p = this.point(e),
        start = this.start;
      this.start = undefined;
      if (this.mode === "roi" || this.mode === "batch") {
        const r = this.rectangle(start, p);
        this.dragging = undefined;
        if (
          r.width > this.canvas.width * 0.025 &&
          r.height > this.canvas.height * 0.025
        ) {
          if (this.mode === "batch") this.onBatch(r);
          else {
            this.roi = r;
            this.onROI(r);
          }
        }
        this.draw();
        return;
      }
      if (Math.hypot(p.x - start.x, p.y - start.y) > this.canvas.width * 0.03)
        return;
      const d = this.hit(p);
      if (this.mode === "add") this.onAdd(p);
      else if (this.mode === "delete" && d) this.onDelete(d.id);
      else {
        this.selected = d?.id;
        this.onSelect(d?.id);
        this.draw();
      }
    });
  }
  private point(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          this.canvas.width - 1,
          ((e.clientX - r.left) * this.canvas.width) / r.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.canvas.height - 1,
          ((e.clientY - r.top) * this.canvas.height) / r.height,
        ),
      ),
    };
  }
  private rectangle(a: Point, b: Point): ROI {
    return {
      x: Math.round(Math.min(a.x, b.x)),
      y: Math.round(Math.min(a.y, b.y)),
      width: Math.round(Math.abs(a.x - b.x)),
      height: Math.round(Math.abs(a.y - b.y)),
    };
  }
  private hit(p: Point) {
    const ctx = this.canvas.getContext("2d")!;
    return [...this.detections].reverse().find((d) => {
      ctx.beginPath();
      d.contour.forEach((pt, i) =>
        i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y),
      );
      ctx.closePath();
      return (
        ctx.isPointInPath(p.x, p.y) ||
        Math.hypot(p.x - d.center.x, p.y - d.center.y) <
          this.canvas.width * 0.014
      );
    });
  }
  draw() {
    if (!this.original) return;
    const c = this.canvas;
    c.width = this.original.width;
    c.height = this.original.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(this.original, 0, 0);
    const debug = this.analysis?.debug[this.layer];
    if (debug) {
      const off = document.createElement("canvas");
      off.width = debug.width;
      off.height = debug.height;
      off
        .getContext("2d")!
        .putImageData(
          new ImageData(
            new Uint8ClampedArray(debug.data),
            debug.width,
            debug.height,
          ),
          0,
          0,
        );
      ctx.fillStyle = "#17242d";
      ctx.fillRect(0, 0, c.width, c.height);
      const origin = debug.origin || this.analysis!.roi;
      ctx.drawImage(off, origin.x, origin.y);
    }
    if (["Final detections", "Contours"].includes(this.layer))
      (this.layer === "Contours"
        ? this.analysis?.candidates || this.detections
        : this.detections
      ).forEach((d, i) => {
        const selected = d.id === this.selected;
        ctx.beginPath();
        d.contour.forEach((p, j) =>
          j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
        );
        ctx.closePath();
        ctx.lineWidth = Math.max(1.5, c.width / 450);
        ctx.strokeStyle = selected
          ? "#ffcf60"
          : d.source === "manual"
            ? "#67b8ff"
            : "#39e0bc";
        ctx.fillStyle = selected ? "#ffcf6044" : "#24d9aa19";
        ctx.fill();
        ctx.stroke();
        if (this.layer === "Contours") return;
        const screenScale =
            c.width / Math.max(1, c.getBoundingClientRect().width),
          nearest = Math.min(
            ...this.detections
              .filter((e) => e.id !== d.id)
              .map((e) =>
                Math.hypot(d.center.x - e.center.x, d.center.y - e.center.y),
              ),
          ),
          r = Math.max(
            2,
            Math.min(
              nearest * 0.32,
              Math.sqrt(d.area) * 0.22,
              11 * screenScale,
            ),
          );
        ctx.beginPath();
        ctx.arc(d.center.x, d.center.y, r, 0, Math.PI * 2);
        ctx.fillStyle = selected ? "#775000" : "#0b3444e8";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${r * (i >= 99 ? 1 : 1.22)}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), d.center.x, d.center.y + 0.5);
      });
    const roi = this.dragging || this.roi || this.analysis?.roi;
    if (roi) {
      ctx.strokeStyle = "#ffcf60";
      ctx.lineWidth = Math.max(2, c.width / 400);
      ctx.setLineDash([c.width * 0.01, c.width * 0.006]);
      ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
      ctx.setLineDash([]);
    }
  }
}
