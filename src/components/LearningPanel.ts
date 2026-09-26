import type {
  Analysis,
  Detection,
  Point,
  Raster,
  ROI,
  Settings,
} from "../types";
import {
  examplesFrom,
  intersects,
  samplingBox,
  suggest,
  type LearningRecord,
  type Model,
  type Target,
  type TrainingReport,
} from "../learning";
import {
  downloadBlob,
  imageHash,
  learningExport,
  pngBytes,
  readLearning,
  writeLearning,
} from "../learningStore";

export type LearningSnapshot = {
  original: HTMLCanvasElement;
  image: Raster;
  result: Analysis;
  corrected: Detection[];
  settings: Settings;
  confirmed: boolean;
};
export class LearningPanel {
  private records: LearningRecord[] = [];
  private models = new Map<Target, Model>();
  private busy = false;
  private analysisBusy = false;
  private currentKey = "";
  private target: Target = "pill";
  private dialog = document.createElement("dialog");
  private canvas: HTMLCanvasElement;
  private sample?: LearningSnapshot;
  private masks: ROI[] = [];
  private start?: Point;
  private removed: Detection[] = [];
  private reasons: Record<string, string> = {};
  private q = <T extends HTMLElement = HTMLElement>(s: string) =>
    this.root.querySelector<T>(s)!;
  private d = <T extends HTMLElement = HTMLElement>(s: string) =>
    this.dialog.querySelector<T>(s)!;
  constructor(
    private root: HTMLElement,
    private snapshot: () => LearningSnapshot | undefined,
    private add: (p: Point) => void,
    private select: (id: string) => void,
  ) {
    root.innerHTML = `<details><summary>精度向上に協力・学習補助（試験）</summary>
      <p>確認済みの修正から、この端末専用の補助モデルを作ります。学習後も個数は自動変更せず、見直す場所を提案します。</p>
      <p class="muted">写真・編集結果はこのブラウザー内に保存します。自動送信はしません。書き出したファイルを開発者に渡す場合だけ共有されます。</p>
      <button data-learn="capture" disabled>確認済みの結果を学習用に保存</button>
      <p data-learn="message" role="status">全体を目視確認してから保存できます。</p>
      <div class="learning-controls"><button data-learn="train">保存データから学習する</button><button data-learn="suggest" disabled>学習した補助で見直す</button><button data-learn="export">学習データを書き出す</button></div>
      <p data-learn="model" class="muted">補助モデルは未学習です。錠剤と点眼ボトルは別々に学習します。</p>
      <p class="muted">学習には異なる撮影セット4組以上、薬品20個以上、薬品以外の例8個以上が必要です。同じ薬品の並べ替え・撮り直しは同じ撮影セットにしてください。</p>
      <div data-learn="suggestions" class="learning-suggestions"></div>
      <details><summary>保存済みデータの確認・削除</summary><div data-learn="records"></div></details>
      <p class="muted">端末のデータ消去で学習データは失われます。補助モデルはページを開き直したら再学習してください。書き出しはバックアップにも利用できます。</p>
    </details>`;
    this.dialog.className = "learning-dialog";
    this.dialog.setAttribute("aria-labelledby", "learning-title");
    this.dialog.innerHTML = `<div class="learning-heading"><h2 id="learning-title">学習用画像の確認</h2><button data-action="close" aria-label="学習画面を閉じる">×</button></div>
      <p>必要なら画像をドラッグし、氏名・処方番号などを黒く隠してください。解析範囲外は自動的に隠します。黒く隠した場所は学習対象から外れます。</p>
      <canvas aria-label="学習用画像。ドラッグして隠す範囲を選択"></canvas><button data-action="undo-mask">最後の黒塗りを戻す</button>
      <p data-action="summary"></p>
      <label class="field">撮影セット名<input data-action="group" maxlength="40" placeholder="例：白い丸錠A・初回撮影（氏名は入力しない）"></label>
      <p class="muted">同じ薬品の撮り直しには同じ名前を使ってください。別写真での検証に使います。</p>
      <details><summary>削除した枠の理由（背景の学習に使用）</summary><div data-action="removed"></div></details>
      <label class="check"><input type="checkbox" data-action="consent">番号・数え漏れと個人情報の有無を確認し、この画像と修正結果を端末内の学習用に保存する</label>
      <p data-action="status" role="status"></p><button class="button primary full" data-action="save">この内容を保存</button>`;
    document.body.append(this.dialog);
    this.canvas = this.d<HTMLCanvasElement>("canvas");
    this.q('[data-learn="capture"]').onclick = () => this.open();
    this.q('[data-learn="train"]').onclick = () => void this.train();
    this.q('[data-learn="suggest"]').onclick = () => this.review();
    this.q('[data-learn="export"]').onclick = () => void this.export();
    this.d('[data-action="close"]').onclick = () => this.dialog.close();
    this.dialog.addEventListener("cancel", (e) => {
      if (this.busy) e.preventDefault();
    });
    this.dialog.addEventListener("close", () => {
      if (!this.dialog.open) {
        this.sample = undefined;
        this.canvas.width = this.canvas.height = 1;
        this.start = undefined;
      }
    });
    this.d('[data-action="save"]').onclick = () => void this.save();
    this.d('[data-action="undo-mask"]').onclick = () => {
      this.masks.pop();
      this.d<HTMLInputElement>('[data-action="consent"]').checked = false;
      this.paint();
    };
    const point = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: Math.max(
          0,
          Math.min(
            this.canvas.width,
            ((e.clientX - r.x) * this.canvas.width) / r.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            this.canvas.height,
            ((e.clientY - r.y) * this.canvas.height) / r.height,
          ),
        ),
      };
    };
    this.canvas.onpointerdown = (e) => {
      if (this.busy) return;
      this.start = point(e);
      this.canvas.setPointerCapture(e.pointerId);
    };
    this.canvas.onpointerup = (e) => {
      if (!this.start || this.busy) return;
      const end = point(e),
        r = {
          x: Math.min(end.x, this.start.x),
          y: Math.min(end.y, this.start.y),
          width: Math.abs(end.x - this.start.x),
          height: Math.abs(end.y - this.start.y),
        };
      this.start = undefined;
      if (r.width > 2 && r.height > 2) {
        this.masks.push(r);
        this.d<HTMLInputElement>('[data-action="consent"]').checked = false;
        this.paint();
      }
    };
    this.canvas.onpointercancel = () => {
      this.start = undefined;
    };
    void this.refresh().catch((e) => this.message(String(e)));
  }
  private message(text: string) {
    this.q('[data-learn="message"]').textContent = text;
  }
  update(analysisBusy: boolean) {
    this.analysisBusy = analysisBusy;
    const s = this.snapshot();
    this.target = s?.settings.target || "pill";
    const key = s
      ? JSON.stringify([s.result.version, s.settings.target, s.corrected])
      : "";
    if (this.currentKey !== key || analysisBusy)
      this.q('[data-learn="suggestions"]').replaceChildren();
    this.currentKey = key;
    this.q<HTMLButtonElement>('[data-learn="capture"]').disabled =
      this.busy || analysisBusy || !s?.confirmed;
    for (const action of ["train", "export"])
      this.q<HTMLButtonElement>(`[data-learn="${action}"]`).disabled =
        this.busy || analysisBusy || !this.records.length;
    this.q<HTMLButtonElement>('[data-learn="suggest"]').disabled =
      this.busy || analysisBusy || !s || !this.models.has(this.target);
    this.root
      .querySelectorAll<HTMLButtonElement>("[data-record-action]")
      .forEach((b) => (b.disabled = this.busy));
  }
  private async refresh() {
    this.records = await readLearning();
    this.records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const list = this.q('[data-learn="records"]');
    list.replaceChildren();
    for (const record of this.records) {
      const row = document.createElement("div");
      row.className = "learning-record";
      const label = document.createElement("span");
      label.textContent = `${record.group} · ${record.target === "bottle" ? "点眼" : "錠剤"} ${record.totalCount}個 · ${record.examples.length}例`;
      const view = document.createElement("button");
      view.textContent = "画像を確認";
      view.dataset.recordAction = "view";
      view.onclick = () => {
        const url = URL.createObjectURL(
          new Blob([record.image], { type: "image/png" }),
        );
        const image = document.createElement("img");
        image.src = url;
        image.alt = "保存済みの学習画像";
        image.onload = () => URL.revokeObjectURL(url);
        row.querySelector("img")?.remove();
        row.append(image);
      };
      const remove = document.createElement("button");
      remove.textContent = "このデータを削除";
      remove.dataset.recordAction = "delete";
      remove.onclick = async () => {
        if (
          !window.confirm(
            "この学習データを端末から削除しますか？対応する補助モデルも解除されます。",
          )
        )
          return;
        this.busy = true;
        this.update(this.analysisBusy);
        try {
          await writeLearning(record.id);
          this.models.delete(record.target);
          await this.refresh();
          this.q('[data-learn="model"]').textContent =
            "データを削除しました。補助モデルは再学習してください。";
        } catch (e) {
          this.message(String(e));
        } finally {
          this.busy = false;
          this.update(this.analysisBusy);
        }
      };
      row.append(label, view, remove);
      list.append(row);
    }
    if (!this.records.length) list.textContent = "保存済みデータはありません。";
    this.update(this.analysisBusy);
  }
  private open() {
    const s = this.snapshot();
    if (!s?.confirmed || this.busy || this.analysisBusy) return;
    this.sample = {
      ...s,
      corrected: structuredClone(s.corrected),
      result: structuredClone({ ...s.result, debug: {} }),
      settings: structuredClone(s.settings),
    };
    this.masks = [];
    this.reasons = {};
    this.removed = s.result.detections.filter(
      (d) => !s.corrected.some((c) => c.id === d.id),
    );
    this.d<HTMLInputElement>('[data-action="consent"]').checked = false;
    this.d('[data-action="status"]').textContent = "";
    const list = this.d('[data-action="removed"]');
    list.replaceChildren();
    for (const d of this.removed) {
      const row = document.createElement("label");
      row.className = "learning-deletion";
      const thumb = document.createElement("canvas");
      thumb.width = thumb.height = 96;
      const b = samplingBox(d.box);
      thumb
        .getContext("2d")!
        .drawImage(s.original, b.x, b.y, b.width, b.height, 0, 0, 96, 96);
      const text = document.createElement("span");
      text.textContent = `削除位置 ${Math.round(d.center.x)}, ${Math.round(d.center.y)}`;
      const select = document.createElement("select");
      select.setAttribute("aria-label", text.textContent);
      for (const [value, label] of [
        ["unknown", "未分類（学習しない）"],
        ["duplicate", "二重検出だった"],
        ["background", "薬品以外・反射だった"],
      ]) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        select.append(o);
      }
      select.onchange = () => {
        this.reasons[d.id] = select.value;
        this.d<HTMLInputElement>('[data-action="consent"]').checked = false;
        this.paint();
      };
      row.append(thumb, text, select);
      list.append(row);
    }
    if (!this.removed.length)
      list.textContent =
        "削除した検出はありません。背景例を無理に作る必要はありません。";
    this.paint();
    this.dialog.showModal();
  }
  private sanitized() {
    const s = this.sample!,
      c = document.createElement("canvas");
    c.width = s.image.width;
    c.height = s.image.height;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    const r = s.result.roi;
    ctx.drawImage(
      s.original,
      r.x,
      r.y,
      r.width,
      r.height,
      r.x,
      r.y,
      r.width,
      r.height,
    );
    for (const m of this.masks)
      ctx.fillRect(
        Math.floor(m.x),
        Math.floor(m.y),
        Math.ceil(m.width) + 1,
        Math.ceil(m.height) + 1,
      );
    return c;
  }
  private paint() {
    if (!this.sample) return;
    const clean = this.sanitized();
    this.canvas.width = clean.width;
    this.canvas.height = clean.height;
    const ctx = this.canvas.getContext("2d")!;
    ctx.drawImage(clean, 0, 0);
    clean.width = clean.height = 1;
    const s = this.sample;
    ctx.font = `bold ${Math.max(14, s.image.width / 70)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    s.corrected.forEach((d, i) => {
      if (this.masks.some((m) => intersects(m, samplingBox(d.box)))) return;
      const r = Math.max(9, s.image.width / 110);
      ctx.fillStyle = "#123954";
      ctx.beginPath();
      ctx.arc(d.center.x, d.center.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.fillText(String(i + 1), d.center.x, d.center.y);
    });
    const examples = examplesFrom(
      s.image,
      s.corrected,
      this.removed,
      this.reasons,
      this.masks,
      s.result.roi,
    );
    this.d('[data-action="summary"]').textContent =
      `確認済み ${s.corrected.length}個。学習に使える薬品 ${examples.filter((e) => e.y).length}例・背景 ${examples.filter((e) => !e.y).length}例。黒塗り・範囲境界の例は除外します。`;
  }
  private async save() {
    const s = this.sample;
    if (!s || this.busy) return;
    const group = this.d<HTMLInputElement>(
      '[data-action="group"]',
    ).value.trim();
    if (
      !group ||
      !this.d<HTMLInputElement>('[data-action="consent"]').checked
    ) {
      this.d('[data-action="status"]').textContent =
        "撮影セット名を入力し、内容確認にチェックしてください。";
      return;
    }
    this.busy = true;
    this.setDialogBusy(true);
    this.update(this.analysisBusy);
    try {
      const hash = await imageHash(s.original),
        target = s.settings.target || "pill",
        id = `${target}:${hash}`;
      const previous = this.records.find((r) => r.id === id);
      if (!previous && this.records.length >= 40)
        throw new Error(
          "学習データは40枚までです。書き出してから不要なデータを削除してください。",
        );
      const canvas = this.sanitized(),
        image = await pngBytes(canvas);
      canvas.width = canvas.height = 1;
      if (
        this.records
          .filter((r) => r.id !== id)
          .reduce((sum, r) => sum + r.image.byteLength, image.byteLength) >
        80 * 1024 * 1024
      )
        throw new Error(
          "学習画像が80MBを超えます。不要なデータを削除してください。",
        );
      const examples = examplesFrom(
        s.image,
        s.corrected,
        this.removed,
        this.reasons,
        this.masks,
        s.result.roi,
      );
      if (!examples.length)
        throw new Error(
          "学習に使える場所がありません。黒塗り範囲を見直してください。",
        );
      const visible = (d: Detection) =>
        d.center.x >= s.result.roi.x &&
        d.center.y >= s.result.roi.y &&
        d.center.x <= s.result.roi.x + s.result.roi.width &&
        d.center.y <= s.result.roi.y + s.result.roi.height &&
        !this.masks.some((m) => intersects(m, samplingBox(d.box)));
      const record: LearningRecord = {
        schemaVersion: 1,
        id,
        imageHash: hash,
        group,
        target,
        createdAt: new Date().toISOString(),
        appVersion: "0.9.0",
        algorithm: `${s.result.algorithm || "CV"} / ${s.result.aiStatus || ""}`,
        width: s.image.width,
        height: s.image.height,
        roi: s.result.roi,
        masks: structuredClone(this.masks),
        image,
        examples,
        centers: s.corrected
          .filter(visible)
          .map((d) => ({
            ...d.center,
            kind: d.source === "manual" ? "added" : "confirmed",
          })),
        removed: this.removed
          .filter(visible)
          .map((d) => ({
            center: d.center,
            reason: (this.reasons[d.id] || "unknown") as
              | "unknown"
              | "duplicate"
              | "background",
          })),
        totalCount: s.corrected.length,
        confirmed: true,
      };
      await writeLearning(record);
      this.models.delete(target);
      await this.refresh();
      this.message(
        previous
          ? "同じ写真の学習データを更新しました。再学習すると反映されます。"
          : "端末内に保存しました。データがそろったら「保存データから学習する」を押してください。",
      );
      this.q('[data-learn="model"]').textContent =
        "データを更新しました。補助モデルは再学習してください。";
      this.dialog.close();
    } catch (e) {
      this.d('[data-action="status"]').textContent = String(e);
    } finally {
      this.busy = false;
      this.setDialogBusy(false);
      this.update(this.analysisBusy);
    }
  }
  private setDialogBusy(value: boolean) {
    this.dialog
      .querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement
      >("button,input,select")
      .forEach((el) => (el.disabled = value));
  }
  private async train() {
    if (this.busy) return;
    this.busy = true;
    this.update(this.analysisBusy);
    this.message("写真の組を分けて学習・検証しています…");
    const target = this.target,
      worker = new Worker(
        new URL("../workers/learningWorker.ts", import.meta.url),
        { type: "module" },
      );
    try {
      const result = await new Promise<{
        report: TrainingReport;
        model?: Model;
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("学習に時間がかかりすぎたため中止しました")),
          60000,
        );
        worker.onmessage = (e) => {
          clearTimeout(timer);
          e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
        };
        worker.onerror = () => {
          clearTimeout(timer);
          reject(new Error("学習処理を実行できませんでした"));
        };
        worker.postMessage({
          target,
          records: this.records.map((r) => ({
            ...r,
            image: new ArrayBuffer(0),
          })),
        });
      });
      this.models.delete(target);
      if (result.model) this.models.set(target, result.model);
      const r = result.report;
      this.q('[data-learn="model"]').textContent =
        `${target === "bottle" ? "点眼" : "錠剤"}：${r.groups}組・薬品${r.positive}例・背景${r.negative}例。別撮影セットで正答${r.correct}／誤答${r.wrong}／判定保留${r.abstained}。${r.eligible ? "補助候補の提示に使用できます。検出精度の保証ではありません。" : r.reasons.join("。")}`;
      this.message(
        r.eligible
          ? "補助モデルを学習しました。「学習した補助で見直す」で提案を確認できます。個数は自動では変わりません。"
          : "今回は補助モデルを採用していません。確認済みデータを追加して再学習できます。",
      );
    } catch (e) {
      this.message(String(e));
    } finally {
      worker.terminate();
      this.busy = false;
      this.update(this.analysisBusy);
    }
  }
  private review() {
    const s = this.snapshot(),
      m = this.models.get(this.target);
    if (!s || !m || this.busy || this.analysisBusy) return;
    const deleted = s.result.detections.filter(
      (d) => !s.corrected.some((c) => c.id === d.id),
    );
    const r = s.result.roi;
    const candidates = [
      ...(s.result.rejectedCandidates || []),
      ...(s.result.candidates || []),
    ].filter(
      (d) =>
        d.center.x >= r.x &&
        d.center.y >= r.y &&
        d.center.x <= r.x + r.width &&
        d.center.y <= r.y + r.height &&
        !deleted.some(
          (e) =>
            Math.hypot(e.center.x - d.center.x, e.center.y - d.center.y) <
            Math.min(e.box.width, e.box.height) * 0.65,
        ),
    );
    const suggestions = suggest(m, s.image, s.corrected, candidates);
    const list = this.q('[data-learn="suggestions"]');
    list.replaceChildren();
    for (const [kind, items] of [
      ["review", suggestions.review],
      ["add", suggestions.add],
    ] as const)
      for (const d of items) {
        const row = document.createElement("div");
        const c = document.createElement("canvas");
        c.width = c.height = 112;
        const b = samplingBox(d.box);
        c.getContext("2d")!.drawImage(
          s.original,
          b.x,
          b.y,
          b.width,
          b.height,
          0,
          0,
          112,
          112,
        );
        const text = document.createElement("p");
        text.textContent =
          kind === "review"
            ? `番号${s.corrected.findIndex((e) => e.id === d.id) + 1}：背景に似ているため見直し候補`
            : `未採用候補：位置 ${Math.round(d.center.x)}, ${Math.round(d.center.y)}`;
        const button = document.createElement("button");
        button.textContent =
          kind === "review" ? "この番号を確認" : "薬品と確認して追加";
        button.onclick = () => {
          if (
            this.currentKey !==
            JSON.stringify([s.result.version, s.settings.target, s.corrected])
          )
            return;
          if (kind === "review") this.select(d.id);
          else this.add(d.center);
        };
        row.append(c, text, button);
        list.append(row);
      }
    if (!list.childElementCount)
      list.textContent =
        "今回提示できる候補はありません。数え漏れがないという判定ではありません。";
    this.message(
      "学習した見た目との比較による参考候補です。必ず画像全体を確認してください。既存処理が候補を作れない場所は提案できません。",
    );
  }
  private async export() {
    if (this.busy) return;
    if (
      !window.confirm(
        "保存済みの画像・撮影セット名・修正結果を含む学習ファイルを書き出します。個人情報を隠した画像か、保存済み一覧で確認しましたか？自動送信はしません。",
      )
    )
      return;
    this.busy = true;
    this.update(this.analysisBusy);
    try {
      const blob = await learningExport(this.records);
      downloadBlob(
        blob,
        `pill-learning-${new Date().toISOString().slice(0, 10)}.json`,
      );
      this.message(
        `${this.records.length}枚の学習データを書き出しました。提供する場合は非公開の方法で開発者に渡してください。`,
      );
    } catch (e) {
      this.message(String(e));
    } finally {
      this.busy = false;
      this.update(this.analysisBusy);
    }
  }
}
