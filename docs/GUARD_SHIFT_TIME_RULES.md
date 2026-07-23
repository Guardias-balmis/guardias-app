# Regla de tipo y horario de las guardias

Documento exclusivamente de definición de regla de negocio. No contiene
código, no modifica ningún archivo existente. Formaliza, antes de empezar
la implementación de `calendario`, cómo se deriva el **tipo de guardia**
(`TipoGuardia`: nombre y retribución) y su **horario** a partir de la
clasificación de días que ese módulo va a exponer — aunque la regla en sí,
como se explica en el punto 3, no pertenece al dominio de `calendario`
sino al de `planificacion`.

**Corrección respecto a la versión original de este documento**, hecha al
abrir el Sprint C.3 de `planificacion` (dominio y persistencia de
`TipoGuardia` ya construidos en C.1/C.2, pero sin la función de resolución
del catálogo, que faltaba por completo): el dato que el dominio de
`planificacion` necesita en primer lugar de una `GuardiaPlanificada` es su
**`TipoGuardia`** — es lo que se usa para contar guardias, aplicar reglas
de negocio (composición, cobertura, carga mensual y, más adelante,
equidad) y fijar la retribución. `TipoGuardia` y `HorarioGuardia` se
determinan mediante **dos cálculos independientes que parten de los
mismos datos de entrada** (`tipo_dia` de la fecha y, cuando corresponde,
su día de la semana) — uno no deriva del otro, y el horario **no se
obtiene del `TipoGuardia`** ni de la fila que el catálogo asocia a su
`nombre` (sección 4.2 explica por qué). El horario es un dato derivado,
necesario para la ejecución operativa (a qué hora debe presentarse el
residente) y para la exportación (RF-26), pero no es la unidad sobre la
que operan las reglas de `planificacion`: composición, cobertura, carga
mensual y equidad cuentan **guardias**, no horas. La versión original de este documento invertía
esa prioridad porque se escribió antes de que `DOMAIN_DESIGN_PLANIFICACION.md`
modelara `TipoGuardia` como catálogo (corrección de ese documento, sección
3, hecha al abrir el Sprint C.2): en aquel momento solo existía la
necesidad de derivar horario, no de resolver una fila de catálogo. La
regla de horario en sí (sección 4.2) no cambia — se reordena y se
completa con la resolución del tipo, que faltaba.

---

## 1–3. Dónde vive esta regla, y dónde no

1. **El calendario únicamente clasifica los días.** Su única salida es
   `tipo_dia` (y, cuando aplica, `ambito_festivo`/`nombre_festivo`) para
   una fecha — tal como quedó fijado en `DOMAIN_DESIGN_CALENDARIO.md`.
2. **El calendario no conoce tipos de guardia ni horarios.** Ningún Value
   Object, entidad, invariante o caso de uso de `calendario` menciona una
   hora de inicio o fin, ni el catálogo `TipoGuardia`. Esto ya estaba
   señalado explícitamente en la sección 10 de ese documento ("Qué
   horario y retribución corresponde a cada tipo de guardia sobre un tipo
   de día → pertenece a `planificacion`").
3. **El tipo de guardia y su horario pertenecen al dominio de
   Planificación.** Este documento formaliza, por tanto, una regla que
   condiciona `DOMAIN_DESIGN_PLANIFICACION.md` — se define ya, antes de
   implementar `calendario`, porque condiciona qué información debe poder
   exponer `calendario` con precisión suficiente (la clasificación
   `tipo_dia` del día en curso *y* del día siguiente) para que
   `planificacion` pueda aplicarla sin ambigüedad más adelante.

---

## 4. Dos cálculos independientes sobre el mismo `tipo_dia`: `TipoGuardia` y `HorarioGuardia`

`DOMAIN_DESIGN_PLANIFICACION.md`, sección 3, modela `TipoGuardia` como
catálogo cerrado de 7 filas (`nombre`, `hora_inicio`, `hora_fin`,
`retribucion_tipo`), pero no fijaba cómo se elige, para una fecha dada,
cuál de esas 7 filas corresponde — esta sección lo hace explícito.

Esta sección fija **dos cálculos distintos, no uno que derive del otro**:
la sección 4.1 determina el `nombre`/`retribucion_tipo` del `TipoGuardia`
— el dato que le importa al dominio, porque es lo que cuentan las reglas
de composición, cobertura, carga mensual y equidad. La sección 4.2
calcula el `HorarioGuardia` por separado, aplicando la regla de dos
factores ya vigente. Ambos parten de los mismos datos de entrada
(`tipo_dia` de la fecha, y su día de la semana cuando aplica), pero **el
horario nunca se lee ni se deriva de la fila de catálogo que resuelve
4.1** — la razón exacta está en 4.2.

### 4.1. Cómo se determina el nombre y la retribución (dato primario)

Especificado en el **SRS, sección 5.1** (tabla de tipos de guardia) y en
`Reglas_de_Negocio_App_Guardias.docx`, **RN-15 a RN-19**. A diferencia del
horario (sección 4.2), el nombre y la retribución de un `TipoGuardia`
dependen **únicamente del propio día** — nunca del día siguiente:

| `tipo_dia` (de `calendario`) | Día de la semana | `nombre` (`TipoGuardia`) | `retribucion_tipo` | Fundamento |
|---|---|---|---|---|
| `LABORABLE` | Lunes a jueves | `SEMANA` | `NORMAL` | SRS 5.1, "Entre semana (lunes a jueves)" |
| `LABORABLE` | Viernes | `VIERNES` | `NORMAL` | SRS 5.1, "Viernes" |
| `FIN_DE_SEMANA` | Sábado | `SABADO` | `NORMAL` | SRS 5.1, "Sábado" |
| `FIN_DE_SEMANA` | Domingo | `DOMINGO` | `NORMAL` | SRS 5.1, "Domingo" |
| `FESTIVO` | (no aplica) | `FESTIVO` | `NORMAL` | RN-16: "los festivos entre semana funcionan horariamente como un domingo" — la equivalencia es de horario, no de retribución; RN-15 no incluye a `FESTIVO` en la excepción de RN-17 |
| `FESTIVO_ESPECIAL` | (no aplica) | `FESTIVO_ESPECIAL` | `DOBLE` | RN-17: única excepción de retribución del catálogo — "mantienen el horario/funcionamiento de un festivo normal, pero se retribuyen el doble" |
| `PREFESTIVO` | (no aplica) | `PREFESTIVO` | `NORMAL` | RN-19: "mantiene horario y retribución de una guardia entre semana estándar" |
| `PUENTE` | Lunes a jueves | `SEMANA` | `NORMAL` | Sin fila propia en la tabla 5.1 del SRS — no existe un tipo de guardia "puente" distinto. Se resuelve como si el día fuera `LABORABLE`, mismo criterio que la sección 4.2 ya aplicaba solo al horario |
| `PUENTE` | Viernes | `VIERNES` | `NORMAL` | Idem |

Esta tabla **no necesita el `tipo_dia` del día siguiente** — la fecha ya
trae consigo su propio día de la semana (`fecha.weekday()`), sin requerir
ningún dato adicional de `calendario` más allá del `tipo_dia` de esa misma
fecha. Con el `nombre` resuelto, `tipo_guardia_id` y `retribucion_tipo` se
obtienen localizando la fila del catálogo `TipoGuardia` con ese `nombre`
(restricción única `uq_tipos_guardia_nombre`, ya construida en C.2).

**Aviso importante — esta tabla es más fina que la de la sección 4.2, a
propósito.** La tabla de "Precisión" de la sección 4.2 trata
`FESTIVO_ESPECIAL` como equivalente a `FESTIVO` y no distingue sábado de
domingo ni viernes del resto de laborables — pero eso es válido
únicamente **a efectos de horario** (ninguna de esas distinciones cambia
la hora de inicio/fin). Para el `nombre`/`retribución` del catálogo sí
importan todas esas distinciones (`FESTIVO_ESPECIAL` tiene retribución
`DOBLE`; `SABADO`/`DOMINGO`/`VIERNES`/`SEMANA` son filas de catálogo
distintas). No es una contradicción entre ambas tablas — son respuestas a
preguntas distintas sobre el mismo `tipo_dia` de entrada.

### 4.2. Cómo se calcula el `HorarioGuardia` (cálculo independiente, no derivado de 4.1)

El `HorarioGuardia` **no se obtiene del `TipoGuardia`** resuelto en 4.1 —
es un cálculo aparte que comparte el mismo `tipo_dia` de entrada, pero
sigue su propia regla de dos factores (día en que empieza la guardia +
día siguiente), fijada más abajo. La fila de catálogo localizada en 4.1
sí trae un `hora_inicio`/`hora_fin` de referencia (una fila, un único
valor cada uno), pero **ese valor no se usa para fijar el horario real de
la guardia**: una fila fija de catálogo no puede representar el caso
"según corresponda" que introduce el día siguiente para
`FESTIVO`/`FESTIVO_ESPECIAL`/`PREFESTIVO` (ver la fila "Festivo" de la
verificación cruzada más abajo). Esta es la misma razón, ya acordada en
el Sprint C.2, por la que `guardias.hora_inicio`/`hora_fin` están
desnormalizados en la tabla `Guardia` en vez de resolverse por *join*
contra `tipos_guardia`.

- **Hora de inicio**, según el tipo del día en que comienza la guardia:
  - Día laborable → 15:00
  - Sábado → 09:00
  - Domingo → 09:00
  - Festivo → 09:00
- **Hora de finalización**, según el tipo del día siguiente:
  - Si el día siguiente es laborable → 08:00
  - Si el día siguiente es sábado, domingo o festivo → 09:00

---

## Precisión: esta enumeración y las 6 categorías de `TipoDia` (para el horario de la sección 4.2)

`calendario` clasifica los días en 6 categorías, no 4:
`LABORABLE`, `FIN_DE_SEMANA`, `FESTIVO`, `FESTIVO_ESPECIAL`, `PREFESTIVO`,
`PUENTE` (`DOMAIN_DESIGN_CALENDARIO.md`, sección 5). La enumeración de la
regla 4.2 usa 4 etiquetas ("laborable", "sábado", "domingo", "festivo")
que no cubren literalmente `FESTIVO_ESPECIAL`, `PREFESTIVO` ni `PUENTE`,
ni distinguen sábado de domingo por separado. No lo dejo como ambigüedad:
lo resuelvo explícitamente aquí, apoyado en reglas de negocio ya
congeladas — no es una decisión nueva, es hacer explícita una que ya
estaba implícita en el catálogo RN-01 a RN-64. Recordatorio: esta tabla
resuelve **solo horario**; para `nombre`/`retribución` del catálogo, usar
la tabla más fina de la sección 4.1.

| Categoría de `TipoDia` | Tratamiento a efectos de horario | Fundamento |
|---|---|---|
| `LABORABLE` | Igual que "día laborable" de la regla 4.2 | Caso base |
| `FIN_DE_SEMANA` | Igual que "sábado" y "domingo" de la regla 4.2, **sin distinguir cuál de los dos es** | La regla 4.2 asigna el mismo resultado (09:00) a sábado y a domingo en ambos casos — no hay ninguna combinación en la que distinguirlos cambie el resultado. `calendario` ya expone `FIN_DE_SEMANA` como una única categoría (Diseño de Base de Datos, catálogo de `tipo_dia`); no hace falta pedirle que distinga sábado de domingo para esta regla |
| `FESTIVO` | Igual que "festivo" de la regla 4.2 | Caso base |
| `FESTIVO_ESPECIAL` | **Igual que `FESTIVO`** | RN-17: "mantienen el horario/funcionamiento de un festivo normal... se diferencia únicamente en la retribución". La diferencia de festivo especial es de *retribución* (ya resuelta en 4.1), nunca de horario |
| `PREFESTIVO` | **Igual que `LABORABLE`** | RN-19 / SRS tabla 5.1: "horario y retribución de guardia entre semana estándar; la particularidad es que el descanso posterior coincide con el festivo" — el horario de inicio de un prefestivo es el de un laborable; lo único distinto es que, al día *siguiente*, el fin de guardia cae en festivo (regla 4.2 ya lo cubre solo con saber que el día siguiente es festivo) |
| `PUENTE` | **Igual que `LABORABLE`** | La tabla 5.1 del SRS no tiene ninguna fila para "puente" — no existe un horario ni una retribución distintos para un día puente (mismo criterio que 4.1). Es coherente con lo ya establecido en `DOMAIN_DESIGN_CALENDARIO.md`: puente es una propiedad relevante para equidad y vacaciones, no para horario de guardia |

Con esta precisión, la regla queda completa para las 6 categorías que
`calendario` realmente expone, sin dejar ningún `tipo_dia` sin resolver.

### Verificación cruzada contra la tabla 5.1 del SRS

Para confirmar que la regla no contradice nada ya documentado, se
reconstruye cada fila de la tabla 5.1 aplicando únicamente la regla 4.2
(con la precisión anterior):

| Fila de la tabla 5.1 | Tipo del día de inicio | Tipo del día siguiente | Resultado de la regla | ¿Coincide con el SRS? |
|---|---|---|---|---|
| Entre semana (lun-jue) | Laborable → 15:00 | Laborable (mar-vie) → 08:00 | 15:00–08:00 | Sí |
| Viernes | Laborable → 15:00 | Fin de semana (sábado) → 09:00 | 15:00–09:00 | Sí |
| Sábado | Fin de semana → 09:00 | Fin de semana (domingo) → 09:00 | 09:00–09:00 | Sí |
| Domingo | Fin de semana → 09:00 | Laborable (lunes) → 08:00 | 09:00–08:00 | Sí |
| Festivo (entre semana) | Festivo → 09:00 | Depende del día siguiente real (08:00 si laborable, 09:00 si no) | Resuelve exactamente la ambigüedad "según corresponda" que la propia tabla 5.1 deja sin especificar | Sí, y la mejora |
| Festivo especial | Festivo especial ≡ Festivo → 09:00 | Igual que festivo | 09:00–(según día siguiente) | Sí |
| Prefestivo | Prefestivo ≡ Laborable → 15:00 | Festivo (por definición de prefestivo) → 09:00 | 15:00–09:00 | Sí |

Las 7 filas de la tabla del SRS se reproducen exactamente a partir de solo
dos preguntas (tipo del día de inicio, tipo del día siguiente) — incluida
la fila "Festivo", donde la regla resuelve una ambigüedad ("según
corresponda") que la propia tabla del SRS deja abierta. Es precisamente
esta fila la que confirma por qué el horario (4.2) no puede resolverse
copiando la fila del catálogo elegida en 4.1: dos guardias con el mismo
`nombre` (`FESTIVO`) pueden tener `hora_fin` distinta según el día
siguiente real.

---

## 6. Por qué esta regla es más robusta que modelar excepciones individuales

**Es composicional, no enumerativa.** La tabla 5.1 del SRS se lee como 7
hechos independientes que memorizar y mantener sincronizados. En realidad
son la combinación de solo dos factores (tipo del día de inicio, tipo del
día siguiente) sobre solo dos categorías de horario (09:00 / 15:00 para el
inicio; 08:00 / 09:00 para el fin). Modelarlo como 7 casos con nombre
propio ("caso Viernes", "caso Domingo"...) obliga a mantener 7 lugares en
sincronía cada vez que algo cambie; modelarlo como una función de dos
factores tiene un único lugar que mantener. (Esto aplica al horario,
sección 4.2 — la resolución de `nombre`/`retribución` de la sección 4.1
es, en cambio, una función de un único factor por fecha, sin necesitar el
día siguiente, precisamente porque no sufre la ambigüedad "según
corresponda".)

**Cubre combinaciones que la tabla nunca enumeró, sin necesitar una fila
nueva por cada una.** La tabla 5.1 no dice qué pasa si un festivo cae justo
antes de otro festivo (p. ej. 24 y 25 de diciembre, ambos festivos
especiales consecutivos), ni qué pasa si un puente cae inmediatamente
después de un prefestivo. Un modelo por excepciones necesitaría anticipar
y enumerar cada combinación real antes de que ocurra. La regla
composicional las resuelve todas automáticamente, porque nunca necesitó
conocer la combinación de antemano — solo necesita poder clasificar
cualquier día y su siguiente, algo que `calendario` ya garantiza para
los 365/366 días de cualquier año.

**Es la misma disciplina que ya se exige al resto del sistema.** El
principio ya establecido en `FLEXIBLE_COHORTS_REVIEW.md` ("la cohorte es
una consulta, nunca un dato almacenado") tiene aquí su equivalente: *el
horario es una función del tipo de día, nunca una tabla de fechas
codificadas*. Ninguna fecha concreta ("24 de diciembre") ni ninguna regla
por nombre de día ("el caso Viernes") aparece en la regla — solo
categorías de `tipo_dia`, que son universales para cualquier hospital,
cualquier país y cualquier año, tal como exige la genericidad del proyecto.

**Reduce la superficie de prueba.** Verificar 7 casos con nombre propio
exige 7 pruebas (como mínimo) que no garantizan cubrir combinaciones no
previstas. Verificar una función de dos factores con 6 categorías de
entrada cada uno exige probar la función de mapeo (6 casos) más la
composición (un puñado de combinaciones representativas) — y cualquier
combinación no probada explícitamente sigue siendo correcta porque se
deriva de las mismas dos reglas ya verificadas, no de un caso nuevo sin
probar.

---

## 7. Cómo debe usar esta información el motor de planificación

El motor **no calcula ni almacena horarios ni tipos de guardia** como
parte de su propio razonamiento combinatorio — los consume como un dato
ya resuelto, en el paso de ingesta de datos (sección "0. Ingesta de
datos" del documento de Diseño Técnico del Motor de Planificación), no
como parte del espacio de búsqueda del solver:

1. **Para cada día del periodo a planificar**, el motor consulta a
   `calendario` el `tipo_dia` de esa fecha *y* el de la fecha siguiente —
   nunca asume ninguno de los dos a partir del calendario natural (día de
   la semana), siempre los pide.
2. **Resuelve el `nombre` del `TipoGuardia`** (sección 4.1, a partir
   únicamente del `tipo_dia` de esa fecha y de su día de la semana — no
   necesita el día siguiente para esto) y localiza la fila
   correspondiente del catálogo `TipoGuardia` de `planificacion` — el
   catálogo ya cerrado de 7 tipos que el Diseño de Base de Datos define.
   De ahí obtiene `tipo_guardia_id` y `retribucion_tipo`.
3. **Aplica, por separado, la regla de horario** (sección 4.2, con la
   precisión de la sección homónima) para obtener `(hora_inicio,
   hora_fin)` — este paso sí necesita el `tipo_dia` de la fecha siguiente.
   El resultado **no** se lee de la fila de catálogo localizada en el
   paso 2 (esa fila trae un horario de referencia, no necesariamente el
   real — ver la salvedad de la sección 4.2).
4. `tipo_guardia_id`, `retribucion_tipo` y `(hora_inicio, hora_fin)` se
   fijan en la fila de `Guardia` en el momento de crearla, tal como ya
   establece el Diseño de Base de Datos (sección 7.2: "para que el
   historial de guardias ya realizadas no cambie retroactivamente si en
   el futuro se ajustan las reglas de cálculo del tipo de día") — esta
   regla se aplica **una vez, en el momento de la asignación**, no se
   recalcula cada vez que se consulta una guardia ya creada.
5. **En modo incremental** (validación en tiempo real de un cambio de
   guardia), se aplica exactamente la misma regla, sin ninguna rama de
   código distinta — son las mismas dos resoluciones (tipo, horario) y la
   misma consulta a `calendario`, solo que para una única fecha en vez de
   para todo un periodo.
6. El motor **nunca debe hardcodear** qué fechas de un año concreto
   producen qué tipo de guardia u horario — igual que no debe hardcodear
   cuántos residentes hay en una cohorte (`FLEXIBLE_COHORTS_REVIEW.md`),
   no debe hardcodear qué día es festivo o puente: siempre lo pregunta a
   `calendario` para la fecha concreta que está procesando en ese momento.

---

## Nota de alcance

Esta regla queda definida y lista para incorporarse al diseño de
aplicación de `planificacion` (Sprint C.3). No se ha modificado
`DOMAIN_DESIGN_CALENDARIO.md` ni ningún otro documento — la resolución de
`nombre`/`retribución` (sección 4.1) y la precisión de horario (secciones
4.2 y "Precisión...") están documentadas únicamente aquí, y deberán
citarse desde `DOMAIN_DESIGN_PLANIFICACION.md`/la implementación de C.3 en
vez de duplicarse.
