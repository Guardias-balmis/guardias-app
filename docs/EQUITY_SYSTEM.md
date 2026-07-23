# Sistema de equidad ponderado (propuesta para revisión)

Documento de diseño exclusivamente conceptual. No contiene código, no
modifica ningún archivo existente. Define una propuesta de sistema de
puntuaciones para medir la equidad del reparto de guardias, a revisar antes
de implementar el módulo `equidad` o cualquier lógica del motor de
optimización.

**Ninguna cifra ni criterio de este documento está decidido.** Son
propuestas razonadas, con alternativas cuando existen, para que las
apruebes, ajustes o rechaces.

---

## 0. Nota metodológica: esto es una capa nueva, no un reemplazo

Antes de proponer pesos, hay que resolver una tensión real con lo ya
documentado, porque si no se dice explícitamente se corre el riesgo de que
"sistema de puntuaciones" se entienda como que sustituye al sistema ya
descrito en el SRS y en el Documento de Reglas de Negocio — **no es así,
y no debería serlo**, por lo siguiente:

- **RN-24** (ya documentado, obligatorio, auditable) mide la equidad en
  **5 ejes independientes** (Total, Fin de semana, Festivo, Puente,
  Doblete), comparando siempre dentro del mismo año formativo, con una
  diferencia máxima de 1 en cada eje al cierre del año de residencia. Es
  el criterio con el que los propios residentes ya están familiarizados y
  el que, previsiblemente, cualquier reclamación futura invocará.
- Lo que pides aquí — un índice ponderado compuesto — **no está en
  ningún documento fuente como sistema de cierre**. El documento del motor
  de planificación sí lo insinúa, sin especificarlo: la sección 4.3 habla
  de "minimizar la suma ponderada de los rangos de los cinco ejes" y de un
  "criterio de desempate secundario" basado en varianza, pero nunca define
  los pesos ni el procedimiento — es exactamente el vacío que este
  documento rellena.

**Propuesta de encaje (a validar):** dos capas que conviven, no una que
sustituye a la otra.

| Capa | Para qué sirve | Sustituye a RN-24? |
|---|---|---|
| **Los 5 ejes oficiales** (ya documentados) | Validación de cierre de año de residencia; lo que se le explica a un residente si reclama | No — se mantiene sin cambios |
| **Índice ponderado compuesto** (este documento) | Función objetivo del optimizador durante el trimestre; panel de mando para el Responsable de Cuadrante; criterio de desempate más fino que un solo eje | No — es una herramienta de pilotaje interna, adicional |

Si más adelante se decide que el índice compuesto sí debería ser el
criterio oficial de cierre (en vez de los 5 ejes por separado), es un
cambio normativo que afecta a cómo se le explica el sistema a los propios
residentes — no lo doy por hecho aquí, lo dejo como pregunta abierta en la
sección 8.

**Límite superior de todo este sistema, fijado en `GUARD_COMPOSITION_RULES.md`
§1:** la equidad nunca decide sobre soluciones que no cumplen primero la
cobertura asistencial mínima — cobertura y equidad son objetivos
jerárquicos, no negociables entre sí. Ninguna cifra de este documento
(pesos, bonos, índice global) debe interpretarse nunca como una
justificación para aceptar una composición de guardia insuficiente desde
el punto de vista asistencial. No se repite aquí el desarrollo completo
de ese principio para no duplicarlo — se cita.

---

## 1. Qué mide cada dimensión analizada, y si ya existe hoy

Antes de pesar nada, aclaro qué de lo que pediste analizar **ya tiene un
lugar en el modelo documentado** y qué es, en la práctica, una extensión
nueva que este documento introduce:

| Dimensión pedida | ¿Ya se mide hoy? | Dónde |
|---|---|---|
| Laborables | Sí, implícitamente | Dentro del eje "Total" (RN-24), sin distinguirse de otros tipos de guardia |
| Sábados / Domingos | Sí | Eje "Fin de semana" (RN-24) |
| Festivos | Sí | Eje "Festivo" (RN-24), incluye festivos especiales sin distinguir entre sí |
| Puentes | Sí, como eje aparte | Eje "Puente" (RN-24) — no es un tipo de guardia, es una propiedad derivada (ver `DOMAIN_MODEL.md`, sección 2.6) |
| Festivos especiales | Parcialmente | Contabilizados dentro del eje "Festivo", pero **sin peso diferenciado** pese a tener retribución doble (RN-17) y mayor valor personal |
| **Viernes** | **No, en absoluto** | Hoy cuenta como un día más dentro de "Total"; RN-24 define "Fin de semana" como solo sábado+domingo, el viernes queda fuera de ese eje aunque objetivamente sea el inicio del fin de semana |
| **Prefestivos** | **No, en absoluto** | Ningún eje de RN-24 los menciona; solo aparecen en RN-19 para *no* confundirlos con un puente aprovechado |
| Periodos vacacionales | Sí, como ajuste | RN-30 (reduce el cupo mensual exigido), RN-25 (descuento proporcional en bajas) — no es una "guardia", es un ajuste al denominador de comparación |
| Diferencias mayores/menores | Sí, como regla de comparación | RN-24, con la precisión de la sección 4: comparación prioritaria dentro del mismo año formativo; solo si eso no basta, se amplía a otro año con responsabilidad asistencial equivalente — no por cercanía numérica del año |
| Compensaciones | Sí, conceptualmente | RN-26 (balance arrastrado entre periodos), ya modelado como `BalanceEquidadHistorico` |
| Penalizaciones | No existe tal concepto | Ver sección 6 — aclaro por qué no debería inventarse como mecanismo disciplinario |

Los dos huecos reales (**viernes** y **prefestivos** sin ningún peso
propio hoy) son precisamente donde un sistema de puntuaciones aporta algo
que el sistema de 5 ejes no cubre.

---

## 2. Propuesta de pesos

### 2.1. Qué significa "objetivo" aquí

"Peso objetivo" no puede significar matemáticamente derivado sin
intervención humana — no existe una fórmula que convierta "cuánto cuesta
un domingo" en un número sin un juicio de valor. Propongo que "objetivo"
signifique: **criterio explícito, documentado y aplicado igual para
todos**, en vez de la negociación caso por caso ("subasta") que hoy
resuelve esto de forma implícita entre residentes. Tres formas posibles de
fijar los números, para que elijas cuál prima:

- **A. Basados en duración real de la guardia** (horas de presencia física): laborable ≈ 17h, viernes ≈ 18h, sábado = 24h, domingo ≈ 23h, festivo ≈ 23h, prefestivo ≈ 17h (igual que laborable, pero pierde el descanso posterior).
- **B. Basados en señales normativas ya existentes**: la propia normativa ya reconoce que un festivo especial "vale más" (única categoría con retribución doble, RN-17) y que fin de semana/festivo ya se separan de "laborable" como eje propio (RN-24) — se parte de esas señales para fijar un orden relativo, sin necesidad de cronometrar horas.
- **C. Basados en preferencia revelada** por los propios residentes en la negociación actual (qué evitan primero, qué aceptan antes) — más fiel a "cómo lo viven", pero requeriría recoger datos de las sesiones de asignación actuales, que hoy no se registran en ningún sitio.

**Recomendación:** combinar A y B como punto de partida (B para el orden
general de categorías, A para matizar las diferencias dentro del bloque
"fin de semana"), y dejar C como refinamiento posible una vez haya datos
reales de uso del sistema.

### 2.2. Tabla de pesos propuesta

Escala de referencia: **1.0 = guardia laborable (L-J)**. Todos los demás
pesos son relativos a esa unidad.

| Tipo de día | Peso propuesto | Justificación |
|---|---|---|
| Laborable (lunes a jueves) | **1.0** | Unidad de referencia |
| Prefestivo | **1.3** | Mismo horario/retribución que un laborable, pero pierde el descanso posterior (RN-19) — hoy sin ningún peso, esta propuesta le da uno por primera vez |
| Viernes | **1.6** | Guardia más larga (≈18h) e inicio real del fin de semana; hoy no se distingue de un laborable en ningún eje |
| Sábado | **2.2** | 24h, fin de semana pleno — ya reconocido como eje propio (RN-24) |
| Domingo | **2.2** | ≈23h, fin de semana pleno — mismo peso que sábado; ya reconocido como eje propio |
| Festivo (entre semana, "funciona como domingo") | **2.2** | El propio SRS (sección 5.1) lo define como equivalente a un domingo |
| Festivo especial (24/25/31 dic, 1/6 ene) | **3.5** | Máxima carga personal/familiar + único caso con retribución doble (RN-17) |

**Ajustes que se aplican sobre estos pesos, no como categorías nuevas:**

| Situación | Ajuste propuesto | Justificación |
|---|---|---|
| Guardia parcial "mochila" (solo R1, junio-diciembre) | ×0.5 sobre el peso del día correspondiente | Cobertura solo hasta las 20h — objetivamente menor carga que una guardia completa |
| Tercer puesto (voluntario) | ×0.5 sobre el peso del día, registrado en un balance **aparte**, nunca sumado al índice principal | RN-27 ya excluye el tercer puesto del cómputo de equidad obligatorio; este sistema no debe contradecirlo |
| Doblete (segunda guardia encadenada) | bono de **−0.3** sobre el peso del día que cierra el doblete | Encadenar guardias libera al residente de otro fin de semana suelto más adelante — el bono reconoce ese beneficio futuro. Se contabiliza además en el eje "Doblete" ya existente, sin fusionarse con él |
| Guardia que genera aprovechamiento de un puente | bono de **−0.2** sobre esa guardia | Beneficio documentado en RN-55 y en la sección 7.1 del documento del motor |
| Prefestivo que desperdicia el descanso (RN-19) | sin bono | A diferencia del puente aprovechado, este caso no genera ningún beneficio que compensar |

**Todos estos números son una propuesta inicial, no una decisión.** Deben
almacenarse como `ParametroConfiguracion` (clave-valor, ya previsto en el
Diseño de Base de Datos para umbrales editables), nunca como valores fijos
en código, para poder ajustarlos sin redesplegar — coherente con la mejora
RM-07 del Documento de Reglas de Negocio.

### 2.3. Ajuste por ausencias justificadas (vacaciones, congresos, bajas)

Un periodo vacacional o una baja médica no es un "tipo de guardia" — es un
ajuste al **denominador** de la comparación, no al numerador:

- **Vacaciones/congreso:** el número de guardias exigido ese mes se reduce
  proporcionalmente (RN-30 ya documentado); la puntuación *esperada* de ese
  residente para ese periodo se reduce en la misma proporción, para no
  penalizarle en la comparación por una ausencia legítima.
- **Baja médica / permiso de embarazo-paternidad:** mismo principio, con
  el descuento proporcional que ya define RN-25.

Esto no es una novedad de pesos — es aplicar el mismo principio que RN-25
y RN-30 ya establecen, ahora también sobre el índice compuesto y no solo
sobre el conteo simple de guardias.

---

## 3. Cómo medir la equidad individual

Para un residente concreto, en un periodo dado (habitualmente un
trimestre, acumulable a lo largo del año de residencia):

```
Puntuación(residente, periodo) =
      Σ [ peso(tipo_de_día de cada guardia realizada) × ajuste_mochila_o_tercer_puesto ]
    + Σ bonos de dobletes y puentes aprovechados
    − ajuste proporcional por ausencias justificadas (vacaciones, congreso, baja)
```

Esta puntuación, por sí sola, no dice si algo es justo — solo dice
"cuánto ha cargado" ese residente. La equidad aparece al compararla contra
lo que le "correspondería" dentro de su cohorte:

```
Desviación(residente) = Puntuación(residente) − Promedio(Puntuación de su cohorte)
```

- `Desviación > 0` → ha cargado más de lo que le toca → candidato a
  recibir guardias de menor peso en el reparto próximo.
- `Desviación < 0` → ha cargado menos → candidato a recibir guardias de
  mayor peso para compensar.

El balance se arrastra entre periodos (igual que ya hace
`BalanceEquidadHistorico`, ahora también en su versión ponderada), para
que la compensación (RN-26) opere sobre el histórico completo del año de
residencia, no solo sobre el trimestre en curso.

### 3.1. Continuidad del saldo entre cursos académicos (equidad longitudinal)

**Extensión sobre lo ya documentado**, no una reformulación: RN-26 y el
Nivel 3 del documento del motor ("Compensación histórica") limitan
explícitamente el arrastre del balance "dentro del mismo año de
residencia". Lo que sigue **amplía** ese límite — no lo contradice, lo
prolonga más allá del cierre de curso cuando un desequilibrio no llegó a
compensarse a tiempo.

**No es un eje nuevo ni cambia con quién se compara un residente.** La
población de comparación sigue siendo exactamente la que fija la sección
4 de este documento (la misma cohorte, ampliada solo cuando corresponda
por responsabilidad asistencial equivalente) — esto no toca esa regla en
absoluto. Lo único que cambia es la **prioridad de compensación** de cada
residente dentro de su cohorte de comparación.

**El principio:** el saldo de un residente en un eje concreto viaja con
la **persona**, no con el año formativo que ocupe en cada momento — para
el propio residente, un festivo especial pesa igual si lo hizo como R2
que si lo hizo como R3. No se trata de una "memoria histórica" que
acumula el pasado indefinidamente, sino de un **saldo de equidad
pendiente de compensación**: existe mientras el desequilibrio siga sin
compensarse y desaparece en cuanto deja de estarlo, sin ventana temporal
fija ni acumulación sin control.

```
SaldoPendiente(residente, eje) disminuye progresivamente a medida que el
residente recibe compensaciones equivalentes en periodos posteriores,
hasta dejar de tener influencia práctica cuando el desequilibrio se
considera compensado.
```

**Ejemplo:** un residente que hace dos Navidades consecutivas empieza el
curso siguiente con saldo negativo en el eje "festivo especial". Ese
saldo hace que el motor favorezca evitar una tercera Navidad mientras
existan alternativas equivalentes (Nivel 2 del motor, dentro de su
cohorte). Si en los cursos siguientes ese residente deja de hacer
Navidades mientras otros las asumen, el saldo se reduce progresivamente
hasta dejar de tener influencia práctica — a partir de ahí, deja de
influir. No existe una deuda eterna por algo ocurrido varios cursos
atrás.

**Límite, coherente con `GUARD_COMPOSITION_RULES.md` §1 y con el Nivel 1
del motor (Factibilidad, no negociable):** el saldo pendiente **nunca**
puede justificar una solución que empeore la cobertura asistencial o
vulnere una regla obligatoria de planificación. Únicamente sirve para
elegir, dentro de las alternativas que **ya son válidas** por cobertura y
por las demás reglas obligatorias, cuál de ellas reparte mejor la
equidad acumulada. Es exactamente el mismo límite que ya rige el resto
del sistema de equidad (sección 1 de `GUARD_COMPOSITION_RULES.md`), no
una excepción para este mecanismo.

**Reconciliación con el "reinicio administrativo" (documento del motor,
sección 9.3):** ese reinicio, disparado por un cambio de cohorte, sigue
existiendo tal como está documentado — reinicia el **modelo de
planificación** del nuevo curso (variables, restricciones, cupos). Lo que
**no** debe reiniciar automáticamente es el **saldo pendiente de
compensación** de cada residente: pertenece a la persona, no al curso
académico, y ambos reinicios son conceptualmente independientes uno del
otro.

---

## 4. Cómo comparar residentes

**Revisión sobre la posición original de esta sección** (que decía "nunca
entre años distintos, ni siquiera entre R3 y R4"): RN-24 justifica la
comparación dentro del mismo año formativo porque "su carga y rol son
diferentes" — pero esa es la razón real, no el número de año en sí mismo.
Aplicada con el mismo rigor que la propia RN-24 exige, esa justificación
implica que dos años formativos distintos **sí** pueden compararse cuando
su carga y rol asistencial son, en la práctica, equivalentes. La posición
anterior de este documento era más estricta de lo que RN-24 exige.

**El criterio, formulado como principio y no como número de año:**

1. **Prioridad siempre:** comparar dentro del mismo año formativo (R1 con
   R1, R2 con R2, R3 con R3, R4 con R4).
2. **Solo cuando eso no baste para obtener una referencia útil** —por
   ejemplo, una cohorte demasiado pequeña para que el rango máximo-mínimo
   sea representativo, el mismo problema de tamaño de cohorte ya señalado
   en el documento del motor, sección 4.3— el grupo de comparación puede
   ampliarse a residentes de **otro año formativo cuya responsabilidad
   asistencial sea equivalente**. Nunca por cercanía numérica del año en
   sí: el criterio es la equivalencia funcional, no la proximidad.

**Por qué se formula así y no como "año inmediatamente superior o
inferior":** si en el futuro cambia el programa formativo o las
competencias asignadas a cada año, este criterio sigue siendo válido sin
reescribir la regla — solo cambiaría a qué años formativos concretos se
aplica, no el principio en sí.

**Aplicación de este criterio en la organización actual del Servicio**
(consecuencia de aplicar el principio hoy, no la regla en sí):

| Comparación | ¿Válida como referencia secundaria? | Por qué |
|---|---|---|
| R4 ↔ R3 | Sí | Actividad asistencial muy similar: ambos firman informes, con autonomía y responsabilidad comparables durante la guardia |
| R2 ↔ R1 | No | El R1 todavía no firma informes; su contribución es principalmente de apoyo asistencial y organizativo, no carga diagnóstica propia — la responsabilidad real no es equivalente |

Si el programa formativo cambiara estas competencias en el futuro, esta
tabla se actualizaría — el principio de los dos puntos de arriba no.

Lo único que añade el sistema de pesos es un ajuste **dentro** de la propia
cohorte (no entre cohortes): la guardia de "mochila" de un R1 pesa menos
que una guardia completa de otro R1, porque objetivamente lo es. No
propongo ningún ajuste de peso entre Mayores y Pequeños más allá de este
caso — un sábado pesa lo mismo para un R1 en guardia completa que para un
R4, porque la carga real de esa guardia es la misma independientemente de
la antigüedad. **Esto es una asunción a validar**: si hubiera una razón
clínica u organizativa para que un residente mayor "cargue más" en la
misma guardia (más responsabilidad de supervisión, por ejemplo), no está
recogida en ningún documento fuente y habría que decidirlo explícitamente.

Para cada cohorte, se calcula:

```
RangoPonderado(cohorte) = max(Puntuación) − min(Puntuación) entre los residentes de esa cohorte
```

Análogo al rango que RN-24 ya exige mantener ≤1 en cada uno de los 5 ejes
oficiales — aquí se calcula también sobre el índice compuesto, como
medida adicional, no sustitutiva.

---

## 5. Cómo calcular el índice de equidad global

Un único número que resuma la salud del reparto de **todo** el Servicio,
útil para el Responsable de Cuadrante y para detectar tendencias entre
trimestres, en vez de mirar 4 cohortes × 5 ejes = 20 cifras sueltas.

```
ÍndiceGlobal = promedio, ponderado por tamaño de cohorte, de:
      RangoPonderado(cohorte) / Promedio(Puntuación(cohorte))
```

Dividir entre el promedio de la propia cohorte (en vez de usar el rango en
crudo) permite comparar cohortes de tamaños y cargas distintas (p. ej. R4
con solo 3 residentes frente a R1 con 4) sin que el resultado dependa del
tamaño del grupo.

**Advertencia importante sobre este índice:** un solo número puede
esconder que una cohorte concreta esté muy desequilibrada mientras las
demás compensan el promedio. Por eso el ÍndiceGlobal debe presentarse
siempre **junto con el desglose por cohorte**, nunca solo, para que el
Responsable de Cuadrante no pierda visibilidad de un problema puntual
detrás de un buen promedio general.

---

## 6. Compensaciones y penalizaciones

- **Compensaciones:** ya cubiertas en la sección 3 — el balance arrastrado
  entre periodos es, en sí mismo, el mecanismo de compensación (RN-26),
  ahora también en su versión ponderada y, desde la sección 3.1, sin el
  límite artificial del cierre de curso mientras quede saldo pendiente de
  compensar. No propongo ningún mecanismo distinto — es el mismo balance
  ya documentado, con ese único ajuste de alcance.

- **Penalizaciones — aclaración de terminología importante:** en este
  sistema, "penalizar" no significa una sanción disciplinaria a un
  residente. Significa, únicamente, que un tipo de guardia con más peso
  "penaliza" (suma más) la puntuación acumulada de quien la realiza, lo
  cual el algoritmo intentará compensar dándole guardias de menor peso a
  continuación. No existe en ningún documento fuente un mecanismo
  disciplinario asociado a la equidad, y **no propongo crear uno aquí** —
  sería una decisión de recursos humanos ajena al alcance de este sistema.

  La única figura documentada que podría confundirse con una
  "penalización" es la mencionada en la sección 4.1 del documento del
  motor: cesiones/cambios frecuentes de un residente se registran como eje
  de control (para detectar patrones anómalos), **pero explícitamente no
  forman parte del cómputo de equidad oficial** (RN-27). Este sistema
  respeta esa exclusión: las cesiones no restan ni suman puntos al índice
  de equidad, solo se muestran aparte como indicador de seguimiento.

---

## 7. Cómo usar estas puntuaciones dentro del algoritmo de optimización

El documento "Diseño Técnico del Motor de Planificación" ya define el
marco (secciones 2, 4 y 11) en el que este sistema de pesos encaja, sin
necesidad de inventar un mecanismo nuevo — rellena los huecos que ese
documento deja abiertos:

1. **Función objetivo (fase de optimización general).** La sección 4.3 del
   documento del motor pide "minimizar la suma ponderada de los rangos de
   los cinco ejes" sin especificar los pesos. Propongo que sea, en su
   lugar (o además), minimizar el `RangoPonderado` del índice compuesto
   por cohorte definido en la sección 4 de este documento — un único
   objetivo que ya incorpora las categorías que hoy no tienen eje propio
   (viernes, prefestivos).

2. **Criterio de desempate individual.** La sección 5.2 del documento del
   motor propone "prioridad para quien tenga menor balance acumulado en
   ese eje concreto" cuando dos residentes compiten por la misma fecha. Con
   este sistema, se puede usar la `Desviación` (sección 3) como criterio
   de desempate general, no limitado a un único eje — más preciso cuando
   la disputa no es sobre un festivo especial concreto sino sobre el
   reparto general del trimestre.

3. **Preasignación de festivos especiales (fase previa).** La sección 6.2
   del documento del motor ya propone ordenar a los interesados en cada
   fecha especial "por balance acumulado de festivos especiales". Con este
   sistema, ese balance puede calcularse en puntos (peso 3.5 por festivo
   especial ya disfrutado) en vez de en conteo simple, reconociendo que no
   todos los festivos especiales son iguales entre sí si en el futuro se
   quisiera diferenciarlos (hoy se propone el mismo peso para los 5, ver
   nota más abajo).

4. **Diagnóstico de infactibilidad.** La sección 5.1 del documento del
   motor pide que, cuando no exista solución dentro del margen normativo,
   el motor explique qué restricción lo impide. Con el índice ponderado,
   ese diagnóstico puede ser más rico: no solo "el eje festivo está
   desbalanceado", sino "el residente X acumula 4.2 puntos más que la
   media de su cohorte, principalmente por 3 guardias de festivo especial
   consecutivas" — más útil para que el Responsable de Cuadrante entienda
   el porqué.

5. **El cierre de año de residencia sigue validándose por los 5 ejes
   oficiales, de forma independiente** (ver sección 0). El índice
   ponderado guía las decisiones *durante* el trimestre; no sustituye la
   comprobación final que RN-24 exige.

**Nota sobre festivos especiales entre sí:** este documento propone el
mismo peso (3.5) para las 5 fechas especiales (24/25/31 dic, 1/6 ene). No
tengo evidencia documental de que deban diferenciarse entre sí (p. ej. que
25 de diciembre "valga más" que 6 de enero) — si existiera esa percepción
real entre los residentes, sería una entrada más a decidir explícitamente,
no algo que deba asumir por mi cuenta.

---

## 8. Preguntas abiertas antes de aprobar este sistema

1. ¿Confirmas el encaje de dos capas de la sección 0 (5 ejes oficiales
   para el cierre normativo + índice ponderado como herramienta interna),
   o prefieres que el índice ponderado sustituya directamente a los 5 ejes
   como criterio único?
2. ¿Los números concretos de la tabla de pesos (sección 2.2) te parecen
   razonables como punto de partida, o prefieres fijarlos con otro
   criterio (por ejemplo, replicando algo más cercano a cómo los propios
   residentes priorizan hoy en la negociación presencial)?
3. ¿Debe un residente mayor (R3/R4) recibir un peso distinto al de un
   residente pequeño (R1/R2) por el mismo tipo de guardia, más allá del
   ajuste ya propuesto para la mochila del R1? Hoy propongo que no, salvo
   el caso de mochila.
4. ¿Las 5 fechas de festivo especial deben tener el mismo peso entre sí, o
   hay alguna que deba valorarse más (p. ej. 25 de diciembre frente a 6 de
   enero)?
5. ¿El `ÍndiceGlobal` (sección 5) es una métrica que interesa exponer al
   Responsable de Cuadrante desde el primer momento, o es una elaboración
   que puede esperar a una fase posterior una vez el sistema de pesos
   esté validado?

No he escrito ni modificado ningún archivo de código en este documento.
Quedo a la espera de tu revisión antes de continuar con cualquier
implementación relacionada con equidad o con el motor de optimización.
