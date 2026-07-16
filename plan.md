# plan.md · Hoja de ruta de guardias-app v2

> Artefacto versionado. Cada fase termina con: tests en verde, `spec.md`/`plan.md` actualizados y
> puerta de consistencia (¿el código contradice la spec? ¿la spec contradice la normativa?).
> No se avanza de fase sin aprobación del autor.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 0 | ADR de arquitectura ([docs/adr/001-arquitectura.md](docs/adr/001-arquitectura.md)) | ✅ **Aceptada** (2026-07-16): stack Google, variante A′ (Apps Script en cuenta del servicio), sin API de Anthropic (generador «prompt portátil»), org de GitHub |
| 1 | **Núcleo de dominio, TDD estricto** — `calendar`, `residents` (nivel/grupo), `tally` (contaje), `validate`/`thirdpost`/`equity` (INV-1..11). Cero I/O | ✅ **Completa** (rama `v2`): 118 tests en verde, cero dependencias. Pendiente puerta de consistencia y aprobación del autor para Fase 2 |
| 2 | Backend Apps Script: verificación de identidad (tokeninfo + sesión HMAC), roles derivados, adaptador de Sheets, `LockService`. Spike CORS | ⬜ Requiere: acceso a cuenta del servicio para desplegar (el desarrollo no) |
| 3 | Cliente: trocear `index.html`, eliminar AdminScreen y todo secreto, alta con fechas, código GP, conservar diseño ([docs/auditoria/cliente-sistema-diseno.json](docs/auditoria/cliente-sistema-diseno.json)) | ⬜ Decisión pendiente: módulos sin build (candidata: ES modules + htm) |
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

## Convenciones de trabajo

- Rama `v2` para todo el desarrollo; `main` es producción de Pages y no se toca hasta el corte.
- TDD estricto en dominio: el test se escribe y falla antes de implementar.
- `npm test` = `node --test 'v2/domain/test/*.test.js'` — sin dependencias, Node ≥ 20.
- Commits en español; código en inglés; JSDoc de dominio en español con referencia a la normativa.
