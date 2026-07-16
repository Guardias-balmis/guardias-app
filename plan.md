# plan.md · Hoja de ruta de guardias-app v2

> Artefacto versionado. Cada fase termina con: tests en verde, `spec.md`/`plan.md` actualizados y
> puerta de consistencia (¿el código contradice la spec? ¿la spec contradice la normativa?).
> No se avanza de fase sin aprobación del autor.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 0 | ADR de arquitectura ([docs/adr/001-arquitectura.md](docs/adr/001-arquitectura.md)) | ✅ **Aceptada** (2026-07-16): stack Google, variante A′ (Apps Script en cuenta del servicio), sin API de Anthropic (generador «prompt portátil»), org de GitHub |
| 1 | **Núcleo de dominio, TDD estricto** — `calendar`, `residents` (nivel/grupo), `tally` (contaje), `validate`/`thirdpost`/`equity` (INV-1..11). Cero I/O | ✅ **Completa** (rama `v2`): 118 tests en verde, cero dependencias. Pendiente puerta de consistencia y aprobación del autor para Fase 2 |
| 2 | Backend Apps Script: verificación de identidad (tokeninfo + sesión HMAC), roles derivados, adaptador de Sheets, `LockService` | ✅ **Código completo** (2.0-2.5), 164 tests en verde. Falta solo **2.6 (despliegue + E2E)**, que necesita la cuenta del servicio ([server/README-deploy.md](server/README-deploy.md)). Bundler+paridad (D-4), sesión HMAC, verificación del ID token, adaptador de Sheets crash-safe, router y `Code.gs` fino |
| 3 | Cliente: trocear `index.html`, eliminar AdminScreen y todo secreto, alta con fechas, código GP, conservar diseño ([docs/auditoria/cliente-sistema-diseno.json](docs/auditoria/cliente-sistema-diseno.json)) | ✅ **Completa y probada E2E en navegador real** (rama `v2`): backend extendido con CRUD (3.0), arquitectura sin build (3.1, decisión C-1 revisada tras E2E — ver abajo), App/Login/Home (3.2), Calendar/Prefs/Generator/Settings (3.3), verificación de fidelidad + E2E (3.4): login real (stub de Google en dev), alta autoservicio, cuadrante con guardado/validación local, preferencias, generador, ajustes — todo contra el backend real (`server/dev-server.mjs`) |
| 4 | Preferencias como calendario de fechas concretas, DURO vs BLANDO en UI | ⬜ |
| 5 | Responsable R3: sorteo auditable (semilla+candidatos+fecha recomputables), voluntario > sorteo, mandato enero→enero | ⬜ |
| 6 | Generador «prompt portátil» + validación: prompt con contaje acumulado y bloqueos → claude.ai manual → JSON de vuelta → validador → BORRADOR→VALIDADO→PUBLICADO | ⬜ |
| 7 | Publicación a Sheets: proyección idempotente, 1 pestaña/mes, totales por pestaña, Resumen/Contaje agregando por nombre de hoja; verificar MAXIFS/SUMPRODUCT | ⬜ |

## Acciones externas pendientes (no bloquean)

| Acción | Quién | Cuándo |
|---|---|---|
| Crear organización de GitHub y transferir el repo (la URL de Pages cambia UNA vez, ahora que no duele) | Autor (crear org) → Claude (transferencia y remotos) | Cuanto antes |
| Acceso a la cuenta Google del servicio (protocolo con compañeros) | Autor | Antes del despliegue de Fase 2 |
| Ritual anual documentado: login en la cuenta del servicio (enero, responsable entrante) | Runbook (Fase 2) | Cada enero |

## Decisión C-1 · Arquitectura del cliente sin build (Fase 3)

El criterio del ADR-001 R11 era "cero toolchain obligatoria". Se mantiene Babel Standalone
(ya usado en v1) para JSX, en vez de reescribir a `htm`. **Revisada dos veces**: un smoke
test aislado (2 ficheros) validó el patrón inicial; el E2E completo (8 ficheros reales, Fase
3.4) encontró que ese patrón inicial no aguantaba a esa escala, y forzó el diseño actual.

- **Módulos lógicos (`.js`, sin JSX)** — `v2/domain/*.js` (reutilizados **directos**, sin
  duplicar) y `client/lib/*.js` (api, auth, design-tokens): ES modules **nativos**,
  `import`/`export` normal. Cero Babel.
- **Módulos de vista (`.jsx`)** — Babel transpila cada uno (`Babel.transform`, la API
  núcleo) y se registran en namespaces globales: `window.UI.*` (componentes compartidos) y
  `window.Screens.*` (pantallas) — Babel no resuelve imports entre ficheros `.jsx`, así que
  la composición cruzada usa esos namespaces, nunca `import`.
- **Los imports DENTRO de un `.jsx` se escriben relativos a la RAÍZ del sitio**
  (`"./client/lib/design-tokens.js"`, `"./v2/domain/calendar.js"`), no al propio fichero.
  Motivo verificado en el E2E: Babel inyecta el código transpilado como script **en
  línea** (sin URL propia), así que el navegador resuelve sus imports relativos contra la
  URL del **documento** (`index.html`), no contra la ruta del `.jsx` original.
- **`client/loader.js`** (sustituye a un `boot.js` de sondeo, descartado tras el E2E): cada
  `.jsx` se `fetch()`, se transpila con `Babel.transform`, sus imports relativos se
  reescriben a absolutos (`new URL(spec, document.baseURI)` — un `import()` de un `blob:`
  URL no puede resolver imports relativos por sí solo: "base scheme isn't hierarchical"),
  y se carga con `import()` de un Blob URL — **uno a uno, en secuencia, con `await`**.
  Verificado por qué hace falta ser tan explícito: **Babel Standalone, al procesar 8
  `<script data-type="module" src="...">` automáticamente, pierde uno EN SILENCIO** (sin
  error en consola) — reproducido en un navegador real, no es una suposición. El código
  transpilado era correcto (inyectarlo a mano funcionaba); el problema es solo el escaneo
  automático de Babel Standalone a esa escala. `loader.js` no depende de ese escaneo:
  cada fallo se atribuye a un fichero concreto y se muestra en pantalla.
- **Alternativas descartadas:** `data-plugins="transform-modules-umd"` con orden manual
  (más configuración, incluso así no resuelve la pérdida silenciosa de ficheros); el
  `boot.js` de sondeo original (resolvía el orden de ejecución pero no la pérdida de
  ficheros — sondeaba para siempre sin decir cuál faltaba hasta el timeout).

## Convenciones de trabajo

- Rama `v2` para todo el desarrollo; `main` es producción de Pages y no se toca hasta el corte.
- TDD estricto en dominio y en servidor: el test se escribe y falla antes de implementar.
  El cliente sigue el mismo estándar donde es testeable en Node (lib/api, lib/auth); las
  pantallas JSX se verifican con pruebas E2E en navegador (Fase 3.4).
- `npm test` = dominio + servidor + `client/lib` — sin dependencias, Node ≥ 20.
- `npm run build` regenera `server/domain.gs` y `server/server-lib.gs` (nunca a mano).
- Commits en español; código en inglés; JSDoc de dominio en español con referencia a la normativa.
