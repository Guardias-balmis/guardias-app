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
   `voluntariosResponsable`, `sorteos`, `preferencias`, `cuadrantes` (las 9 tablas de
   `server/src/sheets-schema.js` — cabeceras exactas ahí). **La cuenta que despliega debe
   ser la propietaria del Sheet** (riesgo DR-2 del ADR): si no, añádela como editor.

   No crees a mano ninguna otra pestaña: desde la Fase 7.1, "Publicar" en el cuadrante crea
   solas (y reescribe por completo en cada publicación) una pestaña por mes con formato
   "YYYY-MM" y una hoja "Resumen" — son un entregable proyectado, no datos de entrada; tocarlas
   a mano no rompe nada pero se pierde en la siguiente publicación.

2. **Proyecto de Apps Script** (script.google.com, misma cuenta): crea un proyecto y añade
   tres archivos con el contenido de `domain.gs`, `server-lib.gs` y `Code.gs`.
   *(Alternativa versionada: `clasp` — ver R10 del ADR-001; el editor web es el respaldo.)*

3. **OAuth Client** en console.cloud.google.com (proyecto GCP **de la cuenta del servicio**):
   credencial OAuth 2.0 de tipo *Aplicación web*; en *Authorized JavaScript origins* añade
   `https://guardias-balmis.github.io`. Publica la *OAuth consent screen* como **In production**
   con solo los scopes `openid email profile` (así no hay verificación ni tope de usuarios —
   ADR-001 A-5). Copia el **Client ID**.

4. **Script Properties** (Proyecto → Configuración): `OAUTH_CLIENT_ID` = el del paso 3;
   `SPREADSHEET_ID` = el del paso 1. (`SESSION_SECRET` se autogenera en el primer uso.)

5. **Desplegar** → *Nueva implementación* → tipo *Aplicación web*:
   - **Ejecutar como: yo** (la cuenta del servicio).
   - **Quién tiene acceso: cualquiera** (`ANYONE_ANONYMOUS`).
   - ⚠️ Cualquier otro modo rompe el CORS del cliente (redirección a login sin `ACAO`).
   - Copia la **URL `/exec`** y fíjala en el cliente (Fase 3). Al re-desplegar, usa *Editar
     implementación → Nueva versión* para **conservar la URL** (crear una nueva la cambia — DR-4).

## Verificación E2E (los puntos 🧪 del ADR-002)
- `GET /exec` → responde `{ok:true, nonce:...}` (cadena CORS 302→GET, `res.json()` legible).
- Login GIS → `POST` con el ID token → `{ok:true, session}`; reintento con el mismo nonce → falla.
- `validar` con un cuadrante de prueba → devuelve las mismas violaciones que el cliente.
- Matar el proceso a media `rebuildSheet` y confirmar que el siguiente intento se autorrepara.
- **Fase 7.1, pendiente de verificar en vivo (código completo, sin Sheet real hasta hoy):**
  `publicarCuadrante` con un cuadrante de prueba → abrir la pestaña "YYYY-MM" creada y
  comprobar que las celdas de código y las fórmulas COUNTIF/SUMPRODUCT de cada fila calculan
  el total esperado (no solo que la operación no da error); abrir "Resumen" y comprobar que
  su SUMIF referencia esa pestaña por nombre y su MAXIFS/MINIFS de equidad calcula bien con
  ≥2 residentes de la misma cohorte.

## Mantenimiento (ritual anual — requisito rector)
Cada enero, el R3 responsable entrante **inicia sesión en la cuenta del servicio** y abre Gmail
y el Sheet (mantiene viva la cuenta y el OAuth client — ADR-001 R1/R2). Anota aquí quién y cuándo.
