# Guardias · Dr. Balmis

Herramienta de organización de guardias de los residentes de Radiodiagnóstico del Hospital General Universitario Dr. Balmis (Alicante).

**App en producción:** https://guardias-balmis.github.io/guardias-app/ (sirve `index.html` de la rama `main` — cada push a `main` despliega).

## Estado

En rediseño (v2). El objetivo rector: que la app funcione ≥10 años sin administrador — niveles R1–R4 derivados de fechas (nadie los sube a mano), historial intocable, y ningún secreto en el navegador.

| Documento | Qué es |
|---|---|
| [`docs/adr/001-arquitectura.md`](docs/adr/001-arquitectura.md) | Decisión de arquitectura v2 (leer primero) |
| [`docs/normativa.pdf`](docs/normativa.pdf) | Normativa de guardias v2.0 — fuente de verdad del dominio |
| [`docs/guardias_radiodiagnostico_balmis_v2.xlsm`](docs/guardias_radiodiagnostico_balmis_v2.xlsm) | Excel actual de contaje — semántica real de códigos y contajes |
| [`docs/auditoria/`](docs/auditoria/) | Auditoría del cliente actual: inventario funcional, sistema de diseño y bugs conocidos |

## Códigos de guardia

`G` guardia · `GF` guardia festiva · `GP` guardia prefestivo · `3P` tercer puesto (voluntario) · `V` vacaciones · `R` rotación externa · `B` baja
