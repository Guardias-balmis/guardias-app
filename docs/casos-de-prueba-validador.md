# Casos de prueba para el validador de invariantes

Checklist en texto plano, no código — pensado para que el validador de
la Fase 1 (`docs/adr/001-arquitectura.md`) se pueda contrastar contra
situaciones límite concretas antes de darse por terminado. Cada fila:
una situación real y qué debería hacer el validador ante ella. Basado en
`docs/normativa.pdf`, `GUARD_COMPOSITION_RULES.md`, `EQUITY_SYSTEM.md` y
`GUARD_SHIFT_TIME_RULES.md`, ya en el repo.

---

## Composición de la pareja

| # | Situación | Comportamiento esperado |
|---|---|---|
| C1 | Guardia con 2 residentes Mayores (R3/R4), ningún Pequeño | Rechazar — nunca dos del mismo grupo, sin excepción |
| C2 | Guardia con 2 residentes Pequeños (R1/R2), ningún Mayor | Rechazar — misma regla, sin excepción (ni siquiera "2 R1", que está explícitamente prohibida siempre) |
| C3 | Guardia con 1 Mayor + 1 Pequeño, entre junio y diciembre, y el Pequeño es un R1 | Aceptar como "mochila" (guardia parcial hasta las 20:00) — no es un caso especial que rechazar |
| C4 | Falta un R2 un día de "mochila" del R1, y se asigna un R4 solo con el R1 | Aceptar — combinación preferente ante la falta de R2 |
| C5 | Mismo caso que C4, pero con un R3 en vez de R4 | Aceptar, pero de menor preferencia que C4 — el validador puede aceptarlo, el generador debería preferir C4 primero |
| C6 | Guardia con 2 R2, fechada en julio | Rechazar — la excepción "2 R2" solo aplica desde diciembre-enero en adelante |
| C7 | Guardia con 2 R2, fechada en enero, sin ninguna justificación registrada | Rechazar o marcar como incidencia — la excepción exige justificación explícita, no basta con la fecha |
| C8 | Guardia con 2 R2 en enero, con justificación registrada (rotación externa de mayores) | Aceptar |
| C9 | Un R1 en periodo de mochila (junio-diciembre) asignado a guardia completa (no parcial) | Marcar como incidencia — fuera del periodo de mochila, un R1 no debería hacer guardia completa antes de enero |

## Cobertura mínima diaria

| # | Situación | Comportamiento esperado |
|---|---|---|
| CO1 | Un día del periodo sin ninguna guardia asignada en absoluto | Rechazar — cobertura mínima incumplida (1 Mayor + 1 Pequeño todos los días, sin excepción) |
| CO2 | Un día con guardia de Mayores pero sin guardia de Pequeños (agenda de Pequeños vacía ese día) | Rechazar — cobertura cruzada incumplida, aunque cada mitad del cuadrante sea internamente válida |

## Carga mensual

| # | Situación | Comportamiento esperado |
|---|---|---|
| M1 | Un residente con 3 guardias en un mes normal (sin ausencias) | Marcar como incidencia — por debajo del mínimo de 4 |
| M2 | Un residente con 7 guardias en un mes normal | Marcar como incidencia — por encima del máximo de 6 |
| M3 | Un residente con 2 guardias en un mes en que estuvo de vacaciones 15 días | Aceptar — el cupo se reduce proporcionalmente por la ausencia |
| M4 | Un residente con 4 guardias en febrero (mes corto) | Aceptar — la normativa ya prevé febrero como mes con cifras distintas |

## Equidad (cierre del año de residencia)

| # | Situación | Comportamiento esperado |
|---|---|---|
| E1 | Dos R3 del mismo año con 18 y 19 guardias totales al cierre del año | Aceptar — diferencia de 1, dentro del límite |
| E2 | Dos R3 del mismo año con 18 y 21 guardias totales al cierre del año | Marcar como incidencia — diferencia de 3, incumple |
| E3 | Comparar un R3 con un R1 por número de guardias | No aplica la regla de equidad directamente — la comparación es dentro del mismo año formativo, salvo el caso ya documentado de responsabilidad asistencial equivalente (R4↔R3) |
| E4 | Dos R4 con diferencia de 2 fines de semana entre sí | Marcar como incidencia — máximo 1 de diferencia en el eje "fin de semana" |
| E5 | Un residente con 3 dobletes y otro del mismo año con 1 doblete | Marcar como incidencia — máximo 1 de diferencia en dobletes |
| E6 | Un residente con más 3er puesto que otro del mismo año, pero mismo número de guardias obligatorias | Aceptar — el 3er puesto no cuenta para la equidad obligatoria (se registra aparte) |
| E7 | Junio/julio/agosto, comparación de equidad entre R1 y R2 (grupo Pequeño sin los R1 organizando por separado) | El recuento de esos meses se hace solo entre los R2 del mismo año — el R1 no entra en esa comparación todavía |

## Horario y tipo de guardia

| # | Situación | Comportamiento esperado |
|---|---|---|
| H1 | Guardia un lunes común | Horario 15:00–08:00 (día siguiente laborable) |
| H2 | Guardia un viernes, sábado siguiente normal | Horario 15:00–09:00 |
| H3 | Guardia un domingo, lunes siguiente laborable | Horario 09:00–08:00 |
| H4 | Guardia un festivo entre semana, seguido de un día laborable | Horario 09:00–08:00 (igual que domingo) |
| H5 | Guardia un festivo, seguido de OTRO festivo o fin de semana | Horario 09:00–09:00 — el caso "según corresponda" que la propia normativa deja abierto y que la regla de dos factores sí resuelve |
| H6 | Guardia el 25 de diciembre (festivo especial) | Mismo horario que un festivo normal, pero retribución DOBLE — la única categoría con retribución distinta |
| H7 | Guardia un día "puente" | Mismo horario y retribución que un laborable — no existe un tipo de guardia "puente" propio |
| H8 | Un periodo que cruza del 31 de diciembre al 1 de enero | Riesgo conocido y sin resolver todavía en el proyecto original (frontera entre años de `calendario`) — vale la pena que el validador de tu amigo lo tenga presente como caso límite a probar explícitamente, no asumido como "ya andará" |

## Disponibilidad

| # | Situación | Comportamiento esperado |
|---|---|---|
| D1 | Asignar una guardia a un residente con vacaciones aprobadas (bloqueo DURO) ese día | Rechazar siempre, sin excepción |
| D2 | Asignar una guardia a un residente con una preferencia BLANDA para esa fecha | Aceptar igual — es una preferencia, no una obligación; el generador debería evitarlo si hay alternativa, pero el validador no debe rechazarlo |
| D3 | Un residente de rotación externa en la provincia de Alicante sin ninguna guardia de viernes o sábado en el periodo | Marcar como incidencia — la normativa exige al menos una guardia de viernes o sábado en ese caso |
| D4 | Más de dos residentes del mismo año ausentes simultáneamente por rotación externa | Marcar como incidencia — la normativa lo prohíbe explícitamente |

## Casos generales / integridad

| # | Situación | Comportamiento esperado |
|---|---|---|
| G1 | El mismo residente con dos guardias distintas el mismo día | Rechazar — un residente no puede tener dos guardias el mismo día |
| G2 | Un doblete viernes-domingo marcado, pero el domingo no tiene guardia real asignada a ese residente | Rechazar o marcar como incidencia — un doblete exige las dos guardias reales, no solo la marca |
| G3 | Cuadrante de Mayores publicado antes que el de Pequeños del mismo periodo | Aceptar — el orden "mayores primero" es preferente, no obligatorio |
| G4 | Cuadrante con una guardia asignada a un residente que causó baja antes de esa fecha | Rechazar — no se puede asignar a alguien que ya no está activo en esa fecha |

---

No se ha escrito código en este documento — es un checklist para
contrastar contra la implementación real del validador, no una
especificación de cómo programarlo.
