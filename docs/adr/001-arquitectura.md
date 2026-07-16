# ADR-001 · Arquitectura de `guardias-app` v2 («perpetua»)

- **Estado:** **ACEPTADA** (2026-07-16). El autor ratificó: variante de backend **A′** (Apps Script en la cuenta del servicio), migración del repo a una **organización de GitHub** (pendiente de que el autor la cree), e inicio de la **Fase 1**.
- **Fecha:** 2026-07-16 (revisión 2 — incorpora las respuestas del autor y la verificación de hechos de plataforma del Anexo A).
- **Autor de la app:** R3 de Radiodiagnóstico, HGU Dr. Balmis (Alicante). Se marcha en 2028.
- **Requisito rector:** la app debe **sobrevivir a su autor** ≥10 años sin administrador, sin rotación de tokens y sin gestión manual de residentes.

---

## 0. Resumen para quien tiene prisa

Stack Google confirmado: **Google Sheets** (dato + entregable) con **pestañas de datos normalizadas por UUID** y **una pestaña por mes** como proyección; **la SPA React actual en GitHub Pages** (ya sirve en `molecule97.github.io/guardias-app`); **Google OAuth** solo con scopes básicos; **Airtable retirado**.

Tres decisiones del autor cambian la revisión 1:

1. **No habrá API de Anthropic, nunca** (no se financia). El generador IA pasa de «botón con fallback» a **diseño principal por «prompt portátil»**: la app monta el prompt con todo el contexto (contaje acumulado del año, bloqueos, normas), el responsable lo pega en claude.ai con su propia cuenta, pega la respuesta JSON de vuelta, y **el validador de invariantes (Fase 1) la comprueba antes de aceptarla**. Esto *mejora* la durabilidad: desaparece el único secreto de terceros y el único coste recurrente.
2. **Existe una cuenta Google del servicio** (departamental, no personal). Acceso pendiente de protocolo con los compañeros. El Sheet vivirá ahí **sea cual sea la variante de backend** — es la única identidad Google duradera disponible.
3. **El repo es `github.com/Molecule97/guardias-app`** (público, personal, con Pages activo sobre `main`). Trabajo directo ahí para que los compañeros puedan editar.

Con (1) y (2), la comparación backend cambia respecto a la revisión 1: **Apps Script bajo la cuenta del servicio (variante A′) logra CERO secretos almacenados** — el script escribe en su propio Sheet sin credencial material alguna — mientras que el proxy serverless (Plan B, preferencia inicial del autor) **no elimina la dependencia de la cuenta Google** (el Sheet la necesita igual) y **añade** una cuenta Cloudflare más una clave JSON de service account de larga vida. Recomendación: **A′**, con B documentado como plan de contingencia (§4).

---

## 1. Fuentes leídas y confirmaciones

**Normativa** (`docs/normativa.pdf`, 4 pp., leída íntegra): confirma INV-1…INV-11. Fija: equidad medida *al final de cada año de residencia* por año formativo → `PeriodoFormativo` con ventana propia; compensación *entre meses* → el generador necesita el acumulado anual; nota [a] (bajas/embarazo se descuentan proporcionalmente) → derivación por **fechas**, no año-entero; responsable R3 enero→enero, sorteo sin voluntarios, entregable a Raquel (Coordinación de Técnicos).

**Excel** (`docs/guardias_radiodiagnostico_balmis_v2.xlsm`, 7 hojas, leído entero con fórmulas):

| Hallazgo verificado | Consecuencia |
|---|---|
| `GP` existe (`Instrucciones!A15`) — el bug de `CODES_CYCLE` es solo del cliente | Añadir GP en el cliente nuevo |
| Promoción por fórmula `Residentes!C6` sobre año de entrada (entero) | Valida «derivar > almacenar»; v2 deriva de **fechas** |
| Trimestres por rango de fila (`$B$3:$B$59`=T1 … `$B$174:$B$230`=T4) | Desalineación silenciosa al insertar el residente 16 → estructura 1-pestaña-por-mes |
| `_xlfn.MAXIFS` y `SUMPRODUCT` matriciales (fines de semana y doblete V-D) | Verificar tras portar a Sheets |
| `Tercer Puesto` e `Imaginaria` con nombres **literales** copiados a mano | Segunda identidad que se pudre → todo se proyecta desde UUID |
| 15 huecos fijos, 15 residentes | Desborda en 2027 |

**Cliente** (`index.html`, 1.361 líneas, leído entero + auditoría en `docs/auditoria/`): confirma §1 del brief y añade:

- **El login actual no autentica nada**: *implicit flow* → userinfo; el rol se decide en el cliente; el modo demo concede admin a quien escriba «admin» en el email (l. 322). La «protección» de AdminScreen es solo que el botón no se pinta.
- **`AIScreen` no puede funcionar hoy**: llama a `api.anthropic.com` sin API key ni header de versión (l. 900) — 401 siempre. Y el resultado nunca se escribe en el cuadrante.
- **Bug de desfase +1 mes**: `getDaysInMonth`/`getWeekday` (l. 66-84) mapean Junio→mes 6, que en JS 0-based es **julio**; todo el calendario pinta los días de semana del mes siguiente (junio 2026 saldría empezando en miércoles; el Excel dice, correctamente, lunes). `navMes` además cambia de año en el borde Junio/Mayo de forma incoherente con ese mapeo.
- Cuadrante indexado por **nombre** (l. 685) — identidad por nombre también en el cliente.
- Pages ya sirve `main` en producción: **cada push a `main` es un despliegue**.

Sistema de diseño extraído a `docs/auditoria/cliente-sistema-diseno.json` (paleta con roles semánticos, escala de azules por año R4→R1, colores por código de guardia, componentes) — es la spec de «conserva el diseño visual actual» para la Fase 3.

---

## 2. Decisiones cerradas por el autor (2026-07-16)

| # | Decisión | Consecuencia arquitectónica |
|---|---|---|
| D-A | **Sin API de Anthropic, definitivo** | Generador por «prompt portátil» (§6). Cero secretos de terceros en todo el sistema. La IA es asistente opcional; el validador es el que manda. |
| D-B | **Cuenta Google del servicio disponible** (acceso pendiente de protocolo) | El Sheet y (en A′) el script viven ahí. Desbloquea el «gate de propiedad» de la revisión 1. |
| D-C | **Repo público personal `Molecule97/guardias-app`**, main = producción Pages | Desarrollo de v2 sin tocar `index.html` hasta el corte (§7-R7). Colaboradores por invitación; decisión pendiente sobre org (§7-R6). |

---

## 3. Arquitectura (variante A′ recomendada)

| Capa | Elección | Nota |
|---|---|---|
| Datos (fuente de verdad) | Pestañas normalizadas del Sheet: `residentes`, `periodos`, `bloqueos`, `asignaciones`, `responsables`, `sorteos` — clave **UUID**, append-only, rangos protegidos | El historial es sagrado; `activo` y `nivel` se derivan de fechas |
| Entregable | Pestañas `Jun`…`May` + `Resumen Anual` + `Contaje Trimestral` — **proyección idempotente** al publicar | Estructura decidida en el brief §7; elimina el bug de trimestres posicionales |
| Servidor | **Apps Script Web App** en la cuenta del servicio: `executeAs: USER_DEPLOYING`, acceso `ANYONE_ANONYMOUS` (en la UI: «Anyone») | Verificado (Anexo A-2): ejecuta como propietario; `Session.getActiveUser()` NO identifica al llamante → autenticación propia (§5) |
| Cliente | SPA React actual troceada, GitHub Pages | v2 se desarrolla sin pisar producción (§7-R7) |
| Identidad | Google OAuth, **solo scopes `openid email profile`**, consent screen **«In production»** | Verificado (A-5): sin verificación de Google, sin límite de usuarios, sin pantalla de «app no verificada». El OAuth client se recrea en un proyecto GCP **de la cuenta del servicio** |
| Secretos | **Ninguno externo.** Solo un HMAC autogenerado en `PropertiesService` para tokens de sesión (§5) | Nunca visto por humanos; regenerable sin coste (solo re-loguea a los usuarios) |
| IA | Sin API. «Prompt portátil» (§6) | |
| Airtable | Retirado | |

**Hexagonal estricta**: núcleo puro (`nivel`, `grupo`, `contaje`, validador de invariantes) sin I/O, ejecutable idéntico en cliente y servidor; Sheets, Google Auth y el parseo del JSON de la IA son adaptadores.

---

## 4. A′ (Apps Script en cuenta del servicio) vs B (proxy serverless) — el desacuerdo pendiente

El autor expresó preferencia inicial por B («si lo podemos hacer sin cuenta personal/institucional, mejor»). Tras las decisiones D-A/D-B, mi análisis es que **B no consigue ese objetivo** — y A′ queda estrictamente mejor en la métrica que importa (superficie heredable):

| Métrica (horizonte 10 años) | **A′: Apps Script** | **B: Cloudflare Worker** |
|---|---|---|
| Cuentas que mantener vivas | **2** (Google servicio, GitHub) | **3** (Google servicio, GitHub, Cloudflare) |
| El Sheet necesita la cuenta del servicio | Sí | **Sí, igualmente** — B no la elimina |
| Secretos almacenados de larga vida | **0** (el script escribe su propio Sheet; HMAC interno autogenerado) | **1**: clave JSON de service account GCP con acceso de escritura al Sheet, guardada en Cloudflare |
| Verificación del ID token | `tokeninfo` + sesión HMAC — verificado viable (A-1), con matices | WebCrypto RS256 nativo (mejor) |
| Plataformas que un sucesor debe conocer | 1 (todo Google) | 2 (Google + Cloudflare/wrangler) |
| Garantía del tier gratuito | Cuotas Apps Script holgadas ~100× (A-3) | Free tier estable desde 2019, sin tarjeta (A-7), pero ToS «a discreción» |
| Latencia | ~1-2 s por llamada (aceptable a 15 usuarios) | <100 ms |

**Recomendación: A′.** El único punto donde B gana con claridad (criptografía de librería) queda neutralizado por el patrón `tokeninfo` verificado en A-1. El punto donde A′ gana es exactamente el requisito rector: menos cuentas, **cero material de credencial** que pueda filtrarse, caducar o necesitar rotación, y una sola plataforma que documentar para el sucesor. **B queda como plan de contingencia documentado** si Apps Script degradara su servicio o si la cuenta del servicio finalmente no llegara.

*(Plan C — cliente escribe directo al Sheet — sigue rechazado: no puede imponer roles ni el flujo BORRADOR→VALIDADO→PUBLICADO, y tiene carrera de escritura. Queda como modo degradado implícito: el Sheet editable a mano.)*

---

## 5. Autenticación (patrón cerrado, con los matices verificados)

1. Cliente: «Sign in with Google» (GIS) → obtiene **ID token** (JWT). *Sustituye al implicit flow actual.*
2. Cliente → `doPost` con el ID token. **Gotcha CORS conocido**: enviar como `Content-Type: text/plain` con el JSON serializado (petición «simple», sin preflight OPTIONS que Apps Script no atiende). *Pendiente de spike en Fase 2.*
3. Servidor (Apps Script): `UrlFetchApp` → `https://oauth2.googleapis.com/tokeninfo?id_token=…`. Verificado (A-1): valida **firma, `iss` y `exp`**, pero **NO la audiencia** → el script **debe comparar `aud` con el client ID** (comparación de strings). 1-2 reintentos con backoff (`muteHttpExceptions`), porque Google lo clasifica como endpoint de debugging con throttling posible. **Desviación aceptada y documentada**: a 15 usuarios y ~1 llamada por login, el riesgo es bajo y evita criptografía RS256 artesanal en Apps Script.
4. Servidor: resuelve `email` (verificado `email_verified`) → residente por email en el Sheet → emite **token de sesión propio** (HMAC-SHA256 con `Utilities.computeHmacSha256Signature`, secreto autogenerado en `PropertiesService`, TTL corto). Las siguientes llamadas validan el HMAC sin tocar la red.
5. Roles derivados, nunca almacenados como flag de UI: `responsable` = quien diga la tabla `responsables` para la fecha actual; todo lo demás, residente activo. **No existe rol admin.**
6. El endpoint es públicamente invocable (acceso `ANYONE_ANONYMOUS`): toda entrada se trata como hostil, todo write pasa por `LockService` (único escritor serializado).

---

## 6. Generador sin API: «prompt portátil»

Flujo de Fase 6 rediseñado como principal (no fallback):

1. La app (cliente o servidor) monta el **paquete de generación**: normas + invariantes en texto, residentes activos con nivel derivado, **contaje acumulado del año en curso por residente** (obligatorio para INV-3), bloqueos DURO/BLANDO del mes, festivos, y el **formato JSON estricto de respuesta** con instrucciones de reintento.
2. El responsable lo copia con un botón → lo pega en **claude.ai con su propia cuenta** (gratis) → copia el JSON de respuesta → lo pega en la app.
3. La app parsea con tolerancia (limpia fences, valida esquema) y **ejecuta el validador de invariantes**. Violaciones → lista explícita; el responsable corrige a mano en el cuadrante o repite el ciclo pegando las violaciones como feedback.
4. Solo un cuadrante **sin violaciones duras** puede pasar a `VALIDADO`; la traza (quién, cuándo, con qué resultado del validador) se registra en el Sheet.

Propiedades: cero coste, cero secretos, funciona con cualquier LLM futuro (el prompt es texto), y **la pieza que impone la normativa es nuestra** (el validador puro de Fase 1), no el modelo. Si claude.ai desaparece, el flujo degrada a rellenar el cuadrante a mano con el mismo validador comprobándolo.

---

## 7. Riesgos y decisiones operativas (actualizado con el Anexo A)

| # | Riesgo verificado | Mitigación |
|---|---|---|
| R1 | Cuenta Google del servicio inactiva >2 años → borrado total (A-4). Las ejecuciones del script **NO cuentan** como actividad; el login humano sí | **Ritual anual del responsable** (enero, al asumir el mandato): iniciar sesión en la cuenta del servicio, abrir Gmail y el Sheet. Documentado en el runbook de traspaso. Email de recuperación monitorizado. Margen 2× sobre el umbral |
| R2 | **Google borra OAuth clients con ≥6 meses sin token exchanges** (aviso 30 días por email, restauración 30 días) (A-5) | Con uso mensual real no ocurre. El email del owner (cuenta del servicio) debe leerse — cae dentro del ritual R1. Documentar recreación del client como procedimiento |
| R3 | Proyecto GCP borrado = client ID muerto sin recuperación a los 30 días (A-5) | OAuth client en proyecto GCP **de la cuenta del servicio**; considerar segundo owner del proyecto |
| R4 | `tokeninfo` es endpoint «de debugging» con throttling posible (A-1) | Reintentos + sesión HMAC (1 llamada por login, no por request). Desviación documentada |
| R5 | Triggers de Apps Script se desactivan solos con el tiempo | **Nada crítico depende de triggers**: promoción derivada en lectura, publicación por evento (al validar). Un trigger muerto no rompe nada |
| R6 | **Transferir el repo a una org NO redirige la URL de Pages** (A-6, refutado el supuesto de la rev. 1) | Decidir **ahora**, antes de que existan marcadores: (a) crear org gratuita ya y mover el repo (la URL cambia hoy, que no duele), o (b) quedarse en la cuenta personal + **configurar sucesor** en GitHub Settings y ≥1 colaborador con write. GitHub **no** borra cuentas por inactividad (A-6) |
| R7 | `main` = producción Pages | v2 se desarrolla en rama `v2` (o subcarpeta `v2/`); `index.html` de producción no se toca hasta el corte final |
| R8 | Sheets no transaccional | Único escritor (Apps Script) + `LockService` |
| R9 | `MAXIFS`/`SUMPRODUCT` matricial al portar a Sheets | Verificación explícita en Fase 7; la red de seguridad real es el validador, no las fórmulas |
| R10 | clasp semiabandonado 2022-2025, hoy activo (v3.3.0, mar-2026) (A-8) | clasp solo como conveniencia de versionado; el editor web y la Apps Script API son las vías de respaldo. Script en JS plano, sin TypeScript |
| R11 | Sin build system vs «trocear en módulos» (Fase 3) | Tensión real: Vite+Actions es lo primero que se pudre en 10 años. Opciones: ES modules nativos sin build (React sin JSX vía `htm`, ~3 KB) vs mantener single-file mejor organizado. **Se decide en Fase 3**, criterio: cero toolchain obligatoria |

---

## 8. Principio de degradación digna (sin cambios — es el criterio transversal)

> No perseguimos «automatización que dure 10 años» — todo se pudre. Perseguimos **«automatización cuyo modo de fallo es la hoja de cálculo que ya usan hoy»**.

El Sheet entregable es un cuadrante correcto y autónomo (totales y fórmulas propias, estructura 1-pestaña-por-mes). Si mueren backend, cliente y claude.ai a la vez, los residentes abren el Sheet y siguen a mano, para siempre. Escalones: app completa → app sin IA (validador + edición manual) → Sheet a mano. En ningún escalón se pierde historial. El validador puro de Fase 1 es el activo más duradero del proyecto.

---

## 9. Definition of Done — cobertura con A′ y decisiones D-A/D-B/D-C

| DoD | Estado de diseño |
|---|---|
| 1 · Alta de R1 autoservicio sin nivel asignado | ✅ formulario alta → fila UUID; nivel derivado de fechas |
| 2 · Ascenso automático en junio; R4 desaparecen conservando historial | ✅ derivación pura en lectura; nunca se borra una fila |
| 3 · Cero secretos en el navegador | ✅ **cero secretos en todo el sistema** (D-A + A′) |
| 4 · Validador rechaza cuadrante inválido, venga de IA o humano | ✅ mismo validador puro en cliente y servidor; gate de `VALIDADO` |
| 5 · Cuadrante validado aparece en el Sheet sin intervención | ✅ proyección idempotente al validar |
| 6 · Sorteo R3 recomputable por terceros | ✅ semilla+candidatos+fecha en el Sheet; algoritmo determinista publicado en el repo |
| 7 · El autor desaparece mañana y nada se rompe | ✅ con el runbook §7 (R1, R2, R6) y la cuenta del servicio como propietaria |

---

## 10. Anexo A — Verificación de hechos de plataforma (2026-07-16)

Verificados contra documentación oficial vigente por agentes de investigación independientes; fuentes citadas.

| # | Hecho | Veredicto | Fuente principal |
|---|---|---|---|
| A-1 | `tokeninfo` valida firma/`iss`/`exp` de un ID token server-side; **no valida `aud`** (hazlo tú); documentado para debugging, throttling posible | MATIZADO | developers.google.com/identity/gsi/web/guides/verify-google-id-token |
| A-2 | Web App `executeAs: USER_DEPLOYING` + `ANYONE_ANONYMOUS` ejecuta como propietario para llamantes anónimos; `Session.getActiveUser()` vacío para Gmail de consumo; cuentas gratuitas pueden publicar Web Apps | CONFIRMADO | developers.google.com/apps-script/guides/web · /reference/base/session |
| A-3 | Cuotas consumer: UrlFetch 20k/día (las entrantes a doGet/doPost **no** cuentan), 6 min/ejecución, Properties 500 KB total, sin cuota diaria de SpreadsheetApp. A nuestra escala: margen ~100× | CONFIRMADO | developers.google.com/apps-script/guides/services/quotas |
| A-4 | Cuentas personales (incl. gmail compartida de departamento): borrado tras 2 años de inactividad; **ejecuciones de script no cuentan como actividad**; login humano sí; avisos meses antes al email y al de recuperación | CONFIRMADO | support.google.com/accounts/answer/12418290 |
| A-5 | Solo scopes básicos ⇒ sin verificación ni pantalla de «no verificada» **si está In production** (en Testing, cap de 100 test users aplica igual). **OAuth clients con ≥6 meses sin uso se borran automáticamente** (aviso 30 días). Proyecto GCP borrado: 30 días de recuperación, después el client ID muere para siempre | MATIZADO | support.google.com/cloud/answer/13463073 · /answer/15549945 |
| A-6 | GitHub no borra cuentas por inactividad (no existe «Dormant Accounts Policy» vigente; la Username Policy dice lo contrario). Pages: límites blandos irrelevantes a nuestra escala. **Transferir repo a org NO redirige la URL de Pages**. Existe figura de «successor» en Settings | MATIZADO | docs.github.com/site-policy · /pages/…/github-pages-limits |
| A-7 | Cloudflare Workers Free: 100k req/día, sin tarjeta, sin recortes desde 2019, sin purga por inactividad documentada; pero ToS «a discreción», sin garantía contractual | MATIZADO | developers.cloudflare.com/workers/platform/limits |
| A-8 | clasp activo (v3.3.0, 12-mar-2026) tras hueco 2022-2025; opcional por diseño (editor web + Apps Script API como respaldo); v3 ya no transpila TypeScript | CONFIRMADO | github.com/google/clasp/releases |

Auditorías del cliente en `docs/auditoria/` (inventario funcional y sistema de diseño extraído).

---

## 11. Cierre de la Fase 0 (2026-07-16)

Decisiones ratificadas por el autor: **A′** (§4), **organización de GitHub ahora** (§7-R6) y **arranque de la Fase 1**.

Acciones pendientes que no bloquean el desarrollo:
1. El autor crea la organización de GitHub y se transfiere el repo (la URL de Pages cambia una sola vez, ahora que no le importa a nadie).
2. Acceso a la cuenta Google del servicio cuando el protocolo lo permita (la Fase 2 se desarrolla con cuenta de desarrollo y se re-despliega en ~10 minutos).
