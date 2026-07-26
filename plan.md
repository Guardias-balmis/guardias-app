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
| 4 | Preferencias como calendario de fechas concretas, DURO vs BLANDO en UI | ✅ **Completa y probada E2E**: backend de bloqueos (crearBloqueo/misBloqueos/listBloqueos/cancelarBloqueo, decisión V-6), Prefs.jsx rediseñado (rejilla de fechas BLANDA + sección de Bloqueos DURA con acento visual propio), y **Calendar.jsx ahora sí valida INV-5/6/7** (antes del cierre de esta fase el botón Validar no llegaba a comprobarlos — bug encontrado en el propio E2E, no en revisión de código) |
| 5 | Responsable R3: sorteo auditable (semilla+candidatos+fecha recomputables), voluntario > sorteo, mandato enero→enero | ✅ **Completa y probada E2E en navegador real** (rama `v2`): dominio `v2/domain/responsible.js` (INV-14, 19 tests, decisión V-7), backend (tabla `responsables` con `voluntarios`, tabla nueva `voluntariosResponsable`, acciones estadoResponsable/ofrecerseResponsable/retirarVoluntariadoResponsable/ejecutarSorteoResponsable/listResponsables, fix de `resolveRol` a `readLatest`), cliente (`Responsable.jsx`, alcanzable desde Settings). E2E con 4 residentes reales probó las 3 ramas del algoritmo (voluntario único, sorteo sin voluntarios, sorteo entre ≥2 voluntarios excluyendo al no-voluntario) y encontró 1 bug real (botón invisible por color igual al fondo de página) — corregido. **Fase 5.x (ajuste post-cierre):** decisión V-8 — solo BAJA sigue bloqueando la asignación (INV-5); VACACIONES/ROTACION pasan a informativas (no violan, siguen alimentando INV-2/6/7 y equidad); se retira `Preferencias.fechasPreferidas` de esquema y UI; corrige una contradicción real preexistente (INV-7 exigía guardia en periodo de rotación mientras INV-5 la prohibía, nunca detectada porque los tests de INV-7 no comprobaban INV-5) |
| 6 | Generador «prompt portátil» + validación: prompt con contaje acumulado y bloqueos → claude.ai manual → JSON de vuelta → validador → BORRADOR→VALIDADO→PUBLICADO | ✅ **Completa (6.1 + 6.2)**, decisión V-9: fase troceada — 6.1: `v2/domain/accumulate.js` (contaje acumulado, reusa `periodOn` nuevo en `residents.js`), acción de backend `listAsignacionesRango`, `Generator.jsx` inyecta contaje acumulado y bloqueos reales en el prompt y por fin valida INV-5/6/7 en `comprobar()`. Bug real preexistente de Fase 4 encontrado y corregido: `Calendar.jsx` tampoco cumplía el contrato C-2 (INV-7 no veía meses anteriores de una rotación en curso). Cerrada con puerta de consistencia de 4 agentes que encontró y corrigió 4 fallos reales más (duplicado de días 1-2 en `comprobar()`, `desde` del histórico mal calculado para C-2, fallo silencioso de red que podía saltarse INV-5, condición de carrera en `Calendar.jsx` al cambiar de mes durante `validar()`). 265 tests en verde, verificado E2E en navegador real, más 6 fallos reales corregidos en una segunda pasada de 8 agentes sobre el diff ya empujado (271 tests). 6.2: ciclo de estados BORRADOR→VALIDADO→PUBLICADO — `v2/domain/cuadrante.js` (`canValidate`/`canPublish`/`canUnpublish`/`canEdit`/`stateAfterEdit`) y `buildMonthContext` compartido en `validate.js`; backend con tabla `cuadrantes` append-only y 4 acciones nuevas (`marcarValidado` revalida en servidor, nunca confía en el cliente); `guardarAsignaciones` bloquea ediciones PUBLICADO y revierte VALIDADO→BORRADOR al guardar; cliente con badge de estado y botones Validar/Publicar/Despublicar en `Calendar.jsx`, bloqueo de "Aplicar" en `Generator.jsx`. Decisiones del autor antes de empezar (V-10): BORRADOR→VALIDADO automático al validar sin errores (solo Responsable), editar un VALIDADO revierte a BORRADOR sin fricción, PUBLICADO se puede despublicar para corregir. Cerrada con puerta de consistencia de 8 agentes en paralelo que encontró y corrigió: nombres de dominio en español (violaba S-7), triple reimplementación del ctx de `validateMonth` y del guard de rol/estado en el router, `guardarAsignaciones` parseando fechas a mano en vez de `parseISO`, el mismo bug de "fallo de red silenciado como BORRADOR" que ya se había corregido en 6.1 pero reapareció en dos pantallas nuevas, y dos condiciones de carrera reales en `Calendar.jsx` (botón Publicar no bloqueado durante Validar; edición no bloqueada durante un guardado en vuelo). 301 tests en verde, verificado E2E en navegador real (ciclo completo BORRADOR→VALIDADO→PUBLICADO→despublicar) |
| 7 | Publicación a Sheets: proyección idempotente, 1 pestaña/mes, totales por pestaña, Resumen/Contaje agregando por nombre de hoja; verificar MAXIFS/SUMPRODUCT | 🟡 **7.1 código completo (sábado, sin acceso aún a la cuenta del servicio — "adelantemos lo que podamos"; decisión V-9b/V-11)**: `v2/domain/projection.js` (`buildMonthSheetRows`/`buildResumenRows`, 23 tests) + `publicarCuadrante` ahora proyecta de verdad vía `store.rebuildSheet` (Fase 2, sin invocador hasta hoy) ANTES de escribir el estado PUBLICADO (un fallo de Sheets deja el cuadrante en VALIDADO, nunca un PUBLICADO fantasma); `despublicarCuadrante` no toca el Sheet. Cerrada con puerta de consistencia de 4 agentes que encontró y corrigió un bug real (`origen` cedida/comprada no se excluía de los totales, contradiciendo INV-4 — ahora se marca "G*" en la celda para que COUNTIF/SUMPRODUCT la excluyan) y añadió 7 tests nuevos de router (valor exacto de celda, aislamiento entre meses, fallo parcial tras escribir la pestaña mensual, reintento que sana del todo). 331 tests en verde. **Verificación en vivo iniciada 2026-07-21** (acceso concedido): 2.6 desplegado por el autor (GET /exec, login GIS, alta autoservicio funcionando de verdad). Encontró un bug real de la capa de almacenamiento (Fase 2, no de la 7.1 en sí): Google Sheets autoconvierte un string `"YYYY-MM-DD"` a tipo Fecha interno, y `SpreadsheetApp.getValues()` devolvía un `Date` real en vez del string, rompiendo `parseISO` en cascada (pantalla en blanco tras la primera alta real) — corregido en `sheets-schema.js` (nuevo tipo de columna `"date"`, apóstrofe al escribir + recuperación desde `Date` al leer, ver spec.md §7), 4 tests nuevos, 335 tests en verde. **Verificado en vivo el mismo día**: autor repegó `server-lib.gs`, desplegó nueva versión, confirma que login/alta funcionan ya contra el Sheet real. Pendiente: terminar de verificar el resto de la Fase 7.1 (publicar un cuadrante de prueba) contra el Sheet real. Contaje Trimestral (la pestaña) sigue pendiente. **7.2 (equidad trimestral, P-8/decisión V-13) hecha**: `validateQuarterClose` en `v2/domain/equity.js` (solo el eje `total`, severidad aviso, por lectura literal de la frase de p.2 de la normativa) + `trimesterWindow` en `calendar.js`, y los DOS cierres de INV-3 (trimestral y anual) conectados por fin al flujo real — `marcarValidado` en el servidor y `Calendar.jsx` vía `client/lib/closes.js`; hasta ahora el cierre anual estaba implementado desde la Fase 3 sin que lo invocara nadie. Acción nueva `listBloqueosRango`, `accumulate.js` incorporado al bundle, 34 tests nuevos, 378 en verde. **Decisión V-14 (2026-07-26)**: la equidad NUNCA bloquea — INV-3 (los dos cierres) e INV-8 pasan a `aviso` y validar incumpliéndolos exige confirmación explícita en la UI; **decisión V-15**: P-7 rechazada, los dos «grupos» de la normativa son composición (INV-1), no dos cuadrantes, así que el modelo de datos no cambia. 393 en verde. INV-2 (4-6 guardias/mes) baja también a `aviso` en las dos direcciones: p.2 llama a esas cifras «orientativas» |

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
