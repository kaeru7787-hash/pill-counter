import { analyzeHybrid } from "../vision/hybrid";
import type { WorkerRequest, WorkerResponse } from "../types";
import { applyLearning } from "../autoLearning";
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, image, settings, baseURL } = event.data;
  try {
    const result = applyLearning(
      image,
      await analyzeHybrid(image, settings, baseURL),
      event.data.learningModel,
    );
    self.postMessage({ id, result } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};
