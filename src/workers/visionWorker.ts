import { analyze } from "../vision/pipeline";
import { detectAI } from "../ai/onnxDetector";
import { confidence, spatialAgreement } from "../vision/ensemble";
import type { WorkerRequest, WorkerResponse } from "../types";
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, image, settings, baseURL } = event.data;
  try {
    const result = await analyze(image, settings),
      ai = await detectAI(image, result.roi, baseURL);
    result.aiStatus = ai.status;
    if (ai.detections) {
      result.counts.AI = ai.detections.length;
      const issues =
        result.confidence.level === "review" ? result.confidence.reasons : [];
      result.confidence = confidence(
        result.counts,
        1,
        issues,
        spatialAgreement(result.detections, ai.detections),
      );
    } else if (ai.failed) {
      result.confidence = {
        level: "review",
        reasons: [...result.confidence.reasons, ai.status],
      };
    }
    self.postMessage({ id, result } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};
