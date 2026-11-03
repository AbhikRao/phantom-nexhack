/**
 * verificationReport — a portable, self-contained record of what was actually verified for one generated build.
 * Built only from data PHANTOM really holds (the build manifest, the contract the build was generated from, and the parity
 * runs that were executed). Nothing here is estimated: a build nobody verified yields a report that says so.
 * Rendered as structured JSON plus a standalone HTML page (inline CSS, no scripts, no network) for judges and reviewers.
 */
import { createHash } from 'node:crypto';
import type { BuildInfo } from './backendGenerator.ts';
import { inferContract } from './contractInference.ts';
import type { InferredContract } from './contractInference.ts';
import type { ParityReport } from './parityVerifier.ts';
import { NORMALIZATION_RULES, NOT_COVERED } from './parityVerifier.ts';
import type { TraceEvent } from './traceRecorder.ts';

export const REPORT_SCHEMA = 'phantom.verification-report/1';

export interface RunSummary {
  id: string;
  kind: 'replay' | 'fuzz';
  startedAt: string;
  durationMs: number;
  seed: number | null;
  steps: number | null;
  sabotaged: string | null;
  total: number;
  passed: number;
  failed: number;
  verdict: 'all checks match' | 'differences found';
  operations: { operation: string; checks: number; failed: number }[];
  mismatches: { n: number; label: string; request: string; requestBody?: unknown; emulatorStatus: number; generatedStatus: number; diffs: { path: string; emulator: unknown; generated: unknown }[] }[];
  reproduce?: string;
}

export interface VerificationReport {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  build: { id: string; createdAt: string; resources: string[]; trainedOnRequests: number; files: number; manifest: { path: string; sha256: string }[] };
  contract: { fingerprint: string; fingerprintInputs: string; resources: { name: string; fields: Record<string, string>; required: string[]; operations: string[] }[] };
  verification: {
    status: 'not verified' | 'verified, all runs match' | 'differences found';
    note: string;
    runs: RunSummary[];
    /** Sabotaged-build runs prove the check can fail; they never count toward the build's own verdict. */
    detectionTests: RunSummary[];
  };
  normalization: string[];
  limitations: string[];
  howToReproduce: string[];
}

/** Stable fingerprint of the contract's structure (types, required fields, observed operations), ignoring timestamps and counts. */
export function contractFingerprint(contract: InferredContract): { fingerprint: string; canonical: string } {
  const stable = contract.resources.map((r) => ({
    name: r.name,
    fields: Object.fromEntries(Object.entries(r.fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v.types].sort()])),
    required: [...r.required].sort(),
    operations: r.operations.map((o) => `${o.method} ${o.route}`).sort(),
  }));
  const canonical = JSON.stringify(stable);
  return { fingerprint: createHash('sha256').update(canonical).digest('hex'), canonical };
}

function summarize(r: ParityReport): RunSummary {
  const ops = new Map<string, { checks: number; failed: number }>();
  for (const c of r.cases) {
    const key = c.source === 'final-state' ? `final state of ${c.emulatorPath}` : c.source === 'synthetic' ? c.label : c.label;
    const o = ops.get(key) ?? { checks: 0, failed: 0 };
    o.checks++;
    if (!c.pass) o.failed++;
    ops.set(key, o);
  }
  return {
    id: r.id,
    kind: r.fuzz ? 'fuzz' : 'replay',
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    seed: r.fuzz?.seed ?? null,
    steps: r.fuzz?.steps ?? null,
    sabotaged: r.mutation,
    total: r.summary.total,
    passed: r.summary.passed,
    failed: r.summary.failed,
    verdict: r.summary.failed === 0 ? 'all checks match' : 'differences found',
    operations: [...ops.entries()].map(([operation, v]) => ({ operation, ...v })).sort((a, b) => a.operation.localeCompare(b.operation)),
    mismatches: r.cases
      .filter((c) => !c.pass)
      .slice(0, 25)
      .map((c) => ({ n: c.n, label: c.label, request: `${c.method} ${c.emulatorPath}`, requestBody: c.requestBody, emulatorStatus: c.emulatorStatus, generatedStatus: c.generatedStatus, diffs: c.diffs.slice(0, 8) })),
    reproduce: r.reproduction?.command,
  };
}

export function buildVerificationReport(build: BuildInfo, traces: TraceEvent[], reports: ParityReport[]): VerificationReport {
  const contract = inferContract(traces);
  const { fingerprint, canonical } = contractFingerprint(contract);
  const mine = reports.filter((r) => r.buildId === build.id);
  const runs = mine.filter((r) => !r.mutation).map(summarize);
  const detectionTests = mine.filter((r) => r.mutation).map(summarize);
  const status: VerificationReport['verification']['status'] = runs.length === 0 ? 'not verified' : runs.every((r) => r.failed === 0) ? 'verified, all runs match' : 'differences found';
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    build: { id: build.id, createdAt: build.createdAt, resources: build.resources, trainedOnRequests: build.traceCount, files: build.files.length, manifest: build.files.map((f) => ({ path: f.path, sha256: f.sha256 })) },
    contract: {
      fingerprint,
      fingerprintInputs: canonical,
      resources: contract.resources.map((r) => ({ name: r.name, fields: Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v.types.join(' | ')])), required: r.required, operations: r.operations.map((o) => `${o.method} ${o.route} (seen ${o.count}x)`) })),
    },
    verification: {
      status,
      note:
        runs.length === 0
          ? 'No parity or fuzz run has been executed against this build, so nothing is claimed about its behaviour.'
          : 'Each run replays requests against a fresh emulator and a freshly started copy of the generated server, then compares status codes, response bodies and final data.',
      runs,
      detectionTests,
    },
    normalization: NORMALIZATION_RULES,
    limitations: [
      ...NOT_COVERED,
      'Only the behaviour visible in recorded traffic (and in seeded fuzz sessions generated from the inferred contract) is covered. Unobserved behaviour is unknown, not verified.',
      'The emulator is the reference implementation, so parity shows the generated server matches the emulator, not that either matches a production backend that does not exist yet.',
      'Fuzz sessions only send bodies that conform to the inferred contract, so rejection of invalid bodies is covered only by the fixed synthetic edge cases.',
    ],
    howToReproduce: [
      'npm install && npm run build && npm start',
      'Replay the same traffic through the dashboard, or import it with Import HAR, then Generate backend.',
      ...runs.filter((r) => r.reproduce).map((r) => r.reproduce as string),
      'The contract fingerprint above is the sha256 of the canonical JSON in fingerprintInputs; recompute it to confirm the contract is unchanged.',
    ],
  };
}

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const json = (v: unknown) => esc(JSON.stringify(v));

function runHtml(r: RunSummary): string {
  const label = r.kind === 'fuzz' ? `Seeded fuzz, seed ${r.seed}, ${r.steps} operations` : 'Replay of recorded traffic';
  return `<section class="run ${r.failed ? 'bad' : 'ok'}"><h3>${esc(label)}${r.sabotaged ? ` <span class="tag">sabotaged build: ${esc(r.sabotaged)}</span>` : ''}</h3>
<p><strong>${r.passed} of ${r.total}</strong> checks match, ${r.failed} differ. ${esc(r.verdict)}. ${r.durationMs} ms, started ${esc(r.startedAt)}.</p>
<details><summary>Operations checked (${r.operations.length})</summary><table><tr><th>Operation</th><th>Checks</th><th>Differ</th></tr>${r.operations.map((o) => `<tr><td><code>${esc(o.operation)}</code></td><td>${o.checks}</td><td>${o.failed}</td></tr>`).join('')}</table></details>
${r.mismatches.length ? `<details open><summary>Mismatch evidence (${r.mismatches.length}${r.failed > r.mismatches.length ? ` of ${r.failed}` : ''})</summary>${r.mismatches.map((m) => `<div class="mm"><p><code>${esc(m.request)}</code> status emulator ${m.emulatorStatus}, generated ${m.generatedStatus}${m.requestBody !== undefined ? ` <br>request body <code>${json(m.requestBody)}</code>` : ''}</p><table><tr><th>Where</th><th>Emulator</th><th>Generated</th></tr>${m.diffs.map((d) => `<tr><td><code>${esc(d.path)}</code></td><td><code>${json(d.emulator)}</code></td><td><code>${json(d.generated)}</code></td></tr>`).join('')}</table></div>`).join('')}</details>` : ''}
${r.reproduce ? `<p class="small">Reproduce: <code>${esc(r.reproduce)}</code></p>` : ''}</section>`;
}

export function renderVerificationHtml(r: VerificationReport): string {
  const badge = r.verification.status === 'verified, all runs match' ? 'ok' : r.verification.status === 'not verified' ? 'none' : 'bad';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PHANTOM verification report: ${esc(r.build.id)}</title>
<style>:root{color-scheme:dark;--bg:#0d1430;--panel:#131c3b;--line:#26325e;--ink:#e4e8f6;--mute:#939dc4;--teal:#34c6b3;--rose:#ff7088}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:960px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 4px}h2{margin:36px 0 10px;font-size:20px}h3{margin:0 0 6px;font-size:17px}code{font:13px ui-monospace,Menlo,monospace;background:#0a1030;padding:1px 5px;border-radius:4px;word-break:break-all}
.sub{color:var(--mute);margin:0 0 20px}.badge{display:inline-block;padding:3px 12px;border-radius:99px;font-weight:700;border:1px solid}.badge.ok{color:var(--teal);border-color:var(--teal)}.badge.bad{color:var(--rose);border-color:var(--rose)}.badge.none{color:var(--mute);border-color:var(--mute)}
section,.box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}.run.ok{border-left:4px solid var(--teal)}.run.bad{border-left:4px solid var(--rose)}.tag{font-size:12px;color:var(--rose);border:1px solid var(--rose);border-radius:99px;padding:1px 8px;margin-left:6px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}.small{color:var(--mute);font-size:14px}details{margin:8px 0}summary{cursor:pointer;color:var(--ink)}.mm{border-top:1px solid var(--line);padding-top:6px;margin-top:6px}ul{padding-left:20px}li{margin:3px 0}</style></head><body><main>
<h1>Verification report</h1><p class="sub">Generated by PHANTOM at ${esc(r.generatedAt)}. Self-contained: no scripts, no network. Schema <code>${esc(r.schema)}</code>.</p>
<p><span class="badge ${badge}">${esc(r.verification.status)}</span></p><p class="small">${esc(r.verification.note)}</p>
<h2>Generated backend</h2><div class="box"><p>Build <code>${esc(r.build.id)}</code>, created ${esc(r.build.createdAt)}, from ${r.build.trainedOnRequests} recorded requests. Collections: ${r.build.resources.map((x) => `<code>/api/${esc(x)}</code>`).join(', ') || 'none'}.</p>
<details><summary>${r.build.files} files with SHA-256</summary><table><tr><th>File</th><th>SHA-256</th></tr>${r.build.manifest.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td><code>${esc(f.sha256)}</code></td></tr>`).join('')}</table></details></div>
<h2>Contract</h2><div class="box"><p>Fingerprint <code>${esc(r.contract.fingerprint)}</code></p>${r.contract.resources.map((c) => `<h3><code>/api/${esc(c.name)}</code></h3><table><tr><th>Field</th><th>Observed type</th><th></th></tr>${Object.entries(c.fields).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td><td>${c.required.includes(k) ? 'required' : 'optional'}</td></tr>`).join('')}</table><p class="small">Operations observed: ${c.operations.map((o) => `<code>${esc(o)}</code>`).join(', ')}</p>`).join('')}
<details><summary>Fingerprint input (canonical JSON)</summary><code>${esc(r.contract.fingerprintInputs)}</code></details></div>
<h2>Verification runs</h2>${r.verification.runs.length ? r.verification.runs.map(runHtml).join('') : '<div class="box"><p>No runs for this build.</p></div>'}
<h2>Detection tests (deliberately broken builds)</h2><p class="small">These prove the check can fail. They are not counted toward the verdict above.</p>${r.verification.detectionTests.length ? r.verification.detectionTests.map(runHtml).join('') : '<div class="box"><p>None run.</p></div>'}
<h2>What is normalised</h2><ul>${r.normalization.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>Limitations</h2><ul>${r.limitations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>How to reproduce</h2><ul>${r.howToReproduce.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
</main></body></html>`;
}
