# NexHack 3.0 submission: PHANTOM

**Project title:** PHANTOM: The Backend That Builds Itself

**Track:** Open Innovation. PHANTOM's runtime inference is deterministic, not ML, so it is not entered as an AI/ML project.

**Tagline:** Build a frontend against an API that doesn't exist, then turn how it was used into a verified, persistent backend.

## Description

Frontend teams wait on backends, or build against mock APIs that get thrown away and drift from what is eventually
built. PHANTOM is a local, stateful REST emulator that answers a frontend's requests without any route declarations
and records every interaction, with secrets redacted. From that traffic it infers the data contract: field types,
required fields, observed operations, and an OpenAPI 3.1 document.

With one click it generates a **standalone backend project**: TypeScript, SQLite persistence, its own validation and
tests, and zero runtime dependencies. That project never calls PHANTOM. PHANTOM then **replays the recorded traffic**
against a clean emulator and a clean copy of the generated server, and diffs status codes, bodies and final data. A
deliberately sabotaged build, and a seeded random-operation (fuzz) session, show the check really fails when behaviour
differs and holds up beyond the recorded happy path. **Live shadow mode** mirrors real traffic to an isolated copy of the generated backend and shows differences as they
happen, and **contract drift detection** flags new endpoints, unexpected fields and incompatible types with evidence. A
one-click demo mode runs the whole flow with real requests. Finally, the demo app switches to the
generated server running as its own process on a separate port, and its data survives process restarts and page
reloads.

**What's new here:** API mocking already exists. PHANTOM connects the pieces mocking tools leave out: from observed
behaviour, to an independent runnable backend, to an automatic check that the two behave the same.

**Impact (hypothesis, not measured):** less duplicated mock-then-rebuild work and fewer frontend/backend contract
surprises at integration. We have not run a benchmark, so we claim no time savings.

## Technology stack

TypeScript on Node.js 22.18+ (type stripping), Fastify 5, node:sqlite, fflate, React 19, Vite 8, Tailwind CSS 4,
Vitest 5, playwright-core.

## Links

- GitHub repository: https://github.com/AbhikRao/phantom-nexhack (public)
- Demo video: **TBD**. Follow [DEMO_WALKTHROUGH.md](DEMO_WALKTHROUGH.md); `npm run record` can capture the guided run.
- Live demo URL: **TBD / none**. The project runs locally and has not been deployed.

## Setup for judges

```bash
npm install && npm run build && npm start   # then open http://127.0.0.1:8787
```

## Verified results (see README, "Verified test results")

31/31 unit and integration tests, 6/6 contract probe, 13/13 generated-backend acceptance steps (clean-folder
install with PHANTOM stopped), and 20/20 Playwright browser smoke checks.

## Team contribution

**TBD.** List each participant and what they did.

## AI assistance disclosure

Substantial AI coding assistance was used to write code, tests and documentation, under the team's direction. Third-party open-source libraries are listed above. No code from before the event was used. The
product itself uses no AI at runtime.
