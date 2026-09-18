import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = path.join(ROOT, "mcp-tool-catalog.json");

// Live inventory from docs/MCP-TOOL-NAMING-AUDIT.md (PR #228), verified
// against https://www.getdasha.com/compute/mcp.json 2026-09-18.
// The backfill is NON-BREAKING: names must match this inventory exactly.
const INVENTORY_NAMES = ["healthz", "models", "network", "guest-keys", "chat.completions"];

// R5 (tool-search era) keyword coverage from the audit, per tool.
// Each tool's description must contain at least one keyword from each group.
const KEYWORD_GROUPS = {
  "healthz": [
    ["dasha", "coordinator"],
    ["mac", "inference", "llm"],
  ],
  "models": [
    ["dasha", "mac", "inference"],
    ["llm", "model"],
    ["qwen", "gemma", "gpt-oss"],
  ],
  "network": [
    ["dasha", "mac", "community"],
    ["inference", "capacity", "availability", "provider"],
  ],
  "guest-keys": [
    ["api key", "key"],
    ["auth", "mint", "guest"],
  ],
  "chat.completions": [
    ["dasha", "mac", "openai"],
    ["inference", "chat completion"],
    ["qwen", "gemma", "gpt-oss"],
  ],
};

const MODEL_IDS = ["qwen3-8b", "gemma3-12b", "gpt-oss-20b", "qwen3-30b-a3b", "gemma3-27b", "gpt-oss-120b"];

function lower(s) {
  return String(s).toLowerCase();
}

const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8"));

test("catalog has exactly the five inventoried tools", () => {
  assert.equal(catalog.revision, "2026-07-28");
  assert.ok(Array.isArray(catalog.tools));
  assert.equal(catalog.tools.length, 5, "exactly five tools");
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    INVENTORY_NAMES,
    "tool names are unchanged from the live inventory (non-breaking)"
  );
});

test("every tool carries a 2026-07-28 title (V4)", () => {
  for (const tool of catalog.tools) {
    assert.equal(typeof tool.title, "string", `${tool.name}: title is a string`);
    assert.ok(tool.title.trim().length > 0, `${tool.name}: title is non-empty`);
    assert.notEqual(tool.title, tool.name, `${tool.name}: title differs from name`);
    assert.ok(
      tool.title.length <= 128,
      `${tool.name}: title within MCP human-readable display bounds`
    );
  }
});

test("descriptions are keyword-rich per the audit (V5)", () => {
  for (const tool of catalog.tools) {
    const desc = lower(tool.description);
    assert.ok(desc.length >= 40, `${tool.name}: description is substantive`);
    for (const group of KEYWORD_GROUPS[tool.name]) {
      const hit = group.some((kw) => desc.includes(kw));
      assert.ok(
        hit,
        `${tool.name}: description missing keyword coverage for [${group.join(" | ")}]`
      );
    }
  }
});

test("models and chat completions name the public model ids", () => {
  for (const name of ["models", "chat.completions"]) {
    const tool = catalog.tools.find((t) => t.name === name);
    const desc = lower(tool.description);
    const mentioned = MODEL_IDS.filter((id) => desc.includes(id));
    assert.ok(
      mentioned.length >= 3,
      `${name}: description names public model ids (found: ${mentioned.join(", ")})`
    );
  }
});

test("catalog entries stay within MCP naming constraints", () => {
  const seen = new Set();
  for (const tool of catalog.tools) {
    // Names are legacy and unchanged; still verify uniqueness and R1 charset.
    assert.ok(/^[A-Za-z0-9_\-.]{1,128}$/.test(tool.name), `${tool.name}: R1 charset`);
    assert.ok(!seen.has(tool.name), `${tool.name}: unique within server`);
    seen.add(tool.name);
    assert.ok(tool.method && tool.url, `${tool.name}: carries method + url`);
  }
});
