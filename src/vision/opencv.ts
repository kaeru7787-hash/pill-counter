import cvModule from "@techstark/opencv-js";
export type CV = typeof cvModule;
let ready: Promise<{ cv: CV }> | undefined;
export function getCV(): Promise<{ cv: CV }> {
  // Emscripten may expose a self-resolving thenable; always wrap the module.
  ready ??= new Promise((resolve, reject) => {
    const module = cvModule as CV & {
      onRuntimeInitialized?: () => void;
      onAbort?: (reason: string) => void;
    };
    if (typeof module.Mat === "function") resolve({ cv: module });
    else if (cvModule instanceof Promise)
      cvModule.then((cv) => resolve({ cv })).catch(reject);
    else {
      module.onRuntimeInitialized = () => resolve({ cv: module });
      module.onAbort = (reason) => reject(new Error(reason));
    }
  });
  return ready;
}
