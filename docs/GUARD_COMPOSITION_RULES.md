# Reglas de composición de la pareja/equipo de guardia — Principio de negocio

Documento exclusivamente de definición de negocio. No contiene código, no
define ninguna implementación técnica, no diseña el futuro
`DOMAIN_DESIGN_PLANIFICACION.md`. Formaliza, con la misma metodología que
`GUARD_SHIFT_TIME_RULES.md`, una regla que pertenece al futuro módulo
`planificacion` — se escribe ahora, antes de que ese módulo exista,
porque condiciona su diseño y porque resuelve una ambigüedad ya señalada
en el propio documento de Reglas de Negocio (`CN-07`). No modifica ni
toca ningún módulo ya implementado (`identidad`, `calendario`).

**Origen:** esto no es una regla de equidad — es un criterio **docente y
de seguridad asistencial**. El sistema debe entender una **jerarquía de
preferencia**, no una regla de permitido/prohibido.

---

## 1. Separación entre cobertura asistencial y equidad

La generación de un calendario persigue dos objetivos distintos y
**jerárquicos**:

1. **Garantizar una cobertura asistencial adecuada** para cada guardia.
2. **Distribuir equitativamente** la carga anual entre los residentes.

La equidad nunca debe comprometer la capacidad asistencial de una
guardia. Cualquier solución candidata debe satisfacer primero los
requisitos mínimos de cobertura antes de ser evaluada desde el punto de
vista de la equidad.

La cobertura asistencial depende de la responsabilidad clínica y la
autonomía de los residentes que componen la guardia (sección 2). La
equidad depende de la distribución acumulada de las guardias y de su
impacto a lo largo del tiempo (`EQUITY_SYSTEM.md`, `VACATION_IMPACT_MODEL.md`).
Son complementarios y **nunca deben confundirse**.

**Esto no es un principio nuevo, es una elevación explícita de algo ya
diseñado**: el documento "Diseño Técnico del Motor de Planificación"
(sección 10.1) ya estructura la optimización por niveles con Nivel 1 —
Factibilidad ("no negociable") **antes** de Nivel 2 — Equidad. Este
documento fija por escrito, como principio de negocio, la misma jerarquía
que el motor ya aplica técnicamente.

---

## 2. Criterios de cobertura asistencial

### 2.1. El principio: capacidad asistencial creciente

**No es una jerarquía de nombres (R4 > R3 > R2 > R1) — la jerarquía es
una consecuencia, no el principio.** El principio es:

> La cobertura de una guardia debe garantizar una capacidad asistencial
> suficiente para la carga de trabajo prevista. Dicha capacidad depende
> del grado de autonomía clínica y diagnóstica de los residentes que la
> integran, por lo que distintas combinaciones de residentes **no son
> equivalentes aunque tengan el mismo número de personas**.

Formulado así, y no como una tabla fija de nombres de año, el criterio
sigue siendo válido si en el futuro cambia el programa MIR, el número de
años de formación o las competencias asignadas a cada nivel — solo
habría que actualizar la tabla de equivalencias de la sección 2.4, nunca
reescribir el principio. Mismo enfoque ya usado en `EQUITY_SYSTEM.md` §4
y en `INSTITUTIONAL_CONTINUITY.md` §3.1: fijar el principio, documentar
después cómo se aplica hoy.

**Aplicación de este principio en el programa formativo actual:** un R4
aporta mayor autonomía asistencial que un R3, un R3 más que un R2, y un
R2 más que un R1 — de ahí la jerarquía R4 > R3 > R2 > R1 que aparece en
el resto de este documento, siempre como consecuencia, no como axioma.

### 2.2. Cronología del R1

- **De junio a diciembre del año en que el R1 se incorpora**: periodo de
  mochila (RN-22) — el R1 se acopla como tercero a una guardia ya en
  curso y se retira a las 20:00h. No realiza la guardia completa.
- **Desde enero del año siguiente**: el R1 empieza a hacer guardia
  completa. Esta etapa se divide, a su vez, en dos semestres con
  criterios de composición distintos (sección 2.4).

### 2.3. Prioridad de colocación durante la mochila (regla dura, no preferencia)

El R1 en mochila no se coloca "donde convenga" — su colocación sigue un
orden de prioridad estricto:

1. **Primero, cubrir huecos reales**: días del mes en los que solo hay un
   residente Mayor asignado (un R4 o un R3 solos, sin su Pequeño
   habitual). El R1 se acopla ahí, completando la supervisión hasta las
   20:00h.
2. **Solo si no queda ningún hueco de ese tipo** en el mes, el R1 podría
   acoplarse como tercero adicional a una guardia que ya tiene su pareja
   completa (1 Mayor + 1 Pequeño).

**Esto es una restricción dura, no una preferencia de confort**: si en un
mes existe al menos un día con un Mayor solo sin cubrir, el R1 debe
asignarse ahí — no puede optar por sumarse a una guardia ya doblada en su
lugar.

### 2.4. Composición durante la guardia completa: dos semestres, dos criterios

El estatus de una composición de dos residentes con un R1 **depende del
momento del año formativo**, no es fijo — no debe tratarse siempre como
excepción ni siempre como normal.

**Primer semestre (aproximadamente enero-junio, justo tras terminar la
mochila):**

- Composición ideal, con disponibilidad: **R3/R4 + R2 + R1** (equipo de
  tres) — se prioriza claramente la presencia de un R2.
- Si solo pueden quedar dos residentes: preferible **R4 + R1**, y en su
  defecto **R3 + R1** — **nunca R2 + R1**. El R1 todavía no tiene
  autonomía diagnóstica suficiente para quedar acompañado únicamente por
  un R2.

**Segundo semestre (aproximadamente de junio hasta que el R1 finaliza su
primer año de guardias):**

- El R1 ya trabaja con un grado de autonomía muy próximo al que tendrá
  como R2.
- Si hay un R2 disponible, **sigue siendo preferible R3/R4 + R2 + R1**
  — aumenta la capacidad asistencial y mejora el reparto de la carga.
- Si **no** hay ningún R2 disponible, **R3/R4 + R1 deja de ser una
  excepción**: pasa a ser una composición asistencialmente válida en esta
  fase, no un mal menor.

**Reglas que no cambian con el semestre:**

- **R2 + R1 (dos residentes) nunca es una composición válida**, en
  ningún semestre — el residente de mayor responsabilidad seguiría
  siendo un R2, y el R1 todavía no puede asumir actividad diagnóstica con
  la autonomía suficiente para quedar acompañado solo por él.
- **R2 + R2 es exclusivamente un recurso de contingencia**, solo ante
  situaciones excepcionales de difícil cobertura, para evitar dejar una
  guardia descubierta — nunca una composición objetivo, independientemente
  del semestre.

---

## 3. Qué cuenta y qué no cuenta en el total de guardias

Dos mecanismos distintos comparten la misma naturaleza —presencia
parcial, no guardia completa— y por eso comparten el mismo tratamiento en
el conteo, aunque **no deben confundirse entre sí** (sección 4):

| Mecanismo | ¿Cuenta en el total de guardias (RN-24, eje "Total")? | Fundamento |
|---|---|---|
| Mochila del R1 (junio-diciembre de su año de incorporación) | **No** | Es presencia parcial (hasta las 20h), no guardia completa; el conteo real del R1 empieza en enero del año siguiente |
| Tercer puesto voluntario (RN-34 a RN-38), incluida su variante parcial (alguien que se suma cuando la pareja ya está doblada y se retira antes de completar la guardia) | **No**, en ninguna de sus variantes | RN-27, textual: "El conteo anual de equidad NO incluye el tercer puesto de guardia ni las guardias cedidas/compradas" — no distingue por duración |

## 4. Mochila y tercer puesto voluntario son mecanismos distintos

No deben tratarse como el mismo caso pese a compartir el rasgo de
"presencia parcial, no cuenta en el total":

- **La mochila del R1** es estructural y obligatoria: existe
  específicamente para cubrir un hueco de supervisión real (un Mayor
  solo). Se activa precisamente cuando la cobertura **no** está completa.
- **El tercer puesto voluntario** (RN-34 a RN-38) solo tiene sentido
  cuando el día **ya está correctamente cubierto** por su pareja estándar
  (1 Mayor + 1 Pequeño) — es un extra sobre una cobertura ya completa, a
  petición de quien quiera sumar guardias ese mes, y sigue siendo
  enteramente voluntario tal como ya fija RN-34, sin excepción alguna
  introducida por este documento.

## 5. Resolución de CN-07 (disponibilidad del R1 en mochila para el bloqueo preventivo)

El propio documento de Reglas de Negocio deja constancia de un conflicto
sin resolver (`CN-07`): si un R1 en mochila cuenta como "residente
pequeño disponible" a efectos del bloqueo preventivo de cobertura mínima
(RN-60), relevante para aprobar vacaciones de otros residentes. Queda
resuelto aquí:

- **De junio a diciembre de su año de incorporación**, el R1 **no**
  cuenta como "residente pequeño disponible" a efectos de RN-60 —
  coherente con que tampoco realiza la guardia completa.
- **Desde enero del año siguiente**, el R1 pasa a ser un residente
  Pequeño pleno a todos los efectos, incluida la disponibilidad para el
  bloqueo preventivo.

## 6. Sugerencias en vivo durante la sesión de repartija

Requisito de comportamiento del sistema, no una regla de negocio en sí —
se formaliza aquí porque nace directamente de la sección 2.3 y solo tiene
sentido una vez fijada esa prioridad.

Durante la sesión de asignación conjunta ("repartija"), a medida que se
van adjudicando guardias, el sistema debe **sugerir activamente** dónde
colocar a cada R1 en mochila, aplicando en tiempo real la prioridad de la
sección 2.3: identificar los días en los que, con lo ya adjudicado hasta
ese momento, quedaría un Mayor solo sin cubrir, y proponer esas fechas
como destino preferente del R1 antes que cualquier otra. La sugerencia
debe recalcularse a medida que avanza la sesión y cambia lo ya
adjudicado, no calcularse una sola vez al principio.

Esto conecta con dos piezas ya previstas en la documentación congelada,
sin necesitar ningún mecanismo nuevo que inventar: el "cuadrante
inteligente" (RF-02 del SRS) y el modo incremental del motor de
optimización (documento del motor, sección 9.1), pensado precisamente
para validar/sugerir sobre una sesión en curso sin reoptimizar el
trimestre completo. Este documento no diseña cómo se implementa esa
sugerencia — deja fijado *que* debe existir y *qué* criterio debe seguir,
como entrada para el futuro diseño de `planificacion` y del motor.

## 7. Relación con el sistema de equidad

Una vez garantizada la cobertura asistencial de todas las guardias
(sección 1), el sistema de equidad selecciona, entre las soluciones ya
válidas, aquella que distribuya de forma más justa la carga anual de los
residentes. No antes: la equidad nunca decide sobre soluciones que
todavía no cumplen cobertura.

La prioridad dentro de la equidad es la ya fijada en el documento del
motor (sección 10.1, Nivel 2) y en `EQUITY_SYSTEM.md`: primero el reparto
del número total de guardias, después la distribución de los distintos
tipos de guardia (fines de semana, festivos, puentes y fechas de especial
impacto — este último ya refinado por `VACATION_IMPACT_MODEL.md`).

**Consecuencia práctica de la jerarquía de la sección 1:** una solución
con una distribución ligeramente peor de festivos nunca justifica una
pérdida de cobertura asistencial; y entre dos soluciones asistencialmente
equivalentes, se prefiere la que ofrezca el mejor reparto de guardias.

## 8. Relación con el resto de la documentación

- **RN-20 a RN-23b** (composición de la guardia, ya congeladas): esta
  regla no las contradice ni las sustituye — convierte sus excepciones
  puntuales (RN-22 solo cubre el caso "en solitario" de la mochila) en
  una jerarquía de preferencia explícita y general, aplicable más allá de
  ese caso concreto.
- **RN-27** (exclusión del tercer puesto del conteo): confirmada sin
  cambios; este documento solo aclara que la mochila del R1, aunque no es
  técnicamente "tercer puesto", recibe el mismo tratamiento de no contar
  en el total, por análoga razón de presencia parcial.
- **RN-34 a RN-38** (tercer puesto voluntario): sin cambios; la sección 4
  de este documento existe precisamente para que no se confunda con la
  mochila del R1 al diseñar `planificacion`.
- **CN-07 / RM-05** (conflicto ya señalado en el documento de Reglas de
  Negocio): queda resuelto por la sección 5 de este documento.
- **Documento del motor, sección 10.1** (Nivel 1 Factibilidad, Nivel 2
  Equidad): es la base técnica ya existente de la que la sección 1 de
  este documento es la formalización de negocio.
- **`EQUITY_SYSTEM.md`**: la sección 7 de este documento fija el límite
  con el que ese sistema debe operar — nunca decide sobre soluciones que
  no cumplen cobertura.
- Condiciona el futuro `DOMAIN_DESIGN_PLANIFICACION.md`: las secciones 1,
  2 y 6 de este documento son lectura obligatoria previa a diseñar cómo
  `planificacion` modela la composición de la pareja/equipo de guardia y
  el comportamiento de la sesión de asignación conjunta.

---

No se ha escrito código ni se ha diseñado ninguna implementación en este
documento. Queda a la espera de tu revisión antes de darlo por congelado.
