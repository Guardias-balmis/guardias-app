# Propuesta P-10: vacaciones bloqueadas en fechas de evento sin visto bueno

Hallado leyendo `docs/normativa.pdf` directamente el 2026-08-01 — no
proviene de ningún documento anterior de `docs/`, ni de una IA leyendo
otra IA: es la primera vez que se contrasta esta frase concreta contra
lo ya implementado. Página 3, sección "Eventos del servicio":

> En esas fechas no se puede optar a vacaciones sin el visto bueno de
> los compañeros de puesta de guardias, de tutoría y del Jefe de
> Servicio (puesto que cae fuera del periodo vacacional contemplado por
> GVA).

"Esas fechas" son las de los dos eventos del servicio — comidas de
Navidad y despedida de residentes (ya cubiertos por INV-10). La
normativa exige un visto bueno de **tres partes distintas** (compañeros
de guardia, tutoría, Jefe de Servicio) antes de aprobar una vacación que
caiga en esas fechas, precisamente porque cae fuera del periodo
vacacional oficial de la GVA.

## Por qué es un hueco real, no una variante de algo ya cubierto

Hoy `Bloqueo` con `motivo=VACACIONES` es puramente informativo (decisión
V-8, `spec.md` §6): no bloquea la asignación, no produce ninguna
violación por sí sola, y nada en `spec.md` §2 modela una "aprobación" o
un "visto bueno" — ni como campo de `Bloqueo`, ni como entidad propia.
Verificado contra `v2/domain/*.js`, `server/src/*.js` y `spec.md`
completo: no hay ninguna referencia a "visto bueno", "Jefe de Servicio"
ni "GVA" en el código ni en la especificación. A diferencia de INV-12/
INV-13 (ausencias ya reconocidas y con fila propia en §5, solo
pendientes de implementar), esta regla no tiene fila en absoluto
todavía.

## Lo que esta propuesta NO hace

No propone ninguna implementación concreta ni decide cómo modelarla.
Antes de convertirse en invariante haría falta decidir, como mínimo:
si el "visto bueno" es un flag booleano por `Bloqueo`, tres flags
separados (uno por parte que debe aprobar), o un registro aparte con
quién aprobó y cuándo; y si su ausencia debería bloquear (`error`) o
solo avisar (`aviso`), dado el mismo criterio de "la app sobrevive sin
administrador" que ya rebajó casi todo lo demás a `aviso` (V-14) — un
`error` aquí dejaría una vacación de evento sin forma de aprobarse si
alguna de las tres partes no usa la app.

Ver la fila `P-10` en `spec.md` §8.
