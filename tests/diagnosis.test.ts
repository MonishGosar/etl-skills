import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, suggestedNextStep } from "../src/diagnosis.ts";
import { scrubSecrets } from "../src/redact.ts";

test("classifier maps warehouse, test, compile, and dependency failures", () => {
  assert.equal(classifyFailure({ message: "Compilation Error in model orders\n  'dbt_utils' is undefined", status: "error" }).category, "compilation");
  assert.equal(classifyFailure({ message: "Database Error in model orders\n  SQL compilation error", status: "error" }).category, "database");
  assert.equal(classifyFailure({ message: "Object 'RAW.ORDERS' does not exist or not authorized.", status: "error" }).confidence, "medium");
  assert.equal(classifyFailure({ message: "Got 4 results, configured to fail if != 0", status: "fail", resourceType: "test" }).category, "test_failure");
  assert.equal(classifyFailure({ message: "", status: "upstream_failed" }).category, "dependency");
  assert.equal(classifyFailure({ message: "permission denied for schema analytics", status: "error" }).category, "permission");
  assert.equal(classifyFailure({ message: "canceling statement due to statement timeout", status: "error" }).category, "timeout");
  assert.equal(classifyFailure({ message: "Worker was OOMKilled", status: "failed" }).category, "resource");
  assert.equal(classifyFailure({ message: "could not connect to host warehouse.internal", status: "error" }).category, "configuration");
  assert.equal(classifyFailure({ message: "something unexpected", status: "error" }).category, "unknown");
  assert.match(suggestedNextStep("dependency"), /upstream/i);
});

test("scrubber removes credential-shaped text and leaves the error", () => {
  const scrubbed = scrubSecrets([
    "Database Error in model orders",
    "password=super-secret-token",
    "Authorization: Bearer super-secret-token",
    "postgres://analyst:super-secret-token@warehouse.example/db",
    "aws=AKIAIOSFODNN7EXAMPLE",
    "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ].join("\n"), ["super-secret-token"]);
  assert.match(scrubbed, /Database Error in model orders/);
  assert.doesNotMatch(scrubbed, /super-secret-token/);
  assert.doesNotMatch(scrubbed, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(scrubbed, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.match(scrubbed, /\[REDACTED]/);
});
