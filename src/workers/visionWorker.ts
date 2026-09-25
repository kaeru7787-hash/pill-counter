import { analyzeHybrid } from "../vision/hybrid";
import type { WorkerRequest, WorkerResponse } from "../types";
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, image, settings, baseURL } = event.data;
  try {
    const result = await analyzeHybrid(image, settings, baseURL);
    self.postMessage({ id, result } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};
