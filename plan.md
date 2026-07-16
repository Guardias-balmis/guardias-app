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
| 3 | Cliente: trocear `index.html`, eliminar AdminScreen y todo secreto, alta con fechas, código GP, conservar diseño ([docs/auditoria/cliente-sistema-diseno.json](docs/auditoria/cliente-sistema-diseno.json)) | 🔄 En curso. Decisión C-1 tomada y verificada (ver abajo): Babel `data-type="module"` + namespaces globales + `boot.js` de espera. Backend extendido con CRUD (3.0 ✅). Base del cliente en curso (3.1) |
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

El criterio del ADR-001 R11 era "cero toolchain obligatoria". Opción elegida tras un
**smoke test empírico en navegador** (no solo documentación): mantener Babel Standalone
(ya usado en v1) para JSX, en vez de reescribir a `htm`.

- **Módulos lógicos (`.js`, sin JSX)** — `v2/domain/*.js` (reutilizados **directos**, sin
  duplicar) y `client/lib/*.js` (api, auth, design-tokens): ES modules **nativos** del
  navegador, `import`/`export` normal. Cero Babel.
- **Módulos de vista (`.jsx`)** — cargados como
  `<script type="text/babel" data-type="module" src="...">`. Verificado: SÍ pueden
  `import` un módulo `.js` plano (Babel deja pasar el import, el navegador lo resuelve),
  pero **NO pueden importarse entre sí** (Babel no resuelve ese grafo — un `.jsx` que
  importe otro `.jsx` falla con `SyntaxError` porque el navegador lo carga crudo, sin
  transpilar). Composición cruzada vía **namespaces globales**: `window.UI.*`
  (componentes compartidos) y `window.Screens.*` (pantallas).
- **`client/boot.js`** — un script de módulo nativo que **espera** (sondeo con
  `requestAnimationFrame`, sin dependencias) a que todos los globals necesarios existan
  antes de llamar a `ReactDOM.render`. Necesario porque un `<script type="module">`
  insertado dinámicamente por Babel (no parseado en el HTML) es `async` por defecto → el
  navegador NO garantiza que se ejecuten en el orden de aparición en el HTML. Verificado
  con un smoke test real (racecondition reproducida y resuelta).
- **Alternativa descartada:** `data-plugins="transform-modules-umd"` con orden de carga
  manual — funciona pero es más frágil (hay que mantener el orden a mano) y añade
  configuración de plugin. El patrón de namespace + boot-wait es más simple de razonar
  para un mantenedor futuro y **falla alto** (si falta un fichero, `boot.js` lo dice por
  nombre tras un timeout, no un `undefined` críptico en un punto aleatorio del render).

## Convenciones de trabajo

- Rama `v2` para todo el desarrollo; `main` es producción de Pages y no se toca hasta el corte.
- TDD estricto en dominio y en servidor: el test se escribe y falla antes de implementar.
  El cliente sigue el mismo estándar donde es testeable en Node (lib/api, lib/auth); las
  pantallas JSX se verifican con pruebas E2E en navegador (Fase 3.4).
- `npm test` = dominio + servidor + `client/lib` — sin dependencias, Node ≥ 20.
- `npm run build` regenera `server/domain.gs` y `server/server-lib.gs` (nunca a mano).
- Commits en español; código en inglés; JSDoc de dominio en español con referencia a la normativa.
