import {
  emptyModel,
  learnCorrections,
  mergeModels,
  type LocalModel,
} from "../autoLearning";
import { AutoLearningStore } from "../autoLearningStore";
import { readLearning, writeLearning } from "../learningStore";
import type { Target } from "../learning";
import type { Analysis, Detection, Raster } from "../types";

export class AutoLearning {
  private store?: AutoLearningStore;
  private failed = false;
  private session?: { id: string; target: Target };
  readonly ready: Promise<void>;
  constructor(private output: HTMLElement) {
    output.setAttribute("role", "status");
    output.textContent = "補正から自動学習します。";
    try {
      this.store = new AutoLearningStore(localStorage);
      this.store.recover();
    } catch {
      this.error();
    }
    this.ready = this.migrate();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.finish();
    });
    window.addEventListener("pagehide", () => this.finish());
  }
  private error() {
    this.output.textContent =
      "自動学習を保存できません。端末の空き容量・保存設定を確認してください。";
  }
  begin(id: string, target: Target) {
    this.session = { id: `${id}:${target}`, target };
  }
  stage(image: Raster, analysis: Analysis, corrected: Detection[]) {
    if (!this.session || !this.store) return;
    try {
      // Training happens while the page is alive. Only trained parameters are
      // checkpointed synchronously; process termination cannot lose a queued job.
      const model = learnCorrections(
        image,
        analysis.detections,
        corrected,
        analysis.roi,
        this.session.target,
      );
      this.store.stage(this.session.id, model);
      this.failed = false;
      const effect = analysis.learning;
      this.output.textContent = model.updates
        ? "補正を自動学習済み。次の画像・終了時に反映します。"
        : effect?.updates
          ? `学習 ${effect.updates}回・今回の反映：追加 ${effect.added} / 除外 ${effect.removed}`
          : "追加・削除した補正から自動学習します。";
    } catch {
      this.failed = true;
      this.error();
    }
  }
  report(analysis: Analysis) {
    const effect = analysis.learning;
    this.output.textContent = effect?.updates
      ? `学習 ${effect.updates}回・今回の反映：追加 ${effect.added} / 除外 ${effect.removed}`
      : "追加・削除した補正から自動学習します。";
  }
  finish() {
    if (!this.store) return;
    if (this.failed) {
      this.error();
      return;
    }
    try {
      if (this.session) this.store.finish(this.session.target, this.session.id);
      const model = this.session && this.store.model(this.session.target);
      this.output.textContent = model?.updates
        ? `学習 ${model.updates}回を反映済み。学習用画像は保持しません。`
        : "追加・削除した補正から自動学習します。";
    } catch {
      this.error();
    }
  }
  model(target: Target): LocalModel | undefined {
    try {
      return this.store?.model(target);
    } catch {
      this.error();
      return undefined;
    }
  }
  private async migrate() {
    if (!this.store) return;
    try {
      const records = await readLearning();
      for (const r of records) {
        if (!r.confirmed) {
          await writeLearning(r.id);
          continue;
        }
        let model = emptyModel(r.target);
        for (const e of r.examples) {
          const x = e.x;
          if (
            x.length !== 18 ||
            x.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
          )
            continue;
          const one: LocalModel = {
            version: 1,
            target: r.target,
            updates: 0,
            units: [
              {
                mean: x,
                mass: 1,
                kind: e.y ? (e.kind === "added" ? "add" : "keep") : "remove",
                width: Math.min(1, e.box.width / r.width),
                height: Math.min(1, e.box.height / r.height),
              },
            ],
          };
          model = mergeModels(model, one);
        }
        model.updates = model.units.length ? 1 : 0;
        this.store.importLegacy(r.id, model);
        // Delete only after durable learned weights are saved. Explicitly saved
        // result images and the separate developer export store are untouched.
        await writeLearning(r.id);
      }
      if (records.length)
        this.output.textContent =
          "以前の補正も学習に反映し、学習用画像を削除しました。";
    } catch {
      this.error();
    }
  }
}
