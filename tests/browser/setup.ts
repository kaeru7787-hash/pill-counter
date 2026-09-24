import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
export default async function setup() {
  const root = resolve("dist"),
    mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".wasm": "application/wasm",
    };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      const relative =
        url.pathname.replace(/^\/pill-counter\//, "") || "index.html";
      const file = resolve(root, relative);
      if (!file.startsWith(root + sep)) throw new Error("invalid path");
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.on("error", reject);
    server.listen(4173, "127.0.0.1", done);
  });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
}
