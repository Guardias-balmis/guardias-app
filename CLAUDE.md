# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Guardias · Dr. Balmis — an on-call-shift ("guardia") scheduling tool for Radiodiagnóstico residents at Hospital General Universitario Dr. Balmis. It is mid-rewrite ("v2"): domain-driven design, Google Sheets as both datastore and deliverable, a Google Apps Script Web App backend, and a no-build-step React client loaded via Babel Standalone in the browser. Guiding goal (README.md): the app must run ≥10 years with no administrator — R1–R4 levels are derived from dates rather than stored, history is never deleted, and no secret ever lives in the browser.

Shift-code vocabulary used everywhere (domain, UI, Sheets) — never translate or rename: `G` guardia ordinaria · `GF` guardia festiva · `GP` guardia prefestivo · `3P` tercer puesto (voluntario) · `V` vacaciones · `R` rotación externa · `B` baja.

## Commands

```bash
npm test                                          # full suite: domain + server + client/lib (node:test, zero deps, Node >=20)
npm run build                                     # node build/build-gas.mjs — regenerates server/domain.gs + server/server-lib.gs

node --test v2/domain/test/validate.test.js       # single domain test file (swap filename: tally.test.js, equity.test.js, ...)
node --test 'v2/domain/test/*.test.js'            # domain layer only
node --test 'v2/domain/test/*.test.js' 'server/test/*.test.js'   # domain + server (bundle-parity-sensitive changes)

node server/dev-server.mjs                        # local full-stack dev: serves client + real router.js over an in-memory store,
                                                   # with faked Google token verification (dev:<email>:<nonce>) — port 8787
python3 -m http.server 8080                       # static-only serving; talks to the real deployed backend via client/config.js
```

There is no lint script and no bundler for the client. `npm test` covers domain, server, and `client/lib/` (api.js, auth.js) via `node:test`; the `.jsx` screens are **not** Node-testable (Babel-in-browser) and are verified manually in-browser instead — this is intentional, not a coverage gap to "fix".

## Architecture

### Domain layer (`v2/domain/*.js`) — the source of truth

Zero-dependency, zero-I/O ES modules, consumed unmodified by both the browser client and (via a generated bundle) the Apps Script backend — with one exception: `accumulate.js` is excluded from the bundle (`build/build-gas.mjs`'s `DOMAIN_MODULES` list) and is only ever imported client-side, by `Generator.jsx`. Every function is a pure computation over plain data the caller passes in — nothing here touches Sheets, React, or the network.

Governing principle (spec.md §1): **derive, don't store**. A resident's level (R1–R4/PENDIENTE/FINALIZADO) is never a persisted field — it's computed on demand from training-period dates (`residents.js:levelOn`). There is no "promote resident" action; a resident's level just changes as of their own anniversary. Residents are never deleted — a `FINALIZADO` resident simply stops appearing in level-filtered views while their full history stays intact. The same append-only philosophy applies to `Bloqueo` cancellation (re-insert same id with `activo=false`, never delete the row) and to `Cuadrante` state transitions (append-only history rows).

Dates are always ISO `"YYYY-MM-DD"` strings, validated strictly by `calendar.js:parseISO`, with all arithmetic through `Date.UTC(...)` — never the local-timezone `Date` constructor — and **months are 1–12 everywhere**, never JS's native 0–11. This convention exists specifically to make impossible a real v1 bug: a +1-month offset caused by `Date.getMonth()`. Never hand-roll `new Date(anio, mes, ...)`; always go through `calendar.js` helpers.

`Bloqueo` (motivo BAJA | VACACIONES | ROTACION) is deliberately split from `Preferencias.fechasEvitar`: only `motivo=BAJA` is DURO (hard) and blocks assignment (INV-5); VACACIONES/ROTACION are informative — they never block by themselves but still feed INV-2/6/7 and equity's availability discount. `fechasEvitar` is pure soft preference and is never enforced by the validator. Don't collapse these into one table.

The ten modules split cleanly by responsibility: date/weekday/UTC arithmetic and academic-year derivation (`calendar.js`); training periods, level, and group derivation (`residents.js`); a deliberately dumb per-resident shift counter that never sees holiday data (`tally.js`); the month-scope invariant validator, `validateMonth` (`validate.js` — "la IA propone, el validador dispone"); third-post rules, `validateThirdPost`/INV-8 (`thirdpost.js`); residency-year-close equity, INV-3/4 (`equity.js`); the responsable lottery, INV-14 (`responsible.js`); cuadrante state-transition rules only, no persistence (`cuadrante.js`); Sheets-ready row projection that writes nothing itself (`projection.js`); and the generator's accumulated tally, `accumulatedTally` (`accumulate.js` — browser-only, not part of the Apps Script bundle).

Load-bearing contracts, easy to silently break:
- **C-1 (lookahead):** any monthly `dobletes` computation that gets summed across months (Sheets projection, equity accumulation) must feed `tally()` the target month's assignments **plus** the first ~2 days of the next month, or a Friday-31→Sunday doblete silently vanishes — this is the exact bug already fixed once (S-5). `projection.js`'s per-tab rows deliberately do *not* do this lookahead (documented, matches the legacy `.xlsm`) — don't "fix" that without re-reading its header comment.
- **C-2 (INV-7 rotation history):** INV-7 is evaluated only in the month a nearby rotation *ends*, but needs that resident's assignments for the whole rotation, which may start in an earlier month. Callers must fetch that history themselves — use `validate.js`'s exported `rotationHistoryStart` helper rather than reimplementing it (a past regression: Calendar.jsx was not honoring this).
- `cohorte` (calendar year of `fechaInicio`, used by INV-6/INV-11) and `nivel` (date-derived level, used for MAYOR/PEQUENO) are distinct — don't conflate them.
- INV-12 (GF-must-be-actual-holiday) and INV-13 (Imaginaria rotation) are **not implemented yet** — don't assume `validateMonth` covers holiday-coherence.

Style: identifiers/code in English, comments/JSDoc in Spanish, explaining *why* (spec.md cross-references), never *what*. Never add an npm dependency under `v2/domain`.

### Server (Google Apps Script Web App: `server/src/*.js`, `server/Code.gs`, `server/domain.gs`, `server/server-lib.gs`, `build/build-gas.mjs`)

Hexagonal design: `server/Code.gs` is the **only** hand-written, impure file — the sole adapter touching `UrlFetchApp`/`SpreadsheetApp`/`LockService`/`CacheService`/`PropertiesService`, and the only backend file with zero test coverage (verify it manually). It builds a `deps_()` object and hands it to the pure `Server.handleRequest(rawBody, deps)` from the generated bundle, which is how `router.js` stays testable without touching real Sheets/Google APIs.

**`server/domain.gs` and `server/server-lib.gs` are generated artifacts — never hand-edit them.** Both carry a "NO EDITAR A MANO" header. Edit `v2/domain/*.js` or `server/src/*.js` and run `npm run build`; `v2/domain/test/parity.test.js` re-executes the committed bundle in `node:vm`, diffs it against the live ESM source, and fails the suite if they've drifted. The bundler exists because Apps Script concatenates all `.gs` files into one global scope with no ESM support — naive concatenation was verified to collide silently on several names (e.g. two different `periodsOf` implementations, where function-declaration hoisting plus unspecified file-parse order means "whichever loads last wins with no error"). The bundler wraps each module in its own IIFE and only supports a narrow import/export subset (`import {a,b} from "./x.js"`, `export function|const|let|var|class NAME` — no default export, no re-export, no dynamic `import()`).

Auth flow: client gets a one-time nonce (`getNonce`), runs Google Identity Services, then the server's `verify-token.js:verifyTokeninfo()` validates the ID token — including **manually checking `aud === clientId`**, since Google's tokeninfo endpoint does not itself validate audience (the code comment calls this "el fallo estrella" — never remove it, or any token minted for another Google OAuth app would be accepted). On success the server issues its own signed-not-encrypted HMAC-SHA256 session token (`session.js`); `rol` (responsable vs residente) is always derived server-side from the `responsables` mandate table, never trusted from the client.

Storage (`sheets-schema.js` + `sheets-store.js`): 9 tables are append-only and UUID-keyed, never rewritten row-by-row; `readLatest` projects "current state" as last-row-wins per key. All writes serialize through one Apps Script script lock (a per-user lock wouldn't serialize anything since "Execute as Me" runs everything under one identity). Projected/derived sheets (monthly tab + "Resumen") are republished via a crash-safe shadow-swap (`_tmp_` sheet → delete old → rename) — this is only for projected output, never for the append-only data tables. **Fixed production bug worth remembering:** Google Sheets silently auto-converts an ISO date string cell to its internal Date type on write; `sheets-schema.js`'s `"date"` column type works around it by apostrophe-prefixing on serialize and handling both a real `Date` (via *local*-timezone getters, matching `Code.gs`'s Europe/Madrid formatting — deliberately not the UTC convention used elsewhere in the domain) and the apostrophe-prefixed string on deserialize.

Deployment must be "Execute as: me" + "Anyone" access, or CORS breaks (see `server/README-deploy.md`); redeploy via "Nueva versión" on the existing deployment, not a new one, or the `/exec` URL changes.

### Client (`index.html`, `client/loader.js`, `client/config.js`, `client/lib/*`, `client/ui/components.jsx`, `client/App.jsx`, `client/screens/*.jsx`)

No bundler, no build step. `index.html` loads React/ReactDOM/Babel Standalone/GIS from CDN tags plus one `<script type="module" src="client/loader.js">`. `loader.js` exists because Babel Standalone's automatic `<script type="text/babel">` DOM-scanner was found to silently drop one of the app's JSX files with no error — so `loader.js` instead fetches, transpiles, and `import()`s each file from a `Blob` URL sequentially, in a fixed order (`components.jsx` → screens → `App.jsx` last, since `App.jsx` consumes `window.Screens.*`).

Two rules this creates, both easy to violate without an obvious error:
- **Every import inside a `.jsx` file must be root-relative** (`"./client/lib/api.js"`, `"./v2/domain/calendar.js"`), never relative to the file's own folder — `blob:` URLs are opaque/non-hierarchical, so a same-folder relative import throws once the code executes from a blob.
- **`.jsx` files must never import another `.jsx` file** (Babel Standalone transpiles each file in isolation, no cross-file graph). Cross-screen composition instead happens through global namespaces: `window.UI.*` (components), `window.Screens.*` (screens + `Screens.App`), and `window.useApp` (App's context hook). Plain `.js` modules under `client/lib/` and `v2/domain/` are real ES modules and can import each other normally. Adding a new screen means appending it to `loader.js`'s `JSX_FILES` before `"client/App.jsx"`.

`client/config.js` holds `EXEC_URL` and `GOOGLE_CLIENT_ID` as committed, non-secret constants (by design — zero secrets in the browser); treat edits to it as deploy-affecting, not routine config. Session tokens live in `sessionStorage` under `guardias_session` (never `localStorage`, so they clear on tab close). `client/lib/api.js` sends every request as a CORS "simple request" (`Content-Type: text/plain`, `credentials: "omit"`, identity as a bearer value inside the JSON body) specifically to avoid an OPTIONS preflight that Apps Script cannot answer — don't add an `Authorization` header or custom content type. `callBackend` never throws; all failures normalize to `{ok:false, error}`.

One more anti-regression convention specific to this layer: assignments are keyed by `residenteId`, never by resident name — `Calendar.jsx` has an explicit note against reintroducing that regression.

## Branch / deploy model

`main` is production: GitHub Pages serves `index.html` from `main`, and **every push to `main` deploys live**. All v2 rewrite work happens on the `v2` branch; `main` is not touched until the final cutover. Don't push rewrite-in-progress work to `main`.
