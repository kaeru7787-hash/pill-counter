import ts from "typescript";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const entry = process.argv[2];
if (!entry) throw new Error("Missing TypeScript entry");
mkdirSync(".runtime", { recursive: true });
function compile(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) compile(path);
    else if (path.endsWith(".ts")) {
      const out = `.runtime/${path.replace(/\.ts$/, ".js")}`;
      mkdirSync(dirname(out), { recursive: true });
      const source = readFileSync(path, "utf8").replace(
        /from (['"])(\.[^'"]+)\1/g,
        (_, q, p) => `from ${q}${p.replace(/\.ts$/, "")}.js${q}`,
      );
      writeFileSync(
        out,
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
          },
        }).outputText,
      );
    }
  }
}
for (const dir of ["src", "scripts", "tests"]) compile(dir);
const outfile = `.runtime/${entry.replace(/\.ts$/, ".js")}`;
const result = spawnSync(
  process.execPath,
  [...(process.argv.includes("--test") ? ["--test"] : []), outfile],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
