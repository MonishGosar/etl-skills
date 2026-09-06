import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const packageRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(packageRoot, "dist");
const entries = ["client", "core", "databricks-adapter", "mcp", "install-skills"];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const entry of entries) {
  const source = await readFile(resolve(packageRoot, "src", `${entry}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: `${entry}.ts`,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      newLine: ts.NewLineKind.LineFeed,
    },
    reportDiagnostics: true,
  });
  const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => packageRoot,
      getNewLine: () => "\n",
    }));
  }
  const shebang = entry === "mcp" || entry === "install-skills" ? "#!/usr/bin/env node\n" : "";
  await writeFile(resolve(outputRoot, `${entry}.js`), `${shebang}${compiled.outputText}`, "utf8");
}
