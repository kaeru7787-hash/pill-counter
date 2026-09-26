import {
  emptyModel,
  mergeModels,
  validModel,
  type LocalModel,
} from "./autoLearning";
import type { Target } from "./learning";

export const MODEL_KEY = "pill-auto-learning-v1:";
type Stored = {
  version: 1;
  base: LocalModel;
  recent?: { id: string; model: LocalModel; complete: boolean };
  migrated?: string[];
};
export class AutoLearningStore {
  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {}
  private read(target: Target): Stored {
    const json = this.storage.getItem(MODEL_KEY + target);
    if (!json) return { version: 1, base: emptyModel(target) };
    const s = JSON.parse(json) as Stored;
    if (
      s.version !== 1 ||
      !validModel(s.base) ||
      s.base.target !== target ||
      (s.recent &&
        (!validModel(s.recent.model) ||
          s.recent.model.target !== target ||
          typeof s.recent.id !== "string" ||
          typeof s.recent.complete !== "boolean"))
    )
      throw Error("学習情報を読み込めません");
    return s;
  }
  private write(target: Target, s: Stored) {
    this.storage.setItem(MODEL_KEY + target, JSON.stringify(s));
  }
  stage(id: string, model: LocalModel) {
    const s = this.read(model.target);
    if (s.recent?.id !== id) {
      if (s.recent) s.base = mergeModels(s.base, s.recent.model);
      s.recent = { id, model, complete: false };
    } else s.recent = { id, model, complete: false };
    this.write(model.target, s);
  }
  finish(target: Target, id?: string) {
    const s = this.read(target);
    if (s.recent && (!id || s.recent.id === id) && !s.recent.complete) {
      s.recent.complete = true;
      this.write(target, s);
    }
  }
  recover() {
    this.finish("pill");
    this.finish("bottle");
  }
  model(target: Target) {
    const s = this.read(target);
    return s.recent?.complete ? mergeModels(s.base, s.recent.model) : s.base;
  }
  // Import already-trained old feedback once, then the caller can delete its
  // image/annotation records. The receipt makes retry after a crash idempotent.
  importLegacy(id: string, model: LocalModel) {
    const s = this.read(model.target);
    if (s.migrated?.includes(id)) return;
    s.base = mergeModels(s.base, model);
    s.migrated = [...(s.migrated || []), id];
    this.write(model.target, s);
  }
}
