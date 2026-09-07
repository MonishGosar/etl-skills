#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
const choices = [
    { key: "1", harness: "codex", label: "Codex" },
    { key: "2", harness: "claude", label: "Claude Code" },
    { key: "3", harness: "deepseek", label: "DeepSeek Harness" },
    { key: "4", harness: "pi", label: "Pi" },
    { key: "5", harness: "all", label: "All supported harnesses" },
];
const codexConfig = `[mcp_servers.etl]
command = "etl-agent-tools-mcp"
args = ["--read-only"]
env_vars = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID", "DATABRICKS_CATALOG", "DATABRICKS_SCHEMA"]
`;
const claudeServer = {
    command: "etl-agent-tools-mcp",
    args: ["--read-only"],
    env: {
        DATABRICKS_HOST: "${DATABRICKS_HOST:-}",
        DATABRICKS_TOKEN: "${DATABRICKS_TOKEN:-}",
        DATABRICKS_WAREHOUSE_ID: "${DATABRICKS_WAREHOUSE_ID:-}",
        DATABRICKS_CATALOG: "${DATABRICKS_CATALOG:-}",
        DATABRICKS_SCHEMA: "${DATABRICKS_SCHEMA:-}",
    },
};
const deepseekConfig = `# Add this patch to your DeepSeek Harness Cordis configuration.
- insert:
    - id: etl-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: etl
        transport: stdio
        command: etl-agent-tools-mcp
        args: ['--read-only']
        cwd: !!js process.cwd()
        env:
          DATABRICKS_HOST: !!js process.env.DATABRICKS_HOST
          DATABRICKS_TOKEN: !!js process.env.DATABRICKS_TOKEN
          DATABRICKS_WAREHOUSE_ID: !!js process.env.DATABRICKS_WAREHOUSE_ID
          DATABRICKS_CATALOG: !!js process.env.DATABRICKS_CATALOG
          DATABRICKS_SCHEMA: !!js process.env.DATABRICKS_SCHEMA
`;
function usage() {
    process.stderr.write("Usage: etl-agent-tools-setup [--harness codex|claude|deepseek|pi|all] [--target PATH] [--force]\n");
    process.exit(2);
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
async function installSkills(packageRoot, target, force) {
    const source = resolve(packageRoot, "skills");
    await mkdir(target, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
        const from = resolve(source, name);
        if (!(await stat(from)).isDirectory())
            continue;
        const to = resolve(target, name);
        if (await exists(to) && !force)
            continue;
        await cp(from, to, { recursive: true, force, errorOnExist: !force });
    }
}
async function configureCodex(projectRoot, force) {
    const path = resolve(projectRoot, ".codex", "config.toml");
    await mkdir(resolve(projectRoot, ".codex"), { recursive: true });
    const current = await exists(path) ? await readFile(path, "utf8") : "";
    if (current.includes("[mcp_servers.etl]")) {
        if (!force)
            return "kept existing .codex/config.toml ETL server";
        throw new Error("Cannot safely replace an existing [mcp_servers.etl] table. Edit it manually or remove that table first.");
    }
    await writeFile(path, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${codexConfig}`, "utf8");
    return "configured .codex/config.toml";
}
async function configureClaude(projectRoot, force) {
    const path = resolve(projectRoot, ".mcp.json");
    const current = await exists(path) ? JSON.parse(await readFile(path, "utf8")) : {};
    current.mcpServers ??= {};
    if (current.mcpServers.etl && !force)
        return "kept existing .mcp.json ETL server";
    current.mcpServers.etl = claudeServer;
    await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return "configured .mcp.json";
}
async function configureDeepSeek(projectRoot, force) {
    const directory = resolve(projectRoot, ".etl-agent");
    const path = resolve(directory, "deepseek.cordis.yml");
    await mkdir(directory, { recursive: true });
    if (await exists(path) && !force)
        return "kept existing .etl-agent/deepseek.cordis.yml";
    await writeFile(path, deepseekConfig, "utf8");
    return "created .etl-agent/deepseek.cordis.yml";
}
const args = process.argv.slice(2);
let harness;
let projectRoot = process.cwd();
let force = false;
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--force")
        force = true;
    else if (args[index] === "--harness" && args[index + 1])
        harness = args[++index];
    else if (args[index] === "--target" && args[index + 1])
        projectRoot = resolve(args[++index]);
    else
        usage();
}
if (harness && !choices.some(choice => choice.harness === harness))
    usage();
if (!harness) {
    if (!process.stdin.isTTY)
        usage();
    process.stdout.write("\nETL Agent Tools setup\n\nChoose your coding harness:\n");
    for (const choice of choices)
        process.stdout.write(`  ${choice.key}. ${choice.label}\n`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question("\nHarness [1-5]: ")).trim();
    prompt.close();
    harness = choices.find(choice => choice.key === answer)?.harness;
    if (!harness)
        usage();
}
const packageRoot = resolve(import.meta.dirname, "..");
await mkdir(projectRoot, { recursive: true });
const selected = harness === "all" ? ["codex", "claude", "deepseek", "pi"] : [harness];
const changes = [];
if (selected.includes("codex") || selected.includes("deepseek")) {
    await installSkills(packageRoot, resolve(projectRoot, ".agents", "skills"), force);
    changes.push("installed shared skills in .agents/skills");
}
if (selected.includes("codex")) {
    changes.push(await configureCodex(projectRoot, force));
}
if (selected.includes("claude")) {
    await installSkills(packageRoot, resolve(projectRoot, ".claude", "skills"), force);
    changes.push("installed shared skills in .claude/skills", await configureClaude(projectRoot, force));
}
if (selected.includes("deepseek")) {
    await installSkills(packageRoot, resolve(projectRoot, ".agents", "skills"), force);
    changes.push("installed shared skills in .agents/skills", await configureDeepSeek(projectRoot, force));
}
if (selected.includes("pi"))
    changes.push("prepared the workspace profile for Pi");
const profileDirectory = resolve(projectRoot, ".etl-agent");
await mkdir(profileDirectory, { recursive: true });
await writeFile(resolve(profileDirectory, "project.md"), `# ETL workspace\n\n- Provider: Databricks\n- Access mode: read-only MCP${selected.includes("pi") ? "; guarded mutations in interactive Pi" : ""}\n- Environment: set by the launching shell\n- Required variables: DATABRICKS_HOST, DATABRICKS_TOKEN\n- Optional variables: DATABRICKS_WAREHOUSE_ID, DATABRICKS_CATALOG, DATABRICKS_SCHEMA\n`, "utf8");
process.stdout.write(`\nSetup complete for ${harness}.\n`);
for (const change of [...new Set(changes)])
    process.stdout.write(`  ✓ ${change}\n`);
process.stdout.write(`  ✓ created .etl-agent/project.md without secret values\n\n`);
process.stdout.write("Before starting the harness, set:\n  DATABRICKS_HOST      workspace HTTPS origin\n  DATABRICKS_TOKEN     short-lived access token (secret)\n\nOptional:\n  DATABRICKS_WAREHOUSE_ID, DATABRICKS_CATALOG, DATABRICKS_SCHEMA\n\n");
process.stdout.write("Get the values: https://github.com/MonishGosar/etl-skills/blob/main/ENVIRONMENT_SETUP.md\n");
if (selected.includes("codex"))
    process.stdout.write("Verify Codex: codex mcp list\n");
if (selected.includes("claude"))
    process.stdout.write("Verify Claude Code: start claude, then run /mcp\n");
if (selected.includes("deepseek"))
    process.stdout.write("DeepSeek: merge .etl-agent/deepseek.cordis.yml into the active Cordis patch, then start the harness\n");
if (selected.includes("pi"))
    process.stdout.write("Install for Pi once: pi install npm:etl-agent-tools@0.2.0-beta.1\nThen start Pi: pi\n");
