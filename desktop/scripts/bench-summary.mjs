// Turns the camera speed test's JSON into a Markdown table (for the CI run summary) and fails
// if any model's answer differs from its official pipeline's answer on the same picture.
// Usage: node bench-summary.mjs bench.jsonl
import { appendFileSync, readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
});
const error = lines.find((l) => l?.type === "error");
const r = lines.find((l) => l?.type === "result");
if (!r) {
  console.error(`No result from the speed test${error ? `: ${error.message}` : ""}`);
  process.exit(1);
}

const TARGET_MS = 60; // camera plan, step 1: a full check under 60 ms on a CPU-only machine
const engines = [["cpu1", "1 core"], ["cpu", "All cores"], ["gpu", "GPU"], ["gpu-low", "GPU (power saving)"]].filter(([k]) =>
  r.models.some((m) => m.engines[k]),
);
const cell = (t) => (!t ? "" : t.error ? `failed: ${t.error.slice(0, 60)}` : `${t.ms.toFixed(1)} ms (CPU ${t.cpu_ms.toFixed(0)})${t.agrees === false ? " DIFFERENT ANSWER" : ""}`);

const out = [];
out.push(`### Camera speed test: ${r.machine.cpu}, ${r.machine.threads} threads`);
out.push(`Graphics: ${r.machine.gpus.join(", ") || "none listed"}. Picture: ${r.frame.source} ${r.frame.width}x${r.frame.height}. ${r.runs} timed runs each, median shown, CPU time per run in brackets.`);
out.push("");
out.push(`| Model | Input | MB | ${engines.map(([, n]) => n).join(" | ")} | Matches official pipeline |`);
out.push(`|---|---|---|${engines.map(() => "---").join("|")}|---|`);
const failures = [];
for (const m of r.models) {
  let ref = "not compared";
  if (m.reference) {
    if ("matched" in m.reference) {
      ref = `${m.reference.matched} of ${m.reference.total}`;
      if (m.reference.matched < m.reference.total || m.reference.total === 0) failures.push(`${m.id} missed ${JSON.stringify(m.reference.missed)}`);
    } else {
      ref = m.reference.ok ? `yes (worst point ${(m.reference.worst_share_of_height * 100).toFixed(1)}% of height)` : "NO";
      if (!m.reference.ok) failures.push(`${m.id} keypoints off by ${(m.reference.worst_share_of_height * 100).toFixed(1)}% of height`);
    }
  }
  out.push(`| ${m.label} | ${m.width}x${m.height} | ${m.mb} | ${engines.map(([k]) => cell(m.engines[k])).join(" | ")} | ${ref} |`);
}
out.push("");
out.push(`#### Full check: whole frame + hands crop + pose (target under ${TARGET_MS} ms on all CPU cores)`);
out.push(`| Check | ${engines.map(([, n]) => n).join(" | ")} | Target |`);
out.push(`|---|${engines.map(() => "---").join("|")}|---|`);
for (const c of r.checks) {
  const cpu = c.engines.cpu?.ms;
  const verdict = cpu == null ? "not run" : cpu < TARGET_MS ? `PASS (${cpu} ms)` : `MISS (${cpu} ms)`;
  out.push(`| ${c.name} | ${engines.map(([k]) => (c.engines[k] ? `${c.engines[k].ms} ms (CPU ${c.engines[k].cpu_ms})` : "")).join(" | ")} | ${verdict} |`);
}
const people = r.models.filter((m) => m.found?.length).map((m) => `${m.label} ${m.width}: ${m.found.slice(0, 4).map((d) => `${d.cls} ${Math.round(d.score * 100)}%`).join(", ")}`);
out.push("");
out.push("What each detector found: " + people.join("; "));

const md = out.join("\n") + "\n";
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
if (failures.length) {
  console.error(`Answers differ from the official pipelines:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
