# Resumen: reglas de equidad y descanso — aporte al validador de invariantes

Contexto: comparé `docs/normativa.pdf` (la misma normativa de 4 páginas
que usa el proyecto) contra un trabajo de análisis de reglas de negocio
que hice en paralelo para la misma app. La base de equidad coincide
exactamente con la normativa (5 ejes: total, fin de semana, festivo,
puente, doblete — diferencia máxima de 1 en cada uno). Lo que sigue son
**cuatro documentos que van más allá de lo literal de la normativa**,
pensados como texto plano para alimentar el validador de invariantes /
el prompt que arma la app — no requieren ningún cambio de arquitectura,
no dependen de Python ni de ningún backend concreto.

## 1. Horario y tipo de guardia (`GUARD_SHIFT_TIME_RULES.md`)

Formaliza el horario de cada guardia como una función de **dos factores**
(tipo del día en que empieza + tipo del día siguiente), en vez de una
tabla de 7 casos memorizados. Resuelve una ambigüedad que el propio
Excel/normativa deja abierta ("festivo... según corresponda") y cubre
combinaciones que ninguna tabla fija enumera (dos festivos seguidos,
puente pegado a un prefestivo). Útil para detectar el mismo tipo de bug
que ya encontraron en `index.html` (el desfase de un mes): una regla
compositiva no se puede desincronizar como una tabla de fechas.

## 2. Composición de la pareja de guardia (`GUARD_COMPOSITION_RULES.md`)

Jerarquía explícita: **cobertura asistencial siempre antes que
equidad** — ninguna solución que dé mala cobertura es aceptable aunque
reparta guardias de forma perfecta. Formaliza la regla de la "mochila"
del R1 (junio-diciembre), la prioridad de quién debe acompañar al R1
cuando falta un R2, y el criterio para sugerir en vivo dónde colocar al
R1 durante la sesión de reparto — justo el tipo de ayuda que reduce la
reunión de 3 horas.

## 3. Sistema de equidad ponderado (`EQUITY_SYSTEM.md`)

Propone un índice de puntos (no sustituye a los 5 ejes oficiales, es una
capa adicional) que pesa cada tipo de guardia de forma distinta —hoy un
viernes y un lunes cuentan igual como "guardia", pese a que un viernes
es más larga y es el inicio real del fin de semana. Incluye bonos por
doblete y por aprovechar un puente, y un mecanismo de "saldo pendiente"
que sigue a la persona (no al año formativo) cuando un desequilibrio no
llegó a compensarse antes de cerrar el curso.

## 4. Impacto real de una guardia sobre el descanso (`VACATION_IMPACT_MODEL.md`) — el aporte más importante

**Esto no está en la normativa de ninguno de los dos proyectos.** La
idea: contar categorías de día (festivo, puente...) es una aproximación
imperfecta de lo que de verdad le importa a un residente — el tamaño real
del **periodo continuo de descanso** que una guardia le bloquea.

Dos guardias con la misma etiqueta (`LABORABLE → FESTIVO`) pueden tener
impacto radicalmente distinto: una recorta un solo día suelto, la otra
recorta el primer día de un puente de cuatro. Y una guardia en el
**interior** de un periodo largo (no en el borde) lo **fragmenta** en dos
trozos inútiles, en vez de solo recortarlo — pierde valor mucho más allá
de "un día menos". El documento formaliza esto como principio (secciones
7 y 10.5), sin fórmula ni peso todavía — eso queda para cuando se decida
implementarlo.

**Por qué importa para el objetivo de "sin reuniones de 3 horas":** es
exactamente la clase de conflicto invisible que hoy se detecta a mano,
discutiendo caso por caso ("che, a mí esa guardia me arruina el puente
entero") — formalizado, un validador puede señalarlo solo.

---

**Próximo paso sugerido:** si les parece razonable, se puede incorporar
como `docs/reglas-equidad-descanso.md` (o los 4 archivos por separado) en
el repo, para que el "paquete de generación" del prompt portátil (ADR-001,
§6) los incluya como texto — sin tocar nada de arquitectura ya decidida.