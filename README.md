# PHANTOM: the backend that builds itself

Build your frontend against an API that doesn't exist yet. PHANTOM answers the requests and records them. From that
recorded traffic it infers the contract, **generates a standalone persistent backend**, and then **replays the traffic
to check** that the new backend behaves the same way.

Built for NexHack 3.0 (Open Innovation track).

## The problem

Frontend work stalls while the backend is written. Teams get around this with mock APIs (JSON fixtures, MSW, json-server,
Mockoon, Prism and so on). Those tools are good and API mocking is not new. Their weakness is the handoff:

- A mock is throwaway. The backend team rebuilds the same endpoints from scratch, usually from a spec that has already
  drifted from what the frontend actually calls.
- Nothing checks whether the real backend behaves like the mock the frontend was built against. Differences show up
  late, at integration time.

PHANTOM turns the mock phase into the first draft of the backend:

1. **Observe.** A stateful REST emulator answers any `/api/<collection>[/<id>]` request with no route declarations.
   Every call is recorded, with secrets redacted.
2. **Infer.** Field types, optional and required fields, and observed operations are merged from real traffic into a
   contract and an OpenAPI 3.1 document.
3. **Generate.** A downloadable TypeScript project with SQLite persistence, its own validation and tests. It has zero
   runtime dependencies and never calls PHANTOM.
4. **Verify.** The recorded requests are replayed against a clean emulator and a clean copy of the generated server.
   Statuses, bodies and final data are diffed. A deliberately broken build is used to show the check actually fails
   when it should.
5. **Switch.** The generated server runs as its own OS process on its own port. The demo app is pointed at it, and data
   survives process restarts and page reloads.

## Architecture

```
 Browser (dashboard served by PHANTOM on :8787)
 ┌──────────────┐   fetch(API_BASE_URL + /api/...)    ┌────────────────────────── PHANTOM engine :8787 ───────────────┐
 │  TaskBoard   │ ── PHANTOM mode ──────────────────▶ │ /api/*        resourceEngine (stateful, deterministic ids)   │
 │ (demo app)   │                                     │                 │ every request/response                     │
 │              │                                     │                 ▼                                            │
 │              │                                     │               traceRecorder (redaction, SSE stream, JSON)    │
 │              │                                     │                 ▼                                            │
 │              │                                     │               contractInference ─▶ OpenAPI 3.1               │
 │              │                                     │                 ▼                                            │
 │  inspector   │ ◀── /__phantom/* control plane ───▶ │               backendGenerator ─▶ .phantom/builds/<id>  + ZIP │
 │  panels      │                                     │                 ▼                                            │
 │              │                                     │               parityVerifier: fresh emulator  vs  fresh      │
 │              │                                     │                               generated process (temp DB)   │
 │              │                                     │               processManager: spawn / health-check / restart │
 └──────┬───────┘                                     └──────────────────────────────┬───────────────────────────────┘
        │ REAL mode                                                                  │ spawn `node src/server.ts`
        ▼                                                                            ▼
 ┌──────────────────────────────── generated backend :8788 (separate process, separate code) ─────────────────────────┐
 │ node:http router  ·  validate.ts (inferred contract)  ·  store.ts (node:sqlite, one table per collection)  ·  /health │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Module | File | Responsibility |
|---|---|---|
| resourceEngine | `server/resourceEngine.ts` | In-memory REST collections, CRUD semantics, filters, error shapes |
| traceRecorder | `server/traceRecorder.ts` | Sanitised trace events, header/body redaction, live subscription |
| contractInference | `server/contractInference.ts` | Type merging (`integer`→`number`, unions, nested objects, arrays), required fields, OpenAPI |
| backendGenerator | `server/backendGenerator.ts` | Deterministic project generation, safe file writing, ZIP |
| parityVerifier | `server/parityVerifier.ts` | HTTP replay with id remapping, normalisation, deep diffs |
| processManager | `server/processManager.ts` | Starts a generated build as a child process and health-checks it |
| app | `server/app.ts` | Fastify wiring, CORS, control plane, persistence, REAL launcher |
| template | `templates/backend/` | Source of the generated server (typechecked in this repo) |
| dashboard | `web/src/` | React + Tailwind UI |

### Emulated API contract

| Request | Response |
|---|---|
| `GET /api/<c>` | `200` JSON array, ascending id. An unseen collection returns `[]` and is discovered. Exact-match filters on scalar fields: `?status=done` |
| `POST /api/<c>` | `201` `{ id, ...body, createdAt, updatedAt }` plus a `Location` header |
| `GET /api/<c>/<id>` | `200` record, or `404` |
| `PATCH /api/<c>/<id>` | `200` shallow merge, or `404` |
| `PUT /api/<c>/<id>` | `200` replaces client fields (id and createdAt kept), or `404` |
| `DELETE /api/<c>/<id>` | `204`, or `404` |
| Invalid JSON or non-object body | `400` `{ error: "invalid_json" \| "invalid_body", message }` |
| Wrong method | `405` with an `Allow` header |
| Body > 1 MiB | `413` |

Ids are per-collection positive integers that are never reused, which keeps replay deterministic. `id`, `createdAt` and
`updatedAt` sent by clients are ignored. Collection names must match `^[a-z][a-z0-9_-]{0,39}$`. Up to 32 collections
are emulated.

The generated backend implements the same semantics independently. It differs in two documented ways: it returns `400
validation_failed` when a body contradicts the inferred types or omits a required field, and `404 unknown_resource` for
collections that weren't in the recorded traffic.

## Run it

Requires **Node.js 22.18+** (developed on Node 24.21). Neither PHANTOM nor the generated backend needs an API key.

```bash
npm install
npm run build      # builds the dashboard into web/dist
npm start          # PHANTOM + dashboard on http://127.0.0.1:8787
```

Development mode with hot reload (Vite on :5173 talking to PHANTOM on :8787):

```bash
npm run dev
```

State lives in `./.phantom/`: emulator data, traces, builds, and the REAL backend's SQLite files. Use **Start over** in
the UI, or delete that folder, to begin fresh.

### Run a generated backend by hand (two terminals, PHANTOM optional)

```bash
unzip phantom-backend-<build-id>.zip && cd phantom-backend-<build-id>
npm start                          # http://127.0.0.1:8788, data in ./data/phantom.db
SEED_FILE=seed.json npm start      # import the dataset exported from PHANTOM (only into an empty DB)
npm install && npm run typecheck && npm test   # optional checks; needs the TypeScript dev dependency
```

## Demo walkthrough (about 2 minutes)

The chips across the top of the dashboard track these steps. Each one turns green only when the real state is reached,
for example a recorded `POST` or a parity report with zero failures.

1. **Add a task, move it, delete one.** Each action is an HTTP call. The TaskBoard footer shows the exact URL it sent,
   *Live traffic* shows what PHANTOM recorded, and *What PHANTOM has learned* fills in the endpoints and field types.
   Open *Notes* and save one: `/api/notes` appears without being declared anywhere.
2. **View or download the OpenAPI document** that was inferred from that traffic.
3. **Generate the backend.** Browse the generated files (`src/resources.ts` is the part specific to your traffic) and
   download the ZIP.
4. **Run parity check.** Every recorded request is replayed against a fresh emulator and a freshly spawned generated
   server on ephemeral ports. Then click **Test a broken build**: PHANTOM generates a copy whose PATCH handler ignores
   the body, and the same check fails with field-level diffs.
5. **Start generated backend**, then **Point TaskBoard at 127.0.0.1:8788**. The badge and route strip change, and the
   request log shows `:8788`. Add a task. The emulator never sees it, so the trace stream goes quiet. Click **Restart
   process** (you get a new pid), then reload the page: the task is still there, read back from SQLite.

## Verified test results

Observed on 2026-11-03, Linux, Node 24.21.0, Google Chrome 156 (via playwright-core):

| Command | What it checks | Result |
|---|---|---|
| `npm run typecheck` | Server, template and dashboard TypeScript | clean |
| `npm test` | 18 vitest tests: engine semantics, redaction, inference, generator injection and path-traversal safety, an e2e run (HTTP traffic, build, parity pass, induced failure with diff, REAL launch, restart persistence, 400 on contract violation) | 18/18 pass |
| `npm run build` | Production dashboard build | succeeds |
| `PHANTOM_API=http://127.0.0.1:8787 npm run probe` | Kit's black-box contract probe against the emulator | 6/6 pass |
| `npm run acceptance` | Records traffic, downloads the ZIP, **stops PHANTOM**, extracts to a clean temp folder, runs `npm install`, `typecheck` and the project's own `npm test`, starts it on :8798, checks seed import, runs the **contract probe against the generated backend**, restarts the process and checks the record is still there | 12/12 pass |
| `npm run smoke` | Playwright drives the real UI: create, move, inferred fields, generate, parity pass, broken build caught, REAL launch and switch, POST lands on the REAL port, emulator doesn't see it, restart + reload keeps data, contract survives reload, no mobile horizontal scroll, no console errors | 13/13 pass |

Screenshots captured by the smoke test (real runs, not mockups): `artifacts/screenshots/desktop-phantom.png`,
`desktop-real.png`, `mobile.png`.

## Tradeoffs and decisions

- **Deterministic inference, not ML.** Types are merged from observed JSON. A field is *required* when it appeared in
  every successful create request. That is predictable and explainable, but it only knows what it has seen.
- **Zero-dependency generated server.** `node:http` plus the built-in `node:sqlite`, with TypeScript run through Node's
  built-in type stripping. Installing and starting it can't fail on native modules. The cost is a requirement of Node
  22.18 or later.
- **Template plus generated data, not string-spliced handlers.** Handler code is copied verbatim from
  `templates/backend` (typechecked in this repo). The only generated source is `src/resources.ts`. Every observed value
  in it is emitted through `JSON.stringify`, and identifiers come from collection names that already passed a strict
  regex. A test feeds hostile field names through and checks they stay inside string literals.
- **The emulator is permissive, the generated server is strict.** The emulator accepts any JSON object so it can learn.
  The generated server enforces the learned contract. Parity only replays traffic that conforms by construction, and
  this asymmetry is listed in every parity report.
- **The mutation test is a real sabotaged build.** The broken build used by "Test a broken build" is generated with one
  line of the PATCH handler changed and actually run. If the recorded traffic never exercises PATCH, the UI says the
  sabotage was *not* caught rather than claiming success.

## Security

- Every server binds to `127.0.0.1` by default.
- Strict CORS allow-list: requests carrying any other `Origin` get `403`.
- 1 MiB body limit on both servers.
- `authorization`, `cookie`, `x-api-key` and token, secret or session headers are redacted before storage. So are
  password, token, secret and API-key body fields.
- Generated files are written only through a path check that refuses anything outside the build folder. The file
  preview serves only paths listed in the build manifest.
- There is no upstream proxying, no `eval`, and no execution of request data.

## Limitations

- Only flat REST collections (`/api/<c>` and `/api/<c>/<id>`). No nested routes, auth, relations, pagination, sorting,
  uniqueness or business rules. These are neither emulated nor inferred.
- Inference only reflects recorded traffic. A field never sent is unknown, and extra fields are accepted.
- Query filters are exact string matches on top-level scalar fields.
- Traces are capped at 5,000 events, and parity replays up to 1,000 of them.
- REAL-mode data and PHANTOM-mode data diverge after the switch. Migration is a one-time copy at launch.
- The REAL backend is launched by PHANTOM as a child process. Stopping PHANTOM stops it too. To run it fully on its own,
  use the ZIP and the commands above.
- Not deployed anywhere. Everything runs locally.

## Tech stack

TypeScript (Node.js type stripping), Fastify 5, `@fastify/static`, fflate (ZIP), `node:sqlite`, React 19, Vite 8,
Tailwind CSS 4, Vitest 5, playwright-core (driving installed Chrome), concurrently. Fonts: Bricolage Grotesque, Schibsted
Grotesk and IBM Plex Mono via Google Fonts.

## AI assistance disclosure

AI coding assistants were used heavily to write source code, tests and documentation, under the direction of the team.
All third-party
libraries are listed above and are used under their open-source licences. No code from before the event was used. PHANTOM
itself uses no AI or ML at runtime: inference and generation are deterministic.

## License

MIT, see [LICENSE](LICENSE).
