import type { ImageViewer } from "./ImageViewer";

/** A read-only view: gestures never reach the editing canvas. */
export class ResultZoom {
  private dialog = document.createElement("dialog");
  private canvas: HTMLCanvasElement;
  private viewport: HTMLElement;
  private output: HTMLOutputElement;
  private points = new Map<number, { x: number; y: number }>();
  private scale = 1;
  private x = 0;
  private y = 0;
  private width = 1;
  private height = 1;
  private previousOverflow = "";
  private returnFocus?: HTMLElement;

  constructor(private viewer: ImageViewer) {
    this.dialog.className = "result-zoom";
    this.dialog.setAttribute("aria-labelledby", "result-zoom-title");
    this.dialog.innerHTML = `
      <div class="result-zoom-header"><h2 id="result-zoom-title">番号付き画像</h2><button type="button" class="result-zoom-close" aria-label="拡大画像を閉じる" autofocus>×</button></div>
      <div class="result-zoom-controls"><button type="button" data-zoom="out" aria-label="縮小">−</button><output aria-label="拡大率">100%</output><button type="button" data-zoom="in" aria-label="拡大">＋</button><button type="button" data-zoom="fit">全体を表示</button></div>
      <p class="result-zoom-hint">2本指で拡大・縮小、ドラッグで移動。濃い青の枠はAI補助です。</p>
      <div class="result-zoom-viewport"><canvas aria-label="番号付き検出画像の拡大表示"></canvas></div>`;
    document.body.append(this.dialog);
    this.canvas = this.dialog.querySelector("canvas")!;
    this.viewport = this.dialog.querySelector(".result-zoom-viewport")!;
    this.output = this.dialog.querySelector("output")!;
    this.dialog.querySelector<HTMLButtonElement>(
      ".result-zoom-close",
    )!.onclick = () => this.dialog.close();
    this.dialog.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.onclick =
      () => this.zoom(this.scale * 1.5);
    this.dialog.querySelector<HTMLButtonElement>('[data-zoom="out"]')!.onclick =
      () => this.zoom(this.scale / 1.5);
    this.dialog.querySelector<HTMLButtonElement>('[data-zoom="fit"]')!.onclick =
      () => this.fit();
    this.dialog.addEventListener("close", () => {
      this.points.clear();
      document.body.style.overflow = this.previousOverflow;
      this.canvas.width = this.canvas.height = 1;
      this.returnFocus?.focus({ preventScroll: true });
    });
    const point = (e: PointerEvent) => {
      const r = this.viewport.getBoundingClientRect();
      return {
        x: e.clientX - r.left - r.width / 2,
        y: e.clientY - r.top - r.height / 2,
      };
    };
    this.viewport.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      this.viewport.setPointerCapture(e.pointerId);
      this.points.set(e.pointerId, point(e));
    });
    this.viewport.addEventListener("pointermove", (e) => {
      if (!this.points.has(e.pointerId)) return;
      const before = [...this.points.values()].slice(0, 2);
      this.points.set(e.pointerId, point(e));
      const after = [...this.points.values()].slice(0, 2);
      if (before.length === 1) {
        this.x += after[0].x - before[0].x;
        this.y += after[0].y - before[0].y;
      } else {
        const distance = (p: typeof before) =>
          Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const mid = (p: typeof before) => ({
          x: (p[0].x + p[1].x) / 2,
          y: (p[0].y + p[1].y) / 2,
        });
        const a = mid(before),
          b = mid(after);
        const next = this.clamp(
          (this.scale * distance(after)) / Math.max(1, distance(before)),
        );
        const ratio = next / this.scale;
        this.x = b.x - (a.x - this.x) * ratio;
        this.y = b.y - (a.y - this.y) * ratio;
        this.scale = next;
      }
      this.paint();
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      this.viewport.addEventListener(type, (e) =>
        this.points.delete((e as PointerEvent).pointerId),
      );
    this.viewport.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.viewport.getBoundingClientRect();
        this.zoom(
          this.scale * Math.exp(-e.deltaY * 0.002),
          e.clientX - r.left - r.width / 2,
          e.clientY - r.top - r.height / 2,
        );
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      if (this.dialog.open) this.fit();
    }).observe(this.viewport);
  }
  open(opener?: HTMLElement) {
    if (!this.viewer.original || this.dialog.open) return;
    this.returnFocus = opener || (document.activeElement as HTMLElement);
    this.previousOverflow = document.body.style.overflow;
    this.viewer.draw(this.canvas, true);
    this.dialog.showModal();
    document.body.style.overflow = "hidden";
    this.fit();
  }
  private clamp(n: number) {
    return Math.max(1, Math.min(8, n));
  }
  private fit() {
    const factor = Math.min(
      this.viewport.clientWidth / this.canvas.width,
      this.viewport.clientHeight / this.canvas.height,
    );
    this.width = this.canvas.width * factor;
    this.height = this.canvas.height * factor;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.scale = 1;
    this.x = this.y = 0;
    this.points.clear();
    this.paint();
  }
  private zoom(next: number, x = 0, y = 0) {
    next = this.clamp(next);
    this.x = x - ((x - this.x) * next) / this.scale;
    this.y = y - ((y - this.y) * next) / this.scale;
    this.scale = next;
    this.paint();
  }
  private paint() {
    const dx = Math.max(
      0,
      (this.width * this.scale - this.viewport.clientWidth) / 2,
    );
    const dy = Math.max(
      0,
      (this.height * this.scale - this.viewport.clientHeight) / 2,
    );
    this.x = Math.max(-dx, Math.min(dx, this.x));
    this.y = Math.max(-dy, Math.min(dy, this.y));
    this.canvas.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.output.value = `${Math.round(this.scale * 100)}%`;
    this.dialog.querySelector<HTMLButtonElement>(
      '[data-zoom="out"]',
    )!.disabled = this.scale <= 1;
    this.dialog.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.disabled =
      this.scale >= 8;
  }
}
