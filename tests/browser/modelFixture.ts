// Minimal constant-output ONNX model for runtime plumbing tests only. Not a pill model.
const v = (n: number): number[] => {
  const a = [];
  do {
    const b = n & 127;
    n = Math.floor(n / 128);
    a.push(b | (n ? 128 : 0));
  } while (n);
  return a;
};
const field = (n: number, value: number | number[] | string): number[] =>
  typeof value === "number"
    ? [...v(n * 8), ...v(value)]
    : (() => {
        const b =
          typeof value === "string"
            ? [...new TextEncoder().encode(value)]
            : value;
        return [...v(n * 8 + 2), ...v(b.length), ...b];
      })();
const message = (...parts: number[][]) => parts.flat();
const valueInfo = (name: string, shape: number[]) =>
  message(
    field(1, name),
    field(
      2,
      field(
        1,
        message(
          field(1, 1),
          field(
            2,
            shape.flatMap((d) => field(1, field(1, d))),
          ),
        ),
      ),
    ),
  );
export function constantModel() {
  const floats = new Float32Array([320, 320, 40, 40, 0.95]);
  const tensor = message(
    ...[1, 5, 1].map((d) => field(1, d)),
    field(2, 1),
    field(9, [...new Uint8Array(floats.buffer)]),
  );
  const attr = message(field(1, "value"), field(20, 4), field(5, tensor));
  const node = message(
    field(2, "output"),
    field(4, "Constant"),
    field(5, attr),
  );
  const graph = message(
    field(1, node),
    field(2, "test-only"),
    field(11, valueInfo("images", [1, 3, 640, 640])),
    field(12, valueInfo("output", [1, 5, 1])),
  );
  return Buffer.from(
    message(field(1, 8), field(7, graph), field(8, field(2, 13))),
  );
}
