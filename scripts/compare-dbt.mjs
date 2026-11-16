import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { DbtAdapter } from "../dist/dbt-adapter.js";

const { values } = parseArgs({ options: {
  current: { type: "string" }, baseline: { type: "string" }, node: { type: "string" }, output: { type: "string" },
} });
if (!values.current || !values.baseline) throw new Error("Pass --current and --baseline artifact directories.");
const result = await new DbtAdapter(values.current).compareRuns(values.baseline, values.node);
const json = JSON.stringify(result, null, 2) + "\n";
if (values.output) await writeFile(values.output, json);
else process.stdout.write(json);
