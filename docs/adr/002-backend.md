# ADR-002 · Backend Apps Script (Fase 2)

- **Estado:** **BORRADOR / PROPUESTA** (2026-07-16). Consolida los 4 spikes de investigación de la Fase 2. Pendiente de: (a) aprobación del autor y (b) **validación con un despliegue real** de los puntos marcados con 🧪 más abajo.
- **Fecha:** 2026-07-16.
- **Contexto:** detalla y ratifica el §5 y el §5.2/R11 del [ADR-001](001-arquitectura.md). No lo contradice en ningún punto; lo cierra a nivel de implementación.
- **Requisito rector (heredado):** la app debe **sobrevivir a su autor ≥10 años** sin administrador, sin rotación de tokens y sin gestión manual. Toda decisión de abajo se juzga contra esto.

---

## 0. Resumen para quien tiene prisa — las 4 decisiones

| # | Decisión | En una línea |
|---|---|---|
| **D-1 CORS** | `fetch` estándar con **petición «simple»** (Content-Type `text/plain`, token en el **cuerpo**), sin proxy, sin JSONP, sin `no-cors`, sin cabeceras CORS en el servidor. | El preflight OPTIONS que Apps Script no atiende **nunca se dispara**; Google añade `access-control-allow-origin: *` solo. |
| **D-2 Auth** | GIS (Sign in with Google) → ID token → `doPost` → **`tokeninfo` + 3 chequeos manuales obligatorios** → **sesión propia HMAC-SHA256**. | Identidad por **bearer en el cuerpo** (nunca cookie). Una llamada a `tokeninfo` por *login*, no por *request*. |
| **D-3 Sheets** | `SpreadsheetApp` (no Advanced Service), tablas crudas **append-only con UUID**, **un `LockService` de guion** para todos los escritores, proyección idempotente por **shadow-sheet swap**, pestañas **protegidas**. | El historial es inmutable; la vista derivada se autorrepara; nada se corrompe a medias. |
| **D-4 Frontera hexagonal** | **Bundler propio de ~60 líneas (solo `node:fs`)** que envuelve cada módulo ESM en un IIFE y emite **un solo `domain.gs`**. La fuente ESM sigue siendo la única fuente de verdad. **← la decisión más importante; se argumenta en §4.** | Cero npm, cero Vite, cero Actions. El bundle es un **artefacto comiteado** que sobrevive al bundler. |

Ninguna de las 4 introduce un secreto de terceros, una credencial rotable ni una plataforma nueva que un sucesor deba aprender. Coherente con «cero secretos» (ADR-001 §3) y con «cero toolchain obligatoria» (ADR-001 R11).

---

## 1. D-1 · Comunicación cliente↔servidor: CORS por «petición simple»

**Decisión.** El cliente React (GitHub Pages, `https://molecule97.github.io` / `guardias-balmis.github.io`) habla con el Web App (`script.google.com/macros/s/…/exec`) mediante `fetch(mode:'cors')` **estándar**. La clave es no disparar nunca el preflight `OPTIONS`, que Apps Script **no enruta** (solo invoca `doGet`/`doPost`).

**Mecanismo (todo verificado contra la referencia oficial; 🧪 lo que exige despliegue real):**

1. **POST con `Content-Type: text/plain;charset=utf-8`** y el JSON serializado en el **cuerpo**. `text/plain` está en la lista blanca CORS ⇒ petición «simple» ⇒ **sin OPTIONS**.
2. El **ID token viaja en el cuerpo**, nunca en un header `Authorization` (ese header fuerza preflight).
3. `credentials: 'omit'` (default cross-origin). **Nunca `'include'`**: la respuesta trae `access-control-allow-origin: *` y el estándar Fetch prohíbe *wildcard + credenciales* → el navegador bloquea.
4. `redirect: 'follow'` (default): `fetch` sigue solo el **302 `exec` → `script.googleusercontent.com`** convirtiéndolo en GET; `doPost` ya se ejecutó en el POST inicial y su resultado se entrega en el GET del redirect. 🧪
5. **Servidor:** lee `e.postData.contents`, `JSON.parse`, y responde `ContentService.createTextOutput(...).setMimeType(JSON)`. **No se ponen cabeceras CORS**: es *imposible* (`TextOutput` no tiene `setHeader`/`setHeaders`) e innecesario (Google añade `ACAO: *`). 🧪
6. **Requisito de despliegue ligado al CORS:** `Execute as: Me` + `Who has access: Anyone` (`ANYONE_ANONYMOUS`). Cualquier otro modo mete una redirección a `accounts.google.com` **sin `ACAO`** y rompe el `fetch`. 🧪

```js
// Cliente — petición "simple", SIN preflight
const res = await fetch(EXEC_URL, {
  method: "POST",
  mode: "cors", credentials: "omit", redirect: "follow",
  headers: { "Content-Type": "text/plain;charset=utf-8" }, // NO application/json, NO Authorization
  body: JSON.stringify({ action, idToken, payload }),       // el token va en el CUERPO
});
return res.json();
```

**Gotchas que se convierten en reglas:**
- `setHeader`/`setHeaders`/`addHeader` **no existen** en `ContentService.TextOutput`. El patrón `doOptions()+setHeaders({...})` que circula en blogs y respuestas de IA **no compila**: descartado por verificación directa de la referencia.
- `doPost` solo se dispara con cuerpo POST. En GET o POST vacío `e.postData` es `undefined`: **envolver siempre en try/catch y devolver JSON**; nunca dejar que Apps Script sirva su HTML de error (rompería `res.json()`).
- No se puede restringir el origen a nivel CORS (la `ACAO: *` la pone Google y no la controlamos): **el control de acceso es 100 % por token** (toda entrada es hostil, ADR-001 §5.6).

**Riesgo de durabilidad: bajo.** El mecanismo no lleva ningún secreto ni token → nada que caduque ni rotar. Se apoya en primitivas estándar y sistémicas (la semántica de «simple request» la fija WHATWG, no Google; el flujo `302 → googleusercontent.com` con `ACAO:*` lo usan millones de web apps). Único acoplamiento operativo a vigilar: que el despliegue se mantenga en `Anyone` + `Execute as: Me`, y que si algún día se **recrea** el despliegue se **refije la nueva URL `/exec`** en el cliente (documentar en el runbook).

**Descartado:** `no-cors` (respuesta opaca, ilegible), JSONP (solo GET, riesgo XSS), proxy Cloudflare (reintroduce cuenta + secreto que el ADR-001 ya descartó), `<form>`→iframe (no lee la respuesta sin hacks).

---

## 2. D-2 · Autenticación: GIS → ID token → `tokeninfo` → sesión HMAC

**Decisión.** Adoptar el patrón cerrado del ADR-001 §5 con estas precisiones verificadas:

1. **Cliente:** biblioteca **GIS** (`https://accounts.google.com/gsi/client`) en `ux_mode:'popup'` + `callback`. **Prohibido** `gapi.auth2`/platform.js (apagado 31-mar-2023) y el flujo `login_uri`/redirect (la cookie `g_csrf_token` no viaja cross-site a `script.google.com`). El callback entrega `resp.credential` = ID token (JWT).
2. El cliente **POSTea el JWT en el cuerpo** como `text/plain` (D-1); el servidor lo lee en `e.postData.contents`.
3. **Servidor: verificación del ID token.** `UrlFetchApp` GET a `https://oauth2.googleapis.com/tokeninfo?id_token=…`, con `muteHttpExceptions:true` y **2-3 reintentos con backoff exponencial**. `tokeninfo` valida **firma, `iss` y `exp`**, pero **NO la audiencia**. El código **DEBE** comprobar a mano, en este orden:
   - **`aud === CLIENT_ID`** (comparación de strings exacta). **← FALLO ESTRELLA si falta**: sin esto se acepta un ID token emitido para *cualquier* cliente OAuth del ecosistema Google → **suplantación total**.
   - `iss ∈ {accounts.google.com, https://accounts.google.com}`.
   - `email_verified === true` (llega como string `'true'` desde `tokeninfo`).
   - `exp` re-chequeado localmente (cinturón + tirantes).
   - `nonce` de un solo uso consumido vía `CacheService` (anti-replay del login; el nonce lo **emite el servidor**, no el cliente).
4. **Sesión propia:** `base64url(payload).base64url(HMAC-SHA256(payload, secreto))` con `Utilities.computeHmacSha256Signature`. Secreto **autogenerado** (varios `Utilities.getUuid()`, RNG criptográfico) y guardado **solo en `PropertiesService`**, bajo `LockService` para no generarlo dos veces en un arranque en frío. Las siguientes peticiones validan el HMAC **en local, sin tocar la red**.
5. **CSRF no aplica** porque la identidad es un **bearer en el cuerpo**, no una cookie: el endpoint no tiene autoridad ambiental. La regla de oro es **no introducir jamás cookies de sesión** (`Set-Cookie`), que reabrirían CSRF en un endpoint `ANONYMOUS`.

```js
// Núcleo de la verificación — los 3 chequeos que tokeninfo NO hace por ti
const c = JSON.parse(res.getContentText());
if (c.aud !== CLIENT_ID) throw new Error('aud incorrecta');     // <-- imprescindible
if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') throw new Error('iss');
if (c.email_verified !== 'true' && c.email_verified !== true) throw new Error('email no verificado');
consumeNonce_(c.nonce);                                          // un solo uso (CacheService)
```

**Gotchas técnicos que son reglas de implementación:**
- Usar **`base64EncodeWebSafe` de forma consistente** en emisión y validación del HMAC (mezclar con `base64Encode` estándar hace que la firma nunca case).
- `computeHmacSha256Signature` devuelve `Byte[]` con signo: pasar **siempre por base64url** antes de comparar como string.
- Comparar la firma de sesión con **XOR acumulado en tiempo (casi) constante**, no con `===` (Apps Script no trae `crypto.timingSafeEqual`).
- `Session.getActiveUser()` **no identifica** al llamante en `ANYONE_ANONYMOUS` con Gmail de consumo: la identidad viene **solo** del ID token verificado (ADR-001 A-2).

**Riesgo de durabilidad — el punto frágil a 10 años.** La única dependencia externa es **`tokeninfo`, que Google documenta como endpoint «de debugging», no apto para producción** (throttling / errores intermitentes posibles). Es un **punto único de fallo fuera de nuestro control** que ningún «no rotar tokens» resuelve. Mitigaciones ya en el diseño: se llama **1 vez por login** (no por request) gracias a la sesión HMAC, con backoff y reintentos.
- **Contingencia (Plan B del ADR-001):** verificar la firma **RS256 en local** contra el JWK de Google (`googleapis.com/oauth2/v3/certs`), que no depende de un endpoint de debugging. Apps Script puede hacerlo pero exige **RSA/SHA-256 artesanal** (no hay WebCrypto de servidor) → más código para el sucesor. Queda **documentada como contingencia**, no como diseño principal.
- A favor del requisito rector: **el secreto HMAC nunca necesita rotación** (rotarlo solo re-loguea a los usuarios), `PropertiesService` persiste sin admin, y **cero credenciales de terceros de larga vida** almacenadas.
- **Watch-item operativo (no criptográfico):** el OAuth client se borra tras ≥6 meses sin *token exchanges* (ADR-001 R2/A-5); el uso mensual real lo mantiene vivo, y cae dentro del ritual anual del responsable.

🧪 **A probar con despliegue real:** comportamiento de `tokeninfo` bajo logins concurrentes; que el popup de GIS entrega `credential` con el `nonce` dentro del claim; que el ciclo completo login→sesión→request autenticada funciona extremo a extremo.

---

## 3. D-3 · Sheets como almacén + proyección idempotente

**Decisión.** `SpreadsheetApp` (servicio integrado) como capa de acceso **por defecto** para lecturas y escrituras. Se **descarta** el Advanced Sheets Service (Sheets API v4) salvo necesidad puntual de `batchUpdate` estructural: la propia doc dice que *«in most cases, the built-in service is easier to use»*, y las cuotas publicadas de **300/min lecturas · 300/min escrituras** son de la **API v4**, no del servicio integrado (que solo está acotado por el límite de **6 min/ejecución**). A 15 usuarios y unos pocos miles de filas nunca será el cuello de botella si se evita el bucle celda-a-celda.

**Patrón de escritura (una función *gateway* que envuelve `doPost`, toda bajo lock):**

1. **Escritor único serializado.** `LockService.getScriptLock()` + `waitLock(~20-30 s)` en **try/finally**. Es **script lock, no user lock**: el Web App corre `Execute as Me` bajo una única identidad de servicio para los 15 usuarios → un lock por usuario no serializaría escrituras de residentes distintos contra el mismo Sheet (que es justo el problema).
2. **Lecturas en bloque:** un `getValues()` por pestaña normalizada (`residentes`, `periodos`, `bloqueos`, `asignaciones`, `responsables`, `sorteos`).
3. **Todo el cálculo lo hace el núcleo de dominio puro en memoria** (§4): cero llamadas a Sheets durante la lógica.
4. **Append normalizado:** nunca se reescribe una fila cruda existente; solo se **añaden filas nuevas con `id = Utilities.getUuid()`** (event-sourced / append-only) mediante `getRange(...).setValues([...])` (nunca `appendRow` en bucle — antipatrón #1 de la guía oficial). Un fallo a media escritura no corrompe el historial: solo deja de reflejarse hasta el siguiente intento.
5. **Proyección:** reconstruir **solo los meses afectados** (normalmente 1, como mucho 2 en un borde de mes) + siempre `Resumen`/`Contaje` (barato de recalcular entero).
6. **Reescritura idempotente por «shadow-sheet swap»:** crear pestaña `_tmp_<mes>` → volcar con un único `setValues()` → borrar la pestaña vieja → renombrar la temporal al nombre final. Más seguro que `clearContents()+setValues()`: si el script muere entre el borrado y el reescrito (excepción o timeout de 6 min), **la pestaña pública nunca queda vacía a medias**; el siguiente intento limpia cualquier `_tmp_` residual antes de empezar. **No es una transacción real** (no existen en Sheets), pero acota la ventana de inconsistencia a dos llamadas de metadata rápidas.
7. **Protección:** proteger cada pestaña cruda **y** cada pestaña de mes/`Resumen` (son entregable generado, no se editan a mano). `sheet.protect()` + `protection.removeEditors(protection.getEditors())` — **la lista de editores NO empieza vacía**, hereda a todos los editores del fichero, hay que vaciarla explícitamente. Dato que hace funcionar el patrón: *«the spreadsheet owner is always able to edit protected ranges and sheets»* → como el Web App corre `Execute as Me`, el script escribe sin fricción aunque las pestañas estén 100 % bloqueadas para humanos.

**⚠️ Supuesto a verificar con la config real (no confirmable sin ver el despliegue):** que la cuenta que ejecuta el Web App (`Execute as Me`) sea **también la propietaria** del Spreadsheet, o al menos esté añadida como editor de cada `Protection`. Si el Sheet lo creó otra cuenta, hay que `protection.addEditor(email)` o el script fallará al escribir en pestañas protegidas.

**Riesgo de durabilidad.** Ninguna pieza depende de tokens rotables ni credenciales externas: `LockService`, `Protection` y `SpreadsheetApp` usan la identidad de ejecución del propio script (estable mientras exista la cuenta de servicio). El riesgo estructural real a 10 años es el **acoplamiento «owner del Sheet == ejecutor del script»**: si alguien reorganiza Drive (transferencia de propiedad, migración a Shared Drive, cambio de cuenta) sin saberlo, **las escrituras a pestañas protegidas fallarán de forma silenciosa** para quien lo herede, sin admin que lo diagnostique. Mitigación (a documentar en el ADR y en una pestaña `README/operación` del propio Sheet): **loggear de forma visible cualquier fallo de escritura por protección** y fijar por escrito qué cuenta debe seguir siendo owner. El patrón append-only es en sí una buena decisión de durabilidad: un mantenedor futuro puede reconstruir el estado completo re-ejecutando la proyección sobre el histórico.

🧪 **A probar con despliegue real:** el «shadow-sheet swap» **no es una receta oficial de Google** (es composición de primitivas verificadas). Escribir un test manual/E2E que **mate el proceso a mitad de `rebuildMonthSheet`** y confirme que el siguiente intento se autorrepara. Verificar también el comportamiento de `Protection` con el modo de compartición real del fichero (evitar «cualquiera con el enlace puede editar»).

**Descartado:** Advanced Sheets Service por defecto (complejidad + cuota extra sin beneficio); `appendRow` en bucle; `clearContents()+setValues()` sin pestaña temporal (no crash-safe); UPDATE in-place por posición de fila (rompe el historial/auditoría y complica la idempotencia); user lock (no serializa entre usuarios).

---

## 4. D-4 · Frontera hexagonal — un dominio, tres entornos, sin toolchain frágil ★ **la decisión clave**

### 4.1 El problema

El núcleo de dominio (`v2/domain/*.js`: `calendar`, `residents`, `tally`, `thirdpost`, `equity`, `validate`) debe ejecutarse **idéntico en tres entornos**:

1. **Navegador** (GitHub Pages, **sin build**) → hoy consume ESM (`type=module`).
2. **`node:test`** → los **118 tests ya en verde** de la Fase 1 consumen la fuente ESM.
3. **Servidor Apps Script** → **ámbito global único**, y el runtime V8 de Apps Script **no soporta ES modules** (doc oficial: *«The V8 runtime doesn't support ES6 modules (import / export)»*).

El §5.6 del ADR-001 lo hace innegociable: el endpoint es `ANYONE_ANONYMOUS`, así que **el servidor DEBE revalidar con el MISMO código**, no con una copia. El validador es, en palabras del ADR-001 §8, *«el activo más duradero del proyecto»*.

### 4.2 Por qué la concatenación ingenua **revienta** (verificado en este repo)

Apps Script mete **todos** los archivos en un único ámbito global (*«All script files … are executed in a global scope»*), y como los 6 módulos son ESM, sus nombres top-level son privados y **colisionan** al aplanarlos. Comprobado directamente sobre las fuentes actuales — **7 nombres chocan**:

| Nombre | Archivos | Tipo | Modo de fallo |
|---|---|---|---|
| `err` | equity (`INV-3`), thirdpost (`INV-8`), validate (param) | `const` (arrow), **cuerpos distintos** | `SyntaxError: Identifier 'err' has already been declared` — **fatal, ruidoso** |
| `inRange` | equity, thirdpost | `const` | `SyntaxError` |
| `GUARDIA` | tally, validate | `const` (Set) | `SyntaxError` |
| `cohortOf` | equity, validate | — | colisión |
| `inMonth` | equity, thirdpost | — | colisión |
| **`periodsOf`** | thirdpost `(r)`, validate `(residente)` | **`function`, cuerpos distintos** | **hoisted → gana el último SIN error** |
| **`closingWindowThisMonth`** | thirdpost, equity | **`function`, cuerpos distintos** | **hoisted → gana el último SIN error** |

El caso `const` es el bueno: falla **ruidosamente** al parsear. **El peligroso es el silencioso:** `periodsOf` y `closingWindowThisMonth` existen como **`function` con implementaciones distintas** (distinto cálculo de fecha de respaldo) en dos módulos; como las `function` se *hoistan* y el orden de parseo entre archivos es **impredecible** (doc oficial), **el último cargado gana sin ningún error** y el validador daría resultados incorrectos según el orden de archivos. Es **el peor modo de fallo posible** para la pieza que impone la normativa.

### 4.3 La decisión: bundler propio mínimo (~60 líneas, solo `node:fs`)

**La fuente ESM (`v2/domain/*.js`) sigue siendo la ÚNICA fuente de verdad.** Cliente y `node:test` la consumen sin tocar una línea. Un bundler propio produce **un solo `server/domain.gs`** para Apps Script así:

1. **Envuelve cada módulo en su propio IIFE** — esto **preserva el ámbito privado** y es lo único que evita las colisiones de §4.2. Los `err`, `inRange`, `periodsOf`… de cada módulo quedan encerrados.
2. Traduce `import { a, b } from "./x.js"` en `const { a, b } = X;` (desestructuración del namespace del módulo ya definido arriba, en **orden topológico**: `Calendar → Residents → Tally → Thirdpost → Equity → Validate`).
3. Quita el prefijo `export`.
4. Expone la API pública en un único global `Domain` (`validateMonth`, `tally`, `validateResidencyYearClose`, `validateThirdPost`, `levelOn`) que `doGet`/`doPost` invocan por nombre.

**Emitir UN SOLO archivo elimina de raíz** el problema de orden entre `.gs`: el orden intra-archivo es determinista (top-to-bottom), así que el IIFE de `Calendar` corre antes que el de sus consumidores.

### 4.4 Por qué esta opción y no las otras (el argumento)

| Opción | Por qué **no** |
|---|---|
| **Rollup / Vite / `google/aside`** | Funciona y hasta auto-renombra colisiones, pero añade **npm + rollup + probablemente GitHub Actions** = exactamente la superficie de podredumbre que el ADR-001 R11 marca como *«lo primero que se pudre en 10 años»*. Sobredimensionado para un DAG de 6 archivos de funciones puras. |
| **Reescribir el dominio a `globalThis`/namespace o UMD** | Corre en los 3 entornos sin build, pero **abandona `import`/`export`**, obliga a **reescribir los 6 módulos y los 118 tests ya verdes**, y devuelve el navegador a `<script>` clásico frágil al orden. Churn enorme sobre código probado, a cambio de nada que el bundler no dé ya. |
| **Validar solo en cliente + copia en servidor** | **Inseguro:** el endpoint es `ANYONE_ANONYMOUS`, un POST directo salta el validador del cliente. **Y frágil:** dos copias del validador divergen en 10 años — es el antipatrón *«segunda identidad que se pudre»* que el propio ADR-001 ya sufrió con *Tercer Puesto/Imaginaria*. |
| **«clasp resuelve los módulos»** | **Falso.** `clasp` v3 no transpila ni empaqueta, empuja los `.js` **verbatim**; un `.js` con `import`/`export` da `SyntaxError` en Apps Script. `clasp` queda solo como **conveniencia de subida** del `domain.gs` ya bundleado (o el editor web como respaldo, ADR-001 R10). |

### 4.5 Por qué encaja con el requisito rector mejor que cualquier alternativa

- **El cliente** (la pieza siempre encendida) sirve **ESM crudo, cero build** → no se pudre.
- **El bundle del servidor es un ARTEFACTO comiteado** al repo. Si el bundler se pudre en el año 6, **el último `domain.gs` sigue corriendo en Apps Script indefinidamente**. La fragilidad queda **acotada a «no poder regenerar fácilmente el servidor»**, no a «el servidor deja de funcionar» — literalmente el principio de degradación digna del ADR-001 §8.
- **Superficie de podredumbre mínima:** el bundler usa **solo `node:fs`**, y Node ya es requisito **duro** (los 118 tests). **Sin npm install, sin package-lock, sin Vite/rollup/Actions.** Quien pueda correr los tests puede correr el bundler: `node build-gas.mjs`.
- **Verificación empírica:** cargado en un ámbito global único (`node:vm`, que emula la concatenación de GAS) el bundle devuelve resultado **idéntico** a la fuente ESM en fixtures reales; y la concatenación ingenua revienta con el `SyntaxError` de §4.2.

### 4.6 La red de seguridad a 10 años — **test de paridad**

Riesgo residual real: que el dominio evolucione y **nadie regenere el bundle** → el servidor validaría con lógica vieja mientras el cliente usa la nueva. **Mitigación comiteada:** un **test de paridad `verify.mjs`** que carga el bundle en `node:vm` y lo compara **por valor (`JSON.stringify`, no `deepStrictEqual`** — los objetos de otro *realm* del `vm` tienen distinto `[[Prototype]]`) contra la fuente ESM sobre los mismos fixtures. **Falla en rojo si divergen.** Ese test es la garantía de que las «dos ejecuciones» del mismo código son de verdad el mismo código. Debe correr en CI/`npm test` junto a los 118 tests de dominio.

🧪 **A probar con despliegue real:** que `domain.gs` **carga y ejecuta sin error en el runtime V8 de Apps Script** (la equivalencia está verificada en `node:vm`, pero el runtime real es el juez final); y que `Domain.validateMonth(ctx)` devuelve lo mismo que el cliente para un cuadrante de prueba.

---

## 5. Orden de implementación recomendado (Fase 2, TDD estricto)

TDD como en la Fase 1: **el test se escribe y falla antes de implementar**. El dominio ya está verde; la Fase 2 es **todo adaptadores** (hexagonal: I/O en los bordes). Orden por dependencias, de lo más puro/testeable en Node a lo que solo se valida desplegado:

| Paso | Qué | Cómo se prueba **sin desplegar** | Cierra |
|---|---|---|---|
| **2.0** | **Bundler `build-gas.mjs` + `verify.mjs`** (§4). Emitir `server/domain.gs` y el test de paridad ESM↔bundle. | `node:test` + `node:vm`. **Primero** porque desbloquea probar el servidor en Node. | D-4 |
| **2.1** | **Sesión HMAC** (emitir/validar, `timingSafeEq`, base64url, TTL) como **funciones puras**. | `node:test` con secreto inyectado. Pura → TDD directo. | D-2 (4) |
| **2.2** | **Verificación del ID token**: parseo de la respuesta de `tokeninfo` + los 3 chequeos (`aud`/`iss`/`email_verified`), `nonce`. Separar la **lógica de validación** (pura, testeable con respuestas fixture) del **`UrlFetchApp`** (adaptador). | `node:test` sobre respuestas `tokeninfo` grabadas, incl. casos hostiles (`aud` ajena, `email_verified:false`, nonce reusado). | D-2 (3) |
| **2.3** | **Adaptador de Sheets**: `appendRecord`, `rebuildMonthSheet` (shadow-swap), `protectSheetForServiceOnly`, todo bajo `withScriptLock`. Aislar la **transformación datos↔filas** (pura) del `SpreadsheetApp` (adaptador). | `node:test` sobre la transformación pura + un **fake de `SpreadsheetApp`** para la lógica de swap/lock. | D-3 |
| **2.4** | **Router `doGet`/`doPost`**: `text/plain`→`JSON.parse`→acción, try/catch que **siempre devuelve JSON**, `nonce` en `doGet`. Ensamblar 2.1–2.3 + `Domain`. | `node:test` invocando `doPost({postData:{contents}})` con un `e` simulado. | D-1 + D-2 |
| **2.5** | **Runbook de despliegue** (`Execute as: Me` + `Anyone`, owner==ejecutor, refijar `/exec`, ritual anual R1). | Revisión documental. | operativa |
| **2.6 🧪** | **Despliegue real** en la cuenta del servicio + **E2E** desde el cliente: cadena CORS completa (302→GET, `res.json()`), login GIS→sesión→request, `tokeninfo` bajo carga, shadow-swap matando el proceso a media reescritura, `domain.gs` en V8. | **Solo aquí**; requiere acceso a la cuenta del servicio (ADR-001 §11). | valida 🧪 de §1-§4 |

Regla de oro: **todo lo que se pueda probar en `node:test` se prueba antes del despliegue.** El paso 2.6 es el único que necesita infraestructura Google real, y es donde se caen (si se caen) los supuestos marcados 🧪.

---

## 6. Riesgos de durabilidad — consolidado

| # | Riesgo | Severidad | Mitigación / estado |
|---|---|---|---|
| DR-1 | **`tokeninfo` es endpoint «de debugging»**: Google puede endurecer throttling o retirarlo. SPOF fuera de nuestro control. | Media | 1 llamada por *login* (no por request) + backoff. **Contingencia:** RS256 local contra JWK (Plan B, más código). |
| DR-2 | **Owner del Sheet ≠ ejecutor del script** tras una reorganización de Drive → escrituras protegidas fallan **en silencio**. | Media | Loggear visiblemente el fallo de protección; fijar por escrito la cuenta owner en una pestaña `README/operación`. ⚠️ supuesto a confirmar en el despliegue. |
| DR-3 | **El bundle no se regenera** tras evolucionar el dominio → servidor con lógica vieja. | Media | **Test de paridad `verify.mjs`** en CI (§4.6): falla en rojo si diverge. |
| DR-4 | **Recreación del despliegue** genera otra URL `/exec` → cliente apuntando a la vieja. | Baja | Documentar en runbook: actualizar el despliegue existente (no crear uno nuevo); refijar la URL si se recrea. |
| DR-5 | **OAuth client borrado** por ≥6 meses sin uso (ADR-001 R2). | Baja | El uso mensual real lo mantiene; cae en el ritual anual del responsable. |
| DR-6 | **Modo de despliegue mal puesto** (no `Anyone`/`Execute as Me`) → CORS roto por redirección a login. | Baja | Parte del runbook; verificado en 2.6. |

**Cero secretos de terceros, cero credenciales rotables** en todo el backend (solo el HMAC interno autogenerado, que no se rota). Todos los modos de fallo degradan hacia el escalón «Sheet a mano» del ADR-001 §8, **sin pérdida de historial**.

---

## 7. Lo que este ADR **no** cierra (y por qué)

- Los 6 puntos 🧪 de §1–§4: solo un **despliegue real** en la cuenta del servicio los confirma. Hasta entonces son «verificado contra doc oficial», no «verificado en nuestra instalación».
- El **supuesto owner==ejecutor** (DR-2): depende de cómo se creó el Sheet, dato que no tenemos hasta tener acceso (ADR-001 §11).
- La contingencia **RS256 local**: documentada como Plan B, **no implementada** — solo si `tokeninfo` degradara.

---

## 9. Revisión del ingeniero principal (2026-07-16)

He revisado los 4 spikes y verificado los puntos load-bearing contra el código. Suscribo **D-1, D-2 y D-3** tal cual. Sobre **D-4** (la decisión clave), tres matices:

1. **El test de paridad `verify.mjs` es lo que hace segura a D-4, no el bundler.** Cambia el marco: no confiamos en que el bundler sea correcto, lo *verificamos* en cada `npm test`. Con esa red, un bundler imperfecto es tolerable. Por eso 2.0 (bundler + paridad) va **primero**: sin la paridad, el bundler es un riesgo; con ella, es una conveniencia.

2. **El bundler debe FALLAR RUIDOSAMENTE ante sintaxis que no sepa transformar** (`export default`, re-export `export {x} from`, `import()` dinámico, import con alias `as`). Un bundler que *ignora en silencio* lo que no entiende reintroduce justo el fallo silencioso que D-4 quiere matar. Regla de dominio que lo mantiene trivial: **los módulos de `v2/domain` usan solo `import`/`export` con nombres** (ya es el caso). El bundler valida esa convención y aborta si se rompe.

3. **Alternativa que el §4.4 no lista: un único fichero `domain.js`.** Si el dominio fuese un solo módulo, no habría `import`/`export` *entre* módulos y para Apps Script bastaría quitar los `export` de nivel superior (transform trivial, casi sin parser). Es **aún menos toolchain** que el bundler y maximiza la legibilidad para el sucesor (un fichero que corre en los tres entornos). Coste: ~600 líneas en un fichero en vez de 6 módulos navegables, y *churn* sobre 122 tests ya verdes. **Recomendación:** mantener los 6 módulos + bundler + paridad (preserva estructura probada y testabilidad); **si el bundler diera problemas reales**, colapsar a `domain.js` es el plan B de menor toolchain. Decisión del autor si prefiere invertir el orden.

**Veredicto:** ADR-002 listo para aprobación con esos tres matices incorporados al plan. Nada aquí contradice el núcleo de dominio ya verde ni el ADR-001. La Fase 2 puede empezar por 2.0 (bundler+paridad) y 2.1-2.4 (funciones puras testeables en Node) **sin** acceso a la cuenta del servicio; solo 2.6 (despliegue real + E2E) lo necesita.

---

## 8. Fuentes

Apps Script Web Apps · ContentService/TextOutput · Utilities · LockService · Spreadsheet/Protection · quotas:
`developers.google.com/apps-script/guides/web` · `/reference/content/text-output` · `/reference/utilities/utilities` · `/reference/lock/lock-service` · `/reference/spreadsheet/protection` · `/guides/services/quotas` · `/guides/support/best-practices` · `/guides/v8-runtime` · `/advanced/sheets` · `workspace/sheets/api/limits`

Identidad: `developers.google.com/identity/gsi/web/guides/verify-google-id-token` · `/identity/sign-in/web/backend-auth` · `/identity/gsi/web/guides/overview` · `developersblog…/gis-jsweb-authz-migration`

CORS: `developer.mozilla.org/.../Glossary/CORS-safelisted_request_header` · `/Web/HTTP/Guides/CORS` · `dev.to/googleworkspace/youre-probably-using-curl-wrong…` · `github.com/tanaikech/taking-advantage-of-Web-Apps…` · `groups.google.com/g/google-apps-script-community/c/zJpevovcFLA` · `joshuatz.com/posts/2019/google-apps-script-authorization-in-a-cross-origin-iframe`

Toolchain: `github.com/google/clasp` (+ releases)
