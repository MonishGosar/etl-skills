import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
await readFile(resolve("dist", "mcp.js"), "utf8");
await readFile(resolve("dist", "install-skills.js"), "utf8");
await readFile(resolve("dist", "setup.js"), "utf8");
const releaseRoot = resolve(".release");
const smokeRoot = resolve(releaseRoot, "smoke");
const tarball = resolve(releaseRoot, `${packageJson.name}-${packageJson.version}.tgz`);
assert.ok(smokeRoot.startsWith(`${releaseRoot}${sep}`), "Smoke directory must stay inside .release");
assert.ok(tarball.startsWith(`${releaseRoot}${sep}`), "Tarball must stay inside .release");

const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function startMcp(entry) {
  const child = spawn(process.execPath, [entry, "--read-only"], {
    env: { ...process.env, DATABRICKS_HOST: "", DATABRICKS_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") waiting.get(message.id)?.(message);
  });
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(id, method, params) {
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5_000);
      waiting.set(id, message => {
        clearTimeout(timer);
        waiting.delete(id);
        resolveRequest(message);
      });
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }
  return { child, send, request };
}

await mkdir(releaseRoot, { recursive: true });
await rm(smokeRoot, { recursive: true, force: true });
await rm(tarball, { force: true });

try {
  run(npmCommand, [...npmPrefix, "pack", "--ignore-scripts", "--pack-destination", releaseRoot, "--cache", resolve(".npm-cache")]);
  await mkdir(smokeRoot, { recursive: true });
  run(npmCommand, [...npmPrefix, "install", "--ignore-scripts", "--prefix", smokeRoot, "--cache", resolve(".npm-cache"), tarball]);

  const installedRoot = resolve(smokeRoot, "node_modules", packageJson.name);
  const installedPackage = JSON.parse(await readFile(resolve(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "etl-agent-tools");
  assert.equal(installedPackage.version, "0.2.0-beta.1");
  assert.equal(installedPackage.bin["etl-agent-tools-setup"], "./dist/setup.js");
  await readFile(resolve(installedRoot, "LICENSE"), "utf8");
  await readFile(resolve(installedRoot, "ENVIRONMENT_SETUP.md"), "utf8");

  const mcp = startMcp(resolve(installedRoot, "dist", "mcp.js"));
  try {
    const initialized = await mcp.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "packed-install-test", version: "1.0.0" },
    });
    assert.equal(initialized.error, undefined);
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await mcp.request(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ["etl_capabilities", "etl_inspect", "etl_query_status"]);
  } finally {
    mcp.child.kill();
  }

  const skillsTarget = resolve(smokeRoot, "installed-skills");
  run(process.execPath, [resolve(installedRoot, "dist", "install-skills.js"), "--target", skillsTarget]);
  await readFile(resolve(skillsTarget, "setup-etl-workspace", "SKILL.md"), "utf8");

  const setupTarget = resolve(smokeRoot, "setup-project");
  run(process.execPath, [resolve(installedRoot, "dist", "setup.js"), "--harness", "codex", "--target", setupTarget]);
  await readFile(resolve(setupTarget, ".codex", "config.toml"), "utf8");
  await readFile(resolve(setupTarget, ".agents", "skills", "setup-etl-workspace", "SKILL.md"), "utf8");

  process.stdout.write(`Packed install verified: ${tarball}\n`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
