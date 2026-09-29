import type { Analysis, Detection, Point, ROI } from "../types";
import { aiMarkerRadius } from "./markerSize";
import {
  drawNormalizedMarkers,
  drawEllipseDebug,
  markerPath,
} from "./normalizedMarkers";
import { ellipseDebugObjects } from "./EllipseDebug";
export type Mode = "select" | "add" | "delete";
export class ImageViewer {
  original?: HTMLCanvasElement;
  analysis?: Analysis;
  detections: Detection[] = [];
  selected?: string;
  private activeMode: Mode = "select";
  get mode() {
    return this.activeMode;
  }
  set mode(value: Mode) {
    this.cancelGesture();
    this.activeMode = value;
  }
  layer = "Final detections";
  roi?: ROI;
  private pointers = new Map<number, Point>();
  private start?: Point;
  private moved = false;
  private scale = 1;
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  private viewport: HTMLElement;
  onZoom: (scale: number) => void = () => {};
  onSelect: (id?: string) => void = () => {};
  onAdd: (p: Point) => void = () => {};
  onDelete: (id: string) => void = () => {};
  constructor(public canvas: HTMLCanvasElement) {
    const v = (this.viewport = canvas.parentElement!);
    new ResizeObserver(() => this.fit()).observe(v);
    window.addEventListener("resize", () => this.fit());
    v.addEventListener("pointerdown", (e) => {
      if (!this.original || (e.pointerType === "mouse" && e.button !== 0))
        return;
      if (!this.pointers.size) {
        this.start = { x: e.clientX, y: e.clientY };
        this.moved = false;
      } else this.moved = true;
      this.pointers.set(e.pointerId, this.local(e));
      v.setPointerCapture(e.pointerId);
    });
    v.addEventListener("pointermove", (e) => {
      const old = this.pointers.get(e.pointerId);
      if (!old) return;
      const before = [...this.pointers.values()];
      const next = this.local(e);
      this.pointers.set(e.pointerId, next);
      if (
        this.start &&
        Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > 6
      )
        this.moved = true;
      if (this.mode !== "select") return;
      if (this.pointers.size === 2) {
        const after = [...this.pointers.values()];
        const distance = (p: Point[]) =>
          Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const mid = (p: Point[]) => ({
          x: (p[0].x + p[1].x) / 2,
          y: (p[0].y + p[1].y) / 2,
        });
        const a = mid(before),
          b = mid(after);
        const scale = this.clamp(
          (this.scale * distance(after)) / Math.max(1, distance(before)),
        );
        const ratio = scale / this.scale;
        this.x = b.x - (a.x - this.x) * ratio;
        this.y = b.y - (a.y - this.y) * ratio;
        this.scale = scale;
      } else if (this.pointers.size === 1 && this.moved) {
        this.x += next.x - old.x;
        this.y += next.y - old.y;
      }
      this.paint();
    });
    v.addEventListener("pointerup", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const tap =
        !this.moved &&
        this.pointers.size === 1 &&
        this.start &&
        Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) <= 6;
      this.pointers.delete(e.pointerId);
      if (!tap) return;
      const rect = canvas.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        return;
      const p = this.point(e),
        d = this.hit(p);
      if (this.mode === "add") this.onAdd(p);
      else if (this.mode === "delete" && d) this.onDelete(d.id);
      else if (this.mode === "select") {
        this.selected = d?.id;
        this.onSelect(d?.id);
        this.draw();
      }
    });
    const cancel = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.delete(e.pointerId);
        this.moved = true;
      }
    };
    v.addEventListener("pointercancel", cancel);
    v.addEventListener("lostpointercapture", cancel);
    v.addEventListener(
      "wheel",
      (e) => {
        if (this.mode !== "select" || !e.ctrlKey) return;
        e.preventDefault();
        this.zoom(this.scale * Math.exp(-e.deltaY * 0.01), this.local(e));
      },
      { passive: false },
    );
  }
  cancelGesture() {
    this.pointers.clear();
    this.start = undefined;
    this.moved = true;
  }
  resetView() {
    this.cancelGesture();
    this.scale = 1;
    this.x = this.y = 0;
    this.fit();
  }
  private local(e: MouseEvent): Point {
    const r = this.viewport.getBoundingClientRect();
    return {
      x: e.clientX - r.left - r.width / 2,
      y: e.clientY - r.top - r.height / 2,
    };
  }
  private clamp(scale: number) {
    return Math.max(1, Math.min(8, scale));
  }
  zoom(scale: number, anchor: Point = { x: 0, y: 0 }) {
    const next = this.clamp(scale),
      ratio = next / this.scale;
    this.x = anchor.x - (anchor.x - this.x) * ratio;
    this.y = anchor.y - (anchor.y - this.y) * ratio;
    this.scale = next;
    this.paint();
  }
  private fit() {
    if (!this.original || !this.viewport.clientWidth) return;
    const height = Math.min(
      (this.viewport.clientWidth * this.original.height) / this.original.width,
      innerHeight * 0.65,
    );
    this.viewport.style.height = `${height}px`;
    const factor = Math.min(
      this.viewport.clientWidth / this.original.width,
      height / this.original.height,
    );
    const width = this.original.width * factor;
    if (this.width) {
      this.x *= width / this.width;
      this.y *= width / this.width;
    }
    this.width = width;
    this.height = this.original.height * factor;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.paint();
  }
  private paint() {
    const maxX = Math.max(
      0,
      (this.width * this.scale - this.viewport.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (this.height * this.scale - this.viewport.clientHeight) / 2,
    );
    this.x = Math.max(-maxX, Math.min(maxX, this.x));
    this.y = Math.max(-maxY, Math.min(maxY, this.y));
    this.canvas.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.onZoom(this.scale);
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
  private hit(p: Point) {
    const ctx = this.canvas.getContext("2d")!;
    return [...this.detections].reverse().find((d) => {
      ctx.beginPath();
      if (this.analysis?.ellipseReview)
        markerPath(ctx, d, this.analysis.ellipseReview.reference);
      else if (d.source === "ai")
        ctx.arc(
          d.center.x,
          d.center.y,
          aiMarkerRadius(d, this.detections),
          0,
          Math.PI * 2,
        );
      else
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
  draw(c = this.canvas, finalOnly = false) {
    if (!this.original) return;
    c.width = this.original.width;
    c.height = this.original.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(this.original, 0, 0);
    const layer = finalOnly ? "Final detections" : this.layer;
    const debug = finalOnly ? undefined : this.analysis?.debug[layer];
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
    if (["Final detections", "Contours"].includes(layer))
      (layer === "Contours"
        ? this.analysis?.candidates || this.detections
        : this.detections
      ).forEach((d, i) => {
        const selected = !finalOnly && d.id === this.selected;
        if (layer === "Final detections" && this.analysis?.ellipseReview) {
          drawNormalizedMarkers(
            ctx,
            d,
            this.analysis.ellipseReview.reference,
            selected,
            c.width,
          );
        } else {
          ctx.beginPath();
          if (d.source === "ai")
            ctx.arc(
              d.center.x,
              d.center.y,
              aiMarkerRadius(d, this.detections),
              0,
              Math.PI * 2,
            );
          else
            d.contour.forEach((p, j) =>
              j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
            );
          ctx.closePath();
          ctx.lineWidth = Math.max(1.5, c.width / 450);
          ctx.strokeStyle = selected
            ? "#ffcf60"
            : d.source === "manual"
              ? "#67b8ff"
              : d.source === "ai"
                ? "#153eab"
                : "#39e0bc";
          ctx.fillStyle = selected
            ? "#ffcf6044"
            : d.source === "ai"
              ? "#153eab19"
              : "#24d9aa19";
          ctx.fill();
          ctx.stroke();
        }
        if (layer === "Contours") return;
        const screenScale =
            c.width /
            Math.max(
              1,
              finalOnly
                ? Math.min(c.width, 960)
                : this.canvas.getBoundingClientRect().width,
            ),
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
    if (layer === "Ellipse review" && this.analysis?.ellipseReview)
      drawEllipseDebug(
        ctx,
        ellipseDebugObjects(this.analysis, this.detections),
        this.analysis.ellipseReview.reference,
        c.width,
      );
    const roi = this.roi || this.analysis?.roi;
    if (roi && !finalOnly) {
      ctx.strokeStyle = "#ffcf60";
      ctx.lineWidth = Math.max(2, c.width / 400);
      ctx.setLineDash([c.width * 0.01, c.width * 0.006]);
      ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
      ctx.setLineDash([]);
    }
  }
}
