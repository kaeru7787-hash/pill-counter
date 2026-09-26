import { train, type LearningRecord, type Target } from "../learning";
self.onmessage = (
  event: MessageEvent<{ records: LearningRecord[]; target: Target }>,
) => {
  try {
    self.postMessage(train(event.data.records, event.data.target));
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
