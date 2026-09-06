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

## Despliegue del 2026-09-06 (V-48, INV-3 entre compañeros que cierran en meses distintos): solo `domain.gs`

Cambio de dominio puro: `equity.js` (el cierre anual compara también con los compañeros de
cohorte que cerraron ese mismo año meses antes) y `residents.js` (`closingPeriodOn` devuelve
`year`, nueva `closedPeriodsBetween`). `server/src` no cambia, así que `server-lib.gs` sale
byte a byte igual y `Code.gs` tampoco cambia: con `npm run deploy` sube solo; pegando a mano,
basta con **`domain.gs`** (3611 líneas; `sha256` empieza por `aa65e7938ff3`). Comprobación
después: validar un mes en el que cierre el año alguien cuya cohorte tenga a otro que cerró
antes debe listar el aviso «… cerró su año el YYYY-MM-DD» — y en el cliente sale ya sin
desplegar nada, porque `Calendar.jsx` importa el dominio directamente.

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
