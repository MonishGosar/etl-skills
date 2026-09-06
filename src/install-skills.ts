import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage(): never {
  process.stderr.write("Usage: etl-agent-tools-install-skills [--target PATH] [--force]\n");
  process.exit(2);
}

const args = process.argv.slice(2);
let target = resolve(process.cwd(), ".agents", "skills");
let force = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--force") force = true;
  else if (args[index] === "--target" && args[index + 1]) target = resolve(args[++index]);
  else usage();
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "skills");
const entries = (await readdir(source)).sort();
await mkdir(target, { recursive: true });

for (const name of entries) {
  const from = resolve(source, name);
  if (!(await stat(from)).isDirectory()) continue;
  const to = resolve(target, name);
  await cp(from, to, { recursive: true, force, errorOnExist: !force });
  process.stdout.write(`Installed ${name} -> ${to}\n`);
}
