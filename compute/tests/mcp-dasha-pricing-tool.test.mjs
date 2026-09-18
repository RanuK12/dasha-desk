// MCP `dasha_pricing` tool payload checks (PR: V6 top candidate proposal).
//
// The payload at ../mcp-dasha-pricing-tool.json is the Worker-ready new-tool
// entry. This suite asserts it satisfies the audit's naming rules (R1–R5 from
// docs/MCP-TOOL-NAMING-AUDIT.md, PR #228), is additive and non-breaking
// (it does not rename any of the five live tools), and that the rate card,
// formula, and worked examples in docs/MCP-DASHA-PRICING-TOOL-PROPOSAL.md
// are internally consistent.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAYLOAD_PATH = path.join(ROOT, "mcp-dasha-pricing-tool.json");
const DOC_PATH = path.join(ROOT, "..", "docs", "MCP-DASHA-PRICING-TOOL-PROPOSAL.md");

const payload = JSON.parse(await readFile(PAYLOAD_PATH, "utf8"));
const tool = payload.tool;

// The five live tools from the audit inventory (PR #228), verified live
// 2026-09-18. dasha_pricing must not collide with or rename any of them.
const LIVE_INVENTORY = ["healthz", "models", "network", "guest-keys", "chat.completions"];

// Standing rate card (USD). Kept in one place; the doc's worked examples and
// this suite's math helper both derive from it.
const RATE = { perJob: 0.05, per1kCompletion: 0.01 };

function quote({ completionTokens = 0, jobCount = 1 } = {}) {
  const perJobTokenFee = (completionTokens / 1000) * RATE.per1kCompletion;
  const perJobTotal = RATE.perJob + perJobTokenFee;
  return {
    jobFee: RATE.perJob,
    tokenFee: perJobTokenFee,
    perJobTotal,
    total: Math.round(perJobTotal * jobCount * 100) / 100,
  };
}

function lower(s) {
  return String(s).toLowerCase();
}

test("payload targets the 2026-07-28 revision", () => {
  assert.equal(payload.revision, "2026-07-28");
  assert.ok(payload.tool, "payload carries the tool entry");
});

test("name satisfies the audit rules (R1–R3) and is new", () => {
  assert.equal(tool.name, "dasha_pricing");
  // R1: charset, 1–128 chars. R3 (client-compat): dot-free snake_case ≤ 64.
  assert.ok(/^[a-z][a-z0-9_]{0,63}$/.test(tool.name), `${tool.name}: R1/R3 naming`);
  assert.ok(tool.name.length <= 64, `${tool.name}: within the 64-char client limit`);
  // R2: service context prefix so it stays unambiguous in merged tool lists.
  assert.ok(tool.name.startsWith("dasha_"), `${tool.name}: R2 dasha_ prefix`);
  // Additive: not one of the five live tools; no live name is renamed here.
  assert.ok(!LIVE_INVENTORY.includes(tool.name), "name is new, not a rename");
});

test("title is present and human-readable (V4/R4)", () => {
  assert.equal(typeof tool.title, "string");
  assert.ok(tool.title.trim().length > 0, "title is non-empty");
  assert.notEqual(tool.title, tool.name, "title differs from the raw name");
  assert.ok(tool.title.length <= 128, "title within display bounds");
});

test("description is keyword-rich per the audit (V5/R5)", () => {
  const desc = lower(tool.description);
  assert.ok(desc.length >= 40, "description is substantive");
  const groups = [
    ["dasha", "mac", "inference"],
    ["pricing", "price", "cost", "rate"],
    ["llm", "job", "token", "chat completion"],
    ["qwen", "gemma", "gpt-oss"],
  ];
  for (const group of groups) {
    const hit = group.some((kw) => desc.includes(kw));
    assert.ok(hit, `description missing keyword coverage for [${group.join(" | ")}]`);
  }
  // States the standing card and the read-only, never-bills promise.
  assert.ok(desc.includes("0.05"), "description states the per-job fee");
  assert.ok(desc.includes("0.01"), "description states the per-1k-token fee");
  assert.ok(desc.includes("read-only") || desc.includes("never bills"), "read-only promise");
});

test("input schema takes model, tokens in/out, job count — all optional", () => {
  const s = payload.inputSchema;
  assert.equal(s.type, "object");
  const props = s.properties;
  for (const p of ["model", "input_tokens", "completion_tokens", "job_count"]) {
    assert.ok(props[p], `input schema has ${p}`);
  }
  assert.ok(!s.required || s.required.length === 0, "no required inputs (bare call = rate card)");
  assert.equal(props.job_count.minimum, 1, "job_count >= 1");
  assert.equal(props.input_tokens.minimum, 0, "input_tokens >= 0");
  assert.equal(props.completion_tokens.minimum, 0, "completion_tokens >= 0");
});

test("output schema returns the rate card plus a per-job breakdown", () => {
  const s = payload.outputSchema;
  assert.ok(s.properties.rate_card, "output has rate_card");
  assert.ok(s.properties.estimate, "output has estimate");
  const card = payload.rate_card;
  assert.equal(card.per_job_usd, RATE.perJob, "standing card per-job fee");
  assert.equal(card.per_1k_completion_tokens_usd, RATE.per1kCompletion, "standing card token fee");
  assert.equal(card.currency, "USD");
});

test("endpoint is read-only GET, unauthenticated (audit V6 risk rating)", () => {
  assert.equal(tool.method, "GET");
  assert.ok(tool.url.endsWith("/compute/api/pricing"), "pricing endpoint URL");
  assert.equal(tool.auth, "none");
});

test("worked examples in the proposal match the rate card", () => {
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  // Example 1: one job, 500 in / 300 out -> 0.05 + 0.3*0.01 = $0.053 per job.
  const ex1 = quote({ completionTokens: 300, jobCount: 1 });
  assert.ok(approx(ex1.perJobTotal, 0.053), "ex1: per-job $0.053");
  // Example 2: 100 jobs, 2000 in / 500 out -> $0.055 per job, $5.50 total.
  const ex2 = quote({ completionTokens: 500, jobCount: 100 });
  assert.ok(approx(ex2.perJobTotal, 0.055), "ex2: per-job $0.055");
  assert.equal(ex2.total, 5.5, "ex2: 100 jobs = $5.50");
  // Bare call returns the card with no estimate — nothing to compute.
  const bare = quote();
  assert.equal(bare.perJobTotal, 0.05);
});

test("proposal doc states the open rate-card question without resolving it", async () => {
  const doc = await readFile(DOC_PATH, "utf8");
  const d = lower(doc);
  // The dasha-local 0.06 / 0.012 discrepancy is flagged as John's call…
  assert.ok(d.includes("0.06") && d.includes("0.012"), "doc names the dasha-local numbers");
  assert.ok(d.includes("john"), "doc routes the decision to John");
  // …and the payload does NOT carry them (standing card only).
  assert.ok(!JSON.stringify(payload).includes("0.06"), "payload keeps the standing card");
});
