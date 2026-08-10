# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Guardias · Dr. Balmis — an on-call-shift ("guardia") scheduling tool for Radiodiagnóstico residents at Hospital General Universitario Dr. Balmis. Architecture: domain-driven design, Google Sheets as both datastore and deliverable, a Google Apps Script Web App backend, and a no-build-step React client loaded via Babel Standalone in the browser. Guiding goal (README.md): the app must run ≥10 years with no administrator — R1–R4 levels are derived from dates rather than stored, history is never deleted, and no secret ever lives in the browser.

The "v2" rewrite is live: `main` served the old v1 client until the cutover on 2026-07-24, and now serves this codebase. Residents are testing it in production against the real Sheet, so treat anything reaching `main` as reaching them.

Shift-code vocabulary used everywhere (domain, UI, Sheets) — never translate or rename: `G` guardia ordinaria · `GF` guardia festiva · `GP` guardia prefestivo · `3P` tercer puesto (voluntario) · `V` vacaciones · `R` rotación externa · `B` baja.

## Commands

```bash
npm test                                          # full suite: domain + server + client/lib (node:test, zero deps, Node >=20)
npm run build                                     # node build/build-gas.mjs — regenerates server/domain.gs + server/server-lib.gs

node --test v2/domain/test/validate.test.js       # single domain test file (swap filename: tally.test.js, equity.test.js, ...)
node --test v2/domain/test/*.test.js              # domain layer only — UNQUOTED, see note below
node --test v2/domain/test/*.test.js server/test/*.test.js   # domain + server (bundle-parity-sensitive changes)
node --test test/docs-trazabilidad.test.js        # spec.md §5/§8 vs docs/ traceability gate (see below)

node server/dev-server.mjs                        # local full-stack dev: serves client + real router.js over an in-memory store,
                                                   # with faked Google token verification (dev:<email>:<nonce>) — port 8787
python3 -m http.server 8080                       # static-only serving; talks to the real deployed backend via client/config.js

npm run push                                      # test + build + clasp push — updates the Apps Script project's HEAD only,
                                                   # NOT what's live at the /exec URL (see server/README-deploy.md)
npm run deploy                                    # push, then clasp deploy -i $CLASP_DEPLOYMENT_ID — this is what actually
                                                   # goes live, same /exec URL. Requires one-time `npx clasp login` + a local
                                                   # .clasp.json (gitignored, see .clasp.json.example) + $CLASP_DEPLOYMENT_ID
                                                   # exported in your shell profile, never committed.
```

There is no lint script and no bundler for the client. `npm test` covers domain, server, and `client/lib/` (api.js, auth.js) via `node:test`; the `.jsx` screens are **not** Node-testable (Babel-in-browser) and are verified manually in-browser instead — this is intentional, not a coverage gap to "fix".

**`--test` file-selection args must be UNQUOTED globs — never quoted, never a bare directory (2026-08-08 incident).** Node's own `--test` glob expansion for a quoted pattern like `'v2/domain/test/*.test.js'` only exists from Node 21 on, so it silently finds zero tests on Node 20 (the documented minimum). The seemingly obvious fix, passing bare directories instead, breaks the other way: Node 20 walks a directory argument recursively for `*.test.js`, but Node 22+ changed that same call to find nothing (0 tests) — verified in `node:20`/`22`/`24` Docker containers, no version runs both quoted-glob and bare-directory correctly. The one form that works identically on every version 20+ is an **unquoted** glob (`node --test v2/domain/test/*.test.js`): the *shell* expands it into literal file paths before Node ever sees a wildcard, so Node's own (version-dependent) glob/directory handling never comes into play. `package.json`'s `test`/`push`/`deploy` scripts and CI (`.github/workflows/test.yml`, pinned to Node 20) all rely on this — don't "clean up" the globs by quoting them or swapping in a directory, both silently zero out the suite on some Node version.

## Architecture

### Domain layer (`v2/domain/*.js`) — the source of truth

Zero-dependency, zero-I/O ES modules, consumed unmodified by both the browser client and (via a generated bundle) the Apps Script backend — every module in `build/build-gas.mjs`'s `DOMAIN_MODULES` list, which since P-8 includes `accumulate.js` too (the server needs the accumulated tally to evaluate INV-3's year close). Every function is a pure computation over plain data the caller passes in — nothing here touches Sheets, React, or the network.

Governing principle (spec.md §1): **derive, don't store**. A resident's level (R1–R4/PENDIENTE/FINALIZADO) is never a persisted field — it's computed on demand from training-period dates (`residents.js:levelOn`). There is no "promote resident" action; a resident's level just changes as of their own anniversary. Residents are never deleted — a `FINALIZADO` resident simply stops appearing in level-filtered views while their full history stays intact. The same append-only philosophy applies to `Bloqueo` cancellation (re-insert same id with `activo=false`, never delete the row) and to `Cuadrante` state transitions (append-only history rows).

Dates are always ISO `"YYYY-MM-DD"` strings, validated strictly by `calendar.js:parseISO`, with all arithmetic through `Date.UTC(...)` — never the local-timezone `Date` constructor — and **months are 1–12 everywhere**, never JS's native 0–11. This convention exists specifically to make impossible a real v1 bug: a +1-month offset caused by `Date.getMonth()`. Never hand-roll `new Date(anio, mes, ...)`; always go through `calendar.js` helpers.

`Bloqueo` (motivo BAJA | VACACIONES | ROTACION) is deliberately split from `Preferencias.fechasEvitar`: only `motivo=BAJA` is DURO (hard) and blocks assignment (INV-5); VACACIONES/ROTACION are informative — they never block by themselves but still feed INV-2/6/7 and equity's availability discount. `fechasEvitar` is pure soft preference and is never enforced by the validator. Don't collapse these into one table.

**Toda lectura de `bloqueos` pasa por `v2/domain/absences.js` (decisión V-19).** Los criterios de
cada invariante son distintos a propósito y están nombrados allí (`BLOQUEA_ASIGNACION` para INV-5,
`EXIME_DEL_MINIMO` para INV-2, `AUSENCIA_SIMULTANEA` para INV-6, `DESCUENTA_DISPONIBILIDAD` para el
descuento de INV-3, `isNearbyRotation` para INV-7): no escribas un `filter` nuevo sobre `motivo`,
usa el conjunto que corresponda. El descarte de las filas canceladas (`activo=false`) vive ahí y
solo ahí — cuando vivía en el router, bastaba un invocador que no pasara por él para que un bloqueo
cancelado volviera a bloquear asignaciones. Y recuerda que **una «B» en la rejilla no es una
ausencia**: es un código de asignación que no lee ningún invariante. La ausencia real es una fila de
`bloqueos`, que desde V-19 el Responsable (o cualquier Mayor si no hay mandato) puede crear y
cancelar también por otro residente.

The fifteen modules split cleanly by responsibility: date/weekday/UTC arithmetic and academic-year derivation (`calendar.js`); training periods, level, and group derivation (`residents.js`); a deliberately dumb per-resident shift counter that never sees holiday data (`tally.js`); the single reader of the `bloqueos` table, `absences` (`absences.js`, V-19); preventive coverage-risk simulation on `Bloqueo` registration, `previewBloqueoRisk` (`blockPreview.js`, P-13 — a pre-check at `crearBloqueo` time, not a `validateMonth` invariant); the derived Imaginaria queue, `imaginariaQueue` (`imaginaria.js`, V-20 — a tool, never called by `validateMonth`); the month-scope invariant validator, `validateMonth` (`validate.js` — "la IA propone, el validador dispone"); third-post rules, `validateThirdPost`/INV-8 (`thirdpost.js`); equity at the two closes INV-3 defines — `validateResidencyYearClose` (residency year, all six axes) and `validateQuarterClose` (quarter, `total` only; P-8/V-13), both `aviso`-only — plus INV-4 (`equity.js`); the responsable lottery, INV-14 (`responsible.js`); cuadrante state-transition rules only, no persistence (`cuadrante.js`); Sheets-ready row projection that writes nothing itself (`projection.js`); the accumulated per-resident tally, `accumulatedTally` (`accumulate.js`); and the deterministic month generator, `generateMonth` (`schedule.js`, V-30 — **propone**, no valida: su coste imita a `equity.js` pero el juez sigue siendo el validador).

Load-bearing contracts, easy to silently break:
- **C-1 (lookahead):** any monthly `dobletes` computation that gets summed across months (Sheets projection, equity accumulation) must feed `tally()` the target month's assignments **plus** the first ~2 days of the next month, or a Friday-31→Sunday doblete silently vanishes — this is the exact bug already fixed once (S-5). `projection.js`'s per-tab rows deliberately do *not* do this lookahead (documented, matches the legacy `.xlsm`) — don't "fix" that without re-reading its header comment.
- **C-2 (INV-7 rotation history):** INV-7 is evaluated only in the month a nearby rotation *ends*, but needs that resident's assignments for the whole rotation, which may start in an earlier month. Callers must fetch that history themselves — use `validate.js`'s exported `rotationHistoryStart` helper rather than reimplementing it (a past regression: Calendar.jsx was not honoring this).
- **El ciclo del cuadrante no depende de que exista un Responsable (decisión V-16).** `requireCicloPermiso` (server/src/router.js) permite validar/publicar/despublicar al titular del mandato vigente y, si no hay ninguno, a cualquier Mayor (R3/R4). Relee el store en cada llamada: no te fíes de `session.rol`, que se firmó en el login y puede ser anterior al sorteo. No inventes un mandato para desbloquear nada — INV-14 exige R3 a 1 de enero y el registro tiene que seguir siendo verdad.
- **Solo bloquea lo imposible y lo ilegal (decisión V-14).** De los 15 invariantes, únicamente cuatro producen `error` y por tanto impiden pasar a VALIDADO: INV-1 (día que nadie cubre, o composición de 2+ personas que no puede ser), INV-5 (guardia sobre una baja médica), INV-11 (R1 asignado en junio-agosto) e INV-15 (dos guardias en días consecutivos). Los cuatro son «imposible» o «ilegal»: INV-15 entró como `error` en V-31 precisamente por ahí —el descanso tras una guardia de 24 h es una obligación legal, como la baja de INV-5—, no como excepción a esta regla. Todo lo demás es `aviso` — equidad (INV-3, INV-8), recuento mensual (INV-2), ausencias simultáneas (INV-6), cobertura de rotación cercana (INV-7), 2×R2 sin justificar (INV-9), eventos (INV-10). El motivo es estructural, no de gusto: una regla que bloquea por algo que no se puede corregir dentro de la herramienta deja al servicio sin cuadrante el día que ya no queda nadie que sepa desbloquearla, y el criterio rector del proyecto es sobrevivir sin administrador. No "arregles" esto subiendo una a `error`: la contrapartida acordada es que la UI pide confirmación explícita («Validar de todas formas») antes de validar un cuadrante que las incumple, usando `cuadrante.js:equityWarnings`/`EQUITY_INVARIANTS` — nunca reconociendo el mensaje por su texto.
- **Un solo cuadrante mensual (decisión V-15).** Los «2 grupos» y sus «cuadrantes provisionales» de la normativa son la regla de composición Pequeño+Mayor (INV-1) y la organización de cada grupo, no dos unidades de datos: no hay ni habrá un cuadrante por grupo, ni dos pestañas.
- **C-4 (histórico de INV-8):** el ciclo L-D del tercer puesto (INV-8b) **arranca el día en que
  cada residente se apuntó** (`voluntarios3P.desde`), no en un borde de calendario — decisión
  V-18, que es también lo que hace que el `desde` de esa tabla no sea decorativo. El rango que
  hay que leer lo da `thirdpost.js:thirdPostHistoryStart` (el `desde` de cada voluntario para 8b
  y la ventana del año de residencia para 8c, la más antigua de las dos), igual que
  `rotationHistoryStart` para C-2: no se adivina en el invocador. Y el historial que se le pasa
  debe contener **solo los 3P anteriores al mes** — los del mes llegan por `asignaciones`, y
  contarlos por las dos vías rompe el ciclo de siete días. Quien apunte a alguien al 3P desde el
  servidor debe escribir siempre `session.sub`: «será siempre voluntario», nadie apunta a nadie.
- **Los dos cierres de INV-3 se invocan desde `marcarValidado` (servidor) y `Calendar.jsx` (vía `client/lib/closes.js`), no desde `validateMonth`.** `validateMonth` es de ámbito mes y no los incluye: quien añada otra pantalla que valide un mes tiene que llamar también a `closes.js`, o la equidad de cierre no se comprueba ahí. Los rangos que hay que leer los dan `quarterCloseWindow` y `yearCloseHistoryStart` — no se adivinan (mismo error que costó la regresión de C-2).
- `cohorte` (calendar year of `fechaInicio`, used by INV-6/INV-11) and `nivel` (date-derived level, used for MAYOR/PEQUENO) are distinct — don't conflate them. `blockPreview.js`'s concentration-risk axis (P-13) is the newest place this bites: it groups by `nivel` (R1–R4) on purpose, not `cohorte` — INV-6 already has its own "max 2 simultaneous" but grouped by cohorte and rotation-only, and the two rules look identical from the outside while measuring different things.
- **P-13 blocks only inside a 3-month window (`previewWindowEnd`, `blockPreview.js`).** Vacations/rotations are sometimes requested much further ahead than the ~3-month cuadrante-building session; blocking a request made a year out would leave someone unable to register a vacation already cleared with tutoría, even though things can still change before the window that matters. Outside the window the same imposibilidad risk is only `aviso`. Don't "simplify" this to always-block — that was an explicit author decision (spec.md §8.1), not an oversight. BAJA never feeds `blockPreview.js` at all (it's unpredictable, already covered by INV-5/INV-6).
- **C-3 (ventana de `puentesLibres`):** el eje `puentesLibres` de INV-3 compara el **año de
  residencia entero**, no el mes: los puentes se derivan de la tabla `festivos` con
  `calendar.js:bridgesBetween` sobre `[aniversario, aniversario+1año)`, que **cruza dos años
  naturales** (el aniversario cae en mayo). El rango de festivos que hay que leer lo da
  `equity.js:yearCloseFestivosRange`, igual que `yearCloseHistoryStart` da el de asignaciones: no
  se adivina en el invocador (mismo error que costó la regresión de C-2). Ese rango son los **años
  naturales completos** que toca la ventana (±1 día), no la ventana recortada, y eso es
  deliberado: si falta el calendario el cierre **avisa de que el eje no se ha podido comprobar**
  en vez de comparar ceros y parecer que cuadra, pero la pregunta tiene que ser «¿está cargado el
  año 2027?» y no «¿hay algún festivo en la ventana?» — la carga es por año (V-17a) y la ventana
  cruza dos, así que «uno sí y otro no» es el estado normal, y con la pregunta laxa medio eje
  volvía a compararse sobre ceros en silencio. El aviso solo se emite cuando el invocador pasa
  `festivos` (los tests que inyectan `acumulados` a mano no lo ven) y cuando alguna cohorte tiene
  ≥2 miembros, que es cuando el eje se compara con alguien.
- **Los 15 invariantes están implementados** (INV-12 desde V-17; INV-8 desde V-18; INV-10 e INV-13
  desde V-20). Dos matices que hay que tener presentes antes de dar algo por comprobado:
  **INV-13 (Imaginaria) NO lo comprueba `validateMonth`** y es deliberado — es una herramienta que
  dice a quién llamar (`imaginaria.js:imaginariaQueue`), no una validación a posteriori, porque una
  incidencia se resuelve por teléfono y el registro se hace después (V-20b). Y **INV-10 e INV-12
  dependen de tablas que hoy no tiene ninguna pantalla para rellenarse** (`eventos`, `festivos`):
  están en vigor, pero sin filas cargadas no pueden emitir nada.

Style: identifiers/code in English, comments/JSDoc in Spanish, explaining *why* (spec.md cross-references), never *what*. Never add an npm dependency under `v2/domain`.

### Server (Google Apps Script Web App: `server/src/*.js`, `server/Code.gs`, `server/domain.gs`, `server/server-lib.gs`, `build/build-gas.mjs`)

Hexagonal design: `server/Code.gs` is the **only** hand-written, impure file — the sole adapter touching `UrlFetchApp`/`SpreadsheetApp`/`LockService`/`CacheService`/`PropertiesService`, and the only backend file with zero test coverage (verify it manually). It builds a `deps_()` object and hands it to the pure `Server.handleRequest(rawBody, deps)` from the generated bundle, which is how `router.js` stays testable without touching real Sheets/Google APIs. `deps.domain` is the **whole** generated `Domain` object, not a hand-listed subset: enumerating keys meant re-pasting `Code.gs` by hand every time the domain grew, and forgetting to produced a `… is not a function` in production (it happened on 2026-07-26 with `quarterCloseWindow`). Adding a domain function therefore needs `npm run build` and a fresh paste of `domain.gs` only — never `Code.gs`.

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

## Where a business rule is allowed to come from

`spec.md` is the single register of domain rules, and it has three parts that must not be confused:
**§5** the invariants in force (`INV-1`..`INV-14`), **§5.1** where each one's authority comes from
(a quoted passage of `docs/normativa.pdf`, or an explicit "extensión sin respaldo normativo"), and
**§8** the queue of *proposed* rules that are not in force yet.

Everything under `docs/` other than `normativa.pdf` and `adr/` is a **proposal**, not behaviour. A
proposal does not introduce a rule; it adds a row to §8 citing the `INV-n` it touches. Only on
reaching `aceptado` does §5 or `v2/domain/` change. Read §8 before implementing anything a `docs/`
file describes — several of those documents contradict invariants that are already implemented and
tested.

`normativa.pdf` outranks everything, including this file and `spec.md` (§0 says so explicitly).
When a proposal and an implemented invariant disagree, the question is not who wrote which, it is
what the normativa says — and it does not always side with the code: §8 records two points (P-7, P-8)
where it backs the proposal instead.

`test/docs-trazabilidad.test.js` enforces the mechanical half of this and runs inside `npm test`:
every `INV-n` cited in §8 exists in §5, every invariant in §5 has a procedencia in §5.1, every
proposal has a valid state, and **no document cites a file that does not exist**. That last one is
the important one: the `docs/` proposals were written with AI assistance and cite ten documents that
have never existed in this repo (`VACATION_IMPACT_MODEL.md`, `DOMAIN_MODEL.md`, an "SRS", a
`.docx` rule catalogue…). Citations generated for plausibility are the characteristic failure mode
here — the existing ones are frozen as known debt in the test, and any new one fails the suite.
The test checks traceability, never semantics: it cannot tell that weighted-points equity
contradicts `dif ≤ 1`. That still needs a person.

## Branch / deploy model — two people push here concurrently

`main` is both production and the shared trunk: GitHub Pages serves `index.html` from `main`, and **every push to `main` deploys live to the residents using the app**. There is no staging environment. Note that a live deploy is not limited to `client/` — the `.jsx` screens import `v2/domain/*.js` straight into the browser, so a half-finished validator change on `main` is immediately what residents run. (`server/*.gs` is the exception: it only reaches Apps Script when someone pastes it in and redeploys by hand.)

Two collaborators commit to `main` in parallel, on different areas:
- **Quique** (repo owner, `Molecule97`) — backend, domain, client: works on short `backend/*` branches and merges to `main`.
- **Agustín** (`aguslagio24`) — app design plus new business rules and variables: works on `docs/*` branches and merges via pull request.

Consequences worth internalizing, because getting them wrong has already cost real work:
- **Always `git fetch` and check `origin/main` before starting anything and again before pushing.** `main` moves without warning. A local `main` that looked current an hour ago may be behind by several merged PRs.
- **At the start of a session, read what changed since you last saw the repo** (`git log --oneline -15`, and `git log -p` on anything surprising) instead of assuming the state described in this file or in memory is still accurate. Agustín's rule/design documents in `docs/` are the most likely thing to have moved, and they often propose changes to invariants that `spec.md` and `v2/domain/` do not implement yet — a proposal in `docs/` is not the implemented behaviour, and vice versa.
- **Never resolve a divergence between `main` and another branch by overwriting a whole tree** without first checking, file by file, what only exists on the other side. The 2026-07-24 cutover nearly deleted five merged PRs of Agustín's design documents this exact way; the push was rejected for being non-fast-forward, which is the only reason it did not happen.
- Neither collaborator's area is exclusive by tooling, only by convention — nothing in the repo prevents a conflicting edit, so prefer a branch over a direct push whenever a change is not trivially safe to deploy.

**CI (`.github/workflows/test.yml`, added 2026-08-08):** runs `npm test` on every push to `main` and every PR — zero setup needed (Node built-in test runner, no deps to install/cache). It catches exactly the class of mistake that already happened twice: forgetting `npm run build` (bundle parity, `v2/domain/test/parity.test.js`) or `npm run catalogo` (design catalogue freshness, `test/catalogo.test.js`) before pushing. The workflow runs and reports red/green either way, but it does **not** block a merge by itself — that needs a branch protection rule (Settings → Branches → require the `test` check) turned on once from the GitHub UI, which needs repo-admin access neither collaborator has necessarily granted a coding agent. Until that's on, red CI is a strong signal to fix before merging, not a hard gate.
