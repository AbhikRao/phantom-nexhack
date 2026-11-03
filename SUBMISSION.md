# NexHack 3.0 submission

| | |
|---|---|
| **Project** | PHANTOM: The Backend That Builds Itself |
| **Team** | abhikrao1301 (Abhik Rao, Yashavi Tyagi) |
| **Track** | Open Innovation |
| **Repository** | https://github.com/AbhikRao/phantom-nexhack |
| **Demo video** | https://youtu.be/Mfh-gT-wnRs (104 seconds, no voiceover) |
| **Live demo** | None. PHANTOM runs locally (see "Run it"). |

**Tagline:** Build a frontend against an API that doesn't exist, then turn how it was used into a verified, persistent backend.

## Problem

Frontend teams wait on backends, or build against mock APIs that are thrown away and drift from what is eventually built.
Nothing checks that the real backend behaves like the mock the frontend was developed against.

## Solution

PHANTOM is a local, stateful REST emulator. It answers a frontend's requests with no route declarations, records every
interaction (secrets redacted), and infers the data contract: field types, required fields, observed operations and an
OpenAPI 3.1 document. In one click it generates a **standalone backend** (TypeScript, SQLite, its own validation and
tests, zero runtime dependencies) that never calls PHANTOM, and then **proves it behaves the same**:

- **Parity check:** recorded requests are replayed against a fresh emulator and a fresh copy of the generated server;
  statuses, bodies and final data are diffed. A deliberately sabotaged build must fail, and does.
- **Seeded fuzz:** reproducible random CRUD sessions generated from the contract.
- **Live shadow mode:** real traffic is mirrored to an isolated copy of the generated backend and differences appear as they happen.
- **Contract drift detection:** new endpoints, unexpected fields and incompatible types after generation, with evidence.
- **Portable verification report:** a standalone HTML and JSON record of exactly what was run and what failed.
- **Reality switch:** the demo app is pointed at the generated server, which runs as its own process; data survives a restart and a page reload.

**What is new:** API mocking exists. PHANTOM connects what mocking tools leave out: observed behaviour, to an independent
runnable backend, to an automatic check that the two behave the same, kept honest over time by shadow traffic and drift detection.

**Impact (hypothesis, not measured):** less duplicated mock-then-rebuild work and fewer contract surprises at integration.
No benchmark was run, so no time savings are claimed.

## Run it

Needs Node.js 22.18 or newer. No API keys.

```bash
npm install && npm run build && npm start      # open http://127.0.0.1:8787, then click "Run the whole demo"
```

## Verified results

Observed on 2026-11-03 (Linux, Node 24.21, Chrome 156), including from a fresh clone of this repository:
typecheck clean, 36/36 unit and integration tests, 6/6 black-box contract probe, 13/13 acceptance steps (generated backend
installed and run in a clean folder with PHANTOM stopped), 21/21 Playwright browser checks. Commands are in the README.

## Technology

TypeScript on Node.js 22.18+ (type stripping), Fastify 5, `node:sqlite`, fflate, React 19, Vite 8, Tailwind CSS 4, Vitest 5,
playwright-core. Inference and generation are deterministic; no AI or ML runs at runtime and no API key is needed.

## Team

**abhikrao1301**

| Member | Contribution |
|---|---|
| Abhik Rao | Core engine and verification: emulator, trace recording and redaction, contract inference and OpenAPI, backend and typed-client generator, parity and fuzz verification, shadow mode, drift detection, release |
| Yashavi Tyagi | Product experience: dashboard design and UX, the guided demo, documentation and submission copy, demo video direction |

## AI assistance disclosure

AI coding assistants were used heavily to write code, tests and documentation, under the team's direction. Third-party
open-source libraries are listed in the README. No code from before the event was used.
