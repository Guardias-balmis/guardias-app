# Despliegue del backend (Apps Script) — runbook

> Paso 2.6 del [ADR-002](../docs/adr/002-backend.md). Es el **único** paso que necesita la
> cuenta Google del servicio. Todo lo demás (dominio, auth, store, router) ya está probado en
> Node (`npm test`). Estimado: ~30 min la primera vez.

## Piezas
- `domain.gs` · núcleo de dominio (generado por `npm run build`, **no editar**).
- `server-lib.gs` · auth/sesión/store/router (generado, **no editar**).
- `Code.gs` · adaptador impuro escrito a mano (el único que se edita).

## Pasos

1. **Con la cuenta del servicio** (la que será propietaria durable, no una personal), crea el
   Sheet de guardias y anota su **ID** (de la URL). Crea sus pestañas de datos con la fila de
   cabecera: `residentes`, `periodos`, `bloqueos`, `asignaciones`, `responsables`,
   `voluntariosResponsable`, `sorteos`, `preferencias`, `cuadrantes`… (las tablas de
   `server/src/sheets-schema.js`, hoy 14 — cabeceras exactas ahí; `Code.gs:append` crea sola la
   pestaña que falte, así que una tabla nueva no exige tocar el Sheet a mano). **La cuenta que despliega debe
   ser la propietaria del Sheet** (riesgo DR-2 del ADR): si no, añádela como editor.

   No crees a mano ninguna otra pestaña: desde la Fase 7.1, "Publicar" en el cuadrante crea
   solas (y reescribe por completo en cada publicación) una pestaña por mes con formato
   "YYYY-MM" y una hoja "Resumen" — son un entregable proyectado, no datos de entrada; tocarlas
   a mano no rompe nada pero se pierde en la siguiente publicación.

2. **Proyecto de Apps Script** (script.google.com, misma cuenta): crea un proyecto y añade
   tres archivos con el contenido de `domain.gs`, `server-lib.gs` y `Code.gs`. Copia el
   **Script ID** (Configuración del proyecto) — hace falta en el paso 6.
   *(El editor web es el respaldo manual; `clasp` — R10 del ADR-001 — es la vía normal desde
   que existe este runbook con el paso 6.)*

3. **OAuth Client** en console.cloud.google.com (proyecto GCP **de la cuenta del servicio**):
   credencial OAuth 2.0 de tipo *Aplicación web*; en *Authorized JavaScript origins* añade
   `https://guardias-balmis.github.io`. Publica la *OAuth consent screen* como **In production**
   con solo los scopes `openid email profile` (así no hay verificación ni tope de usuarios —
   ADR-001 A-5). Copia el **Client ID**.

4. **Script Properties** (Proyecto → Configuración): `OAUTH_CLIENT_ID` = el del paso 3;
   `SPREADSHEET_ID` = el del paso 1. (`SESSION_SECRET` se autogenera en el primer uso.)

   **Generador con IA (decisión V-45), opcional:** `GEMINI_API_KEY` = una clave de la Gemini API
   (aistudio.google.com → «Get API key»), y `GEMINI_MODEL` si se quiere uno distinto del defecto
   `gemma-4-31b-it`. La clave vive SOLO aquí: nunca se escribe en el código ni llega al navegador,
   y viaja a Google en una cabecera, no en la URL (una clave en la URL acaba en los registros de
   ejecución del proyecto y de ahí ya no se borra).

   Sin `GEMINI_API_KEY` la aplicación funciona entera igual; el botón «Generar cuadrante de
   guardias» de Inicio sigue apareciendo (su visibilidad depende solo del permiso del ciclo y del
   estado del mes, no de si la IA está configurada), pero quien lo pulse ve al momento el nombre
   exacto de la propiedad que falta, sin gastar ningún intento. **Si algún día Google retira ese modelo**, la respuesta será un HTTP 404
   con el mensaje de Google: se arregla poniendo un id vigente en `GEMINI_MODEL`, sin tocar código
   ni volver a desplegar — que es justo para lo que existe esa propiedad.

5. **Desplegar** → *Nueva implementación* → tipo *Aplicación web*:
   - **Ejecutar como: yo** (la cuenta del servicio).
   - **Quién tiene acceso: cualquiera** (`ANYONE_ANONYMOUS`).
   - ⚠️ Cualquier otro modo rompe el CORS del cliente (redirección a login sin `ACAO`).
   - Copia la **URL `/exec`** y fíjala en el cliente (Fase 3). Al re-desplegar, usa *Editar
     implementación → Nueva versión* para **conservar la URL** (crear una nueva la cambia — DR-4).

6. **Configura `clasp` para los redespliegues futuros** (una sola vez por máquina):
   ```bash
   npm install               # trae @google/clasp como devDependency
   npx clasp login           # abre el navegador; usar LA CUENTA DEL SERVICIO, no la personal
   cp .clasp.json.example .clasp.json
   # editar .clasp.json: pegar el Script ID del paso 2 (rootDir ya apunta a "server")
   npx clasp deployments     # lista las implementaciones — copiar el Deployment ID de la de
                              # tipo "Web app" creada en el paso 5 (la que tiene la URL /exec)
   export CLASP_DEPLOYMENT_ID="AKfyc..."   # agregar esta línea a tu ~/.zshrc, no al repo
   ```
   `.clasp.json` (tiene el Script ID de un proyecto real) y `.clasprc.json` (credenciales de
   `clasp login`) están en `.gitignore` a propósito — cada quien despliega configura el suyo.

## Despliegue del 2026-09-05 (V-47 y la revisión adversarial): `Code.gs` SÍ cambia

Esta vez hay que subir los **tres** ficheros, no solo los dos generados: `Code.gs` cambia en una
sola función, `fetchTokeninfo_`, que deja de reintentar tres veces (1,2 s de esperas) ante un HTTP
4xx de tokeninfo —un token caducado o inválido no es transitorio— y devuelve el cuerpo del error
para que `verifyTokeninfo` lo explique («vuelve a pulsar el botón de Google»). Con `npm run deploy`
sube solo (clasp empuja todo `server/`); pegando a mano, pega también `Code.gs`. Después, repetir la
verificación E2E manual de abajo (login, y un login con un token caducado debe fallar rápido y con
ese mensaje).

## Despliegue del 2026-09-07 (V-48, INV-3 entre compañeros que cierran en meses distintos): `domain.gs` y `server-lib.gs`

Cambio de dominio (`equity.js`: el cierre anual compara también con los compañeros de cohorte
que cerraron ese mismo año meses antes; `residents.js`: `closingPeriodOn` devuelve `year`, nueva
`closedPeriodsBetween`) más una línea en `router.js` (`closeViolations` pasa los dos primeros
días del mes siguiente al cierre anual, contrato C-1). `Code.gs` NO cambia: con `npm run deploy`
sube solo; pegando a mano, pega **`domain.gs`** y **`server-lib.gs`** (las líneas y el `sha256` de
cada uno están en la tabla de la lista de despliegue publicada, y salen con `wc -l` y `sha256sum`
sobre `main`). Comprobación después: validar un mes en el que cierre el año alguien cuya cohorte
tenga a otro que cerró antes; si el reparto entre los dos se pasa del ±1 en algún eje, el aviso
dice «… cerró su año el YYYY-MM-DD» (si no se pasa, no hay aviso, y es lo normal). En el cliente
sale ya sin desplegar nada, porque `Calendar.jsx` importa el dominio directamente.

## Despliegue del 2026-09-07 (V-49, V-50 y V-51): solo `server-lib.gs`

Los tres cambios de este día van juntos y **ninguno toca el dominio ni `Code.gs`**: `router.js`,
`sheets-schema.js` y `ai-prompt.js` se compilan los tres a `server-lib.gs`. Con `npm run deploy`
sube solo; pegando a mano, pega **únicamente `server-lib.gs`** (las líneas y el `sha256` salen con
`wc -l` y `sha256sum` sobre `main`). Si vienes de una versión anterior a la del V-48 de más arriba,
pega también `domain.gs`: el mismo despliegue cubre los dos.

- **V-49 — el acceso de desarrollador se amplía a todo el permiso del ciclo, y caduca.**
  `esAccesoDesarrollador` vive ahora dentro de `requireCicloPermiso`, así que destraba
  validar/publicar/despublicar, excepciones, sorteo, imaginaria y las ediciones de fechas,
  periodos formativos y ausencias de otro residente — no solo `generarCuadranteIA` como en V-46.
  **`FECHA_LIMITE_ACCESO_DESARROLLADOR = "2027-03-31"`**, la misma constante en `router.js` y en
  `client/lib/permisos.js`: pasada esa fecha vuelve a devolver `false` sin tocar una línea, y el
  ciclo exige Responsable o Mayor otra vez. Está anotado también abajo, en el ritual anual —
  después de esa fecha, este párrafo del runbook y las dos constantes se pueden borrar.
- **V-50 — registrar un Bloqueo escribe la marca V/R/B en la rejilla.** `crearBloqueo` escribe en
  `asignaciones`, dentro del mismo atómico que el alta. Es la primera vía de escritura de la
  rejilla que no es `guardarAsignaciones`, así que conviene comprobarla en el Sheet real: escribe
  solo en celdas VACÍAS, no toca un mes PUBLICADO, y revierte VALIDADO→BORRADOR únicamente en los
  meses donde de verdad escribió algo.
- **V-51 — se retira `preferDobles`.** La columna **se queda** en la pestaña `preferencias` (tabla
  append-only: no se borra una columna con historial). No hay nada que tocar en el Sheet, y
  borrarla a mano descuadraría las filas viejas.

**Comprobación después de desplegar**, en este orden:

1. Con el email del acceso de desarrollador y **sin** mandato de Responsable ni nivel Mayor:
   Validar y Publicar un mes de prueba responden en vez de «no tienes permiso». Con cualquier otro
   email que no sea Mayor, sigue negándose — eso es lo que confirma que V-49 no abrió la puerta a
   todo el mundo.
2. Registrar unas vacaciones de varios días desde Preferencias y abrir la rejilla del mes: salen
   las «V», una por día. Repetir sobre un rango que pise un día con una guardia ya puesta: esa
   guardia **no** se toca y el día vuelve en el aviso de «días sin marcar» de la pantalla. Repetir
   con el mes PUBLICADO: no se escribe ni una celda y el Bloqueo se registra igual.
3. El formulario de Preferencias ya no ofrece el doblete preferido y guardar sigue funcionando.

**Mientras el `/exec` viejo siga en producción** (GitHub Pages publica el cliente al instante, Apps
Script no), dos de los tres degradan solos y uno no: V-51 aguanta —el servidor viejo normaliza un
`preferDobles` ausente a `""`, que es un valor válido— y V-50 también —`Prefs.jsx` lee
`sinMarcar || []`, así que sin el campo no sale el aviso y no se rompe nada—, pero **V-49 no**: la
pantalla ya ofrece los botones del ciclo al desarrollador y el servidor viejo los rechaza con «no
tienes permiso» hasta que se pegue `server-lib.gs`.

## Despliegue del 2026-09-07 (V-43 y V-44): solo `server-lib.gs`

`colaImaginaria` devuelve un campo nuevo, `coberturas` (las coberturas activas de esa incidencia,
con su `id`), que es lo que permite anular una desde la app. Cambio de `router.js` únicamente: ni
dominio ni `Code.gs`. Comprobación: registrar una cobertura desde la tarjeta de Inicio, anularla
con el botón «Anular» y recargar — la cola vuelve a su orden anterior y la anulación sigue puesta;
en la pestaña `imaginaria` del Sheet hay dos filas con el mismo `id` (el alta y la anulación), no
una borrada. La mitad de V-43 (`eventos` a `Calendar.jsx`) es solo cliente: sale con el push a
Pages, sin desplegar nada. Con el `/exec` viejo no se rompe nada: sin el campo `coberturas` el
cliente no enseña el bloque de anular (`r.coberturas || []`).

## Redesplegar tras un cambio de dominio (el caso de todos los días)

Dos comandos, con roles distintos — confundirlos es exactamente el incidente del
`quarterCloseWindow` (26-07-2026, ver CLAUDE.md):

- **`npm run push`** — corre los tests, regenera `domain.gs`/`server-lib.gs` y los sube al
  proyecto de Apps Script (`clasp push`). Esto actualiza el **HEAD** del proyecto (lo que se ve
  al abrir el editor web), pero **no toca lo que corre en producción** — el Web App desplegado
  sigue sirviendo la versión congelada de su último despliegue. Seguro de correr en cualquier
  momento, incluso a medio terminar algo.
- **`npm run deploy`** — lo mismo, y además crea una versión nueva y la asocia al
  **`CLASP_DEPLOYMENT_ID`** existente (`clasp deploy -i`), que es lo que de verdad pone el
  cambio en producción **sin cambiar la URL `/exec`** (equivalente a "Editar implementación →
  Nueva versión" del paso 5, pero desde la terminal y sin poder pegar mal un archivo).

Si `CLASP_DEPLOYMENT_ID` no está seteado, `npm run deploy` falla alto y claro en vez de crear
una implementación nueva con URL distinta (DR-4) — no hay forma de que salga silencioso.

`Code.gs` sigue sin poder testearse con Node (toca `UrlFetchApp`/`SpreadsheetApp` reales):
después de un `npm run deploy` que lo modifique, repetir a mano la verificación E2E de abajo.

## Verificación E2E (los puntos 🧪 del ADR-002)
- `GET /exec` → responde `{ok:true, nonce:...}` (cadena CORS 302→GET, `res.json()` legible).
- Login GIS → `POST` con el ID token → `{ok:true, session}`; reintento con el mismo nonce → falla.
- `validar` con un cuadrante de prueba → devuelve las mismas violaciones que el cliente.
- Matar el proceso a media `rebuildSheet` y confirmar que el siguiente intento se autorrepara.
- **Fase 7.1 (verificada en vivo desde el cutover de 2026-07-24; se repite tras cada despliegue):**
  `publicarCuadrante` con un cuadrante de prueba → abrir la pestaña "YYYY-MM" creada y
  comprobar que las celdas de código y las fórmulas COUNTIF/SUMPRODUCT de cada fila calculan
  el total esperado (no solo que la operación no da error); abrir "Resumen" y comprobar que
  su SUMIF referencia esa pestaña por nombre y su MAXIFS/MINIFS de equidad calcula bien con
  ≥2 residentes de la misma cohorte.

## Mantenimiento (ritual anual — requisito rector)
Cada enero, el R3 responsable entrante **inicia sesión en la cuenta del servicio** y abre Gmail
y el Sheet (mantiene viva la cuenta y el OAuth client — ADR-001 R1/R2). Anota aquí quién y cuándo.

**Enero de 2027 — una sola cosa más:** el acceso de desarrollador de V-49 caduca el **2027-03-31**
por sí solo (`FECHA_LIMITE_ACCESO_DESARROLLADOR`, misma constante en `server/src/router.js` y en
`client/lib/permisos.js`). No hay que hacer nada para que se cierre; lo que sí conviene es
comprobar después de esa fecha que el ciclo vuelve a exigir Responsable o Mayor, y retirar entonces
las dos constantes y el párrafo de V-49 de este runbook. Si alguien lo alarga, que sea moviendo la
fecha y dejándolo escrito aquí — nunca quitando la caducidad.
