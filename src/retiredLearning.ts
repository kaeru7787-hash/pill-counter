/** Remove only data owned by the retired on-device learning feature.
 * Run on every launch so blocked deletions and data recreated by an old tab
 * are retried. Never gate inference or wipe saved results/model caches. */
export async function removeLegacyLearning(): Promise<void> {
  for (const target of ["pill", "bottle"]) {
    try {
      localStorage.removeItem(`pill-auto-learning-v1:${target}`);
    } catch {
      // Storage may be disabled. Inference no longer reads these keys.
    }
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase("pill-counter-learning");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
