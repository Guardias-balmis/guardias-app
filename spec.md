# spec.md · Especificación de dominio de guardias-app v2

> Artefacto versionado y diffable. Fuentes de verdad: `docs/normativa.pdf` (v2.0) y
> `docs/guardias_radiodiagnostico_balmis_v2.xlsm`. Si esta spec contradice la normativa, gana la
> normativa y la spec tiene un bug. Arquitectura: `docs/adr/001-arquitectura.md`.

## 1. Principios

1. **Derivar > almacenar.** Todo lo computable desde fechas se computa; el nivel R1–R4 no existe como dato.
2. **La identidad es un UUID.** Nunca la posición, nunca el nombre, nunca el email (ambos pueden cambiar).
3. **Nunca se borra un residente.** `activo` es derivado; el historial es sagrado.
4. **El dominio es puro.** Cero I/O, cero React, cero Sheets. Mismo código en cliente y servidor.
5. **Fechas como strings ISO `YYYY-MM-DD`** y aritmética en UTC. Meses **1–12**. (El cliente v1 tiene un bug de desfase +1 mes por usar índices 0-based de JS; esta clase de bug queda prohibida por convención.)

## 2. Modelo de dominio

```
Residente {
  id: UUID                      # estable para siempre
  nombre: string                # mutable, solo presentación
  email: string                 # mutable, clave de login (comparación case-insensitive)
  fechaInicioResidencia: date   # p.ej. 2024-05-07 — los desfases respecto a junio son NORMALES
  fechaFinResidencia: date      # normalmente inicio + 4 años − 1 día; puede alargarse (bajas)
}
PeriodoFormativo {              # 4 por residente; generados por defecto, editables (nota [a] normativa)
  residenteId, anio: 1..4, fechaInicio: date, fechaFin: date
}
Bloqueo {
  id: UUID, residenteId
  desde: date, hasta: date      # RANGO inclusivo, no un día suelto (decisión V-6)
  tipo: mixto                   # solo BAJA bloquea la asignación (INV-5); VACACIONES/ROTACION
                                 # ya no bloquean, son informativas, pero siguen alimentando
                                 # INV-2/6/7 y la equidad (decisión V-8, Fase 5.x)
  motivo: VACACIONES | ROTACION | BAJA   # embarazo/paternidad → BAJA (decisión V-5)
  provincia?: string            # solo ROTACION: Alicante/Valencia/Murcia/Albacete activa INV-7
  guardiasEnCentroExterno?: bool
  activo: bool                  # cancelación = reinserción con mismo id y activo=false (append-only)
}
# Pendiente de modelar (§5 INV-13): Imaginaria (dos listas rotatorias por grupo) y la validación
# del Responsable (nivel R3, sorteo reproducible). Ver Estado de implementación (§7).
Asignacion {
  fecha: date, residenteId, codigo: G|GF|GP|3P, puesto: MAYOR|PEQUENO|TERCERO
  origen?: CEDIDA | COMPRADA    # si existe, se excluye del cómputo anual (INV-4)
}
Cuadrante { mes: 1..12, anio, estado: BORRADOR|VALIDADO|PUBLICADO, actorId, fecha }
# actorId/fecha (Fase 6.2, decisión V-10): quién disparó la ÚLTIMA transición y cuándo — no un
# campo por tipo de transición (generadoPor/validadoPor/...): cada fila `cuadrantes` es append-only,
# así que el historial completo de quién hizo qué transición ya vive en las filas anteriores.
Responsable { periodoInicio, periodoFin, residenteId, metodo: VOLUNTARIO|SORTEO,
              voluntarios[], semilla?, candidatos[]?, fechaSorteo? }   # sorteo reproducible y auditable
Excepcion {                     # degrada una violación DURA→AVISO donde la normativa lo permite
  invariante, ambito: {mes?|fecha?|residenteId?}, justificacion, registradaPor, fecha
}
```

**DURO vs BLANDO (decisión V-6, Fase 4; refinada por V-8, Fase 5.x):** `Bloqueo` y una
preferencia PERSONAL siguen siendo entidades DISTINTAS, no dos tipos de una misma tabla. Pero
dentro de `Bloqueo` la severidad ya no es uniforme por entidad, depende del `motivo` (V-8):
**BAJA sigue siendo DURA** — INV-5 prohíbe asignar guardia esos días, por seguridad/legalidad
(no se puede exigir una guardia a alguien de baja médica o embarazo). **VACACIONES y ROTACION
dejaron de bloquear la asignación**: son informativas para el generador, igual que una
preferencia BLANDA — pero sus fechas SIGUEN alimentando INV-2 (exención del mínimo mensual),
INV-6 (ausencias simultáneas por cohorte) e INV-7 (cobertura viernes/sábado en rotación
cercana): no se volvieron irrelevantes, solo dejaron de bloquear la asignación en sí. Una
preferencia PERSONAL ("preferiría no este día") sigue viviendo en `Preferencias.fechasEvitar`
(fechas concretas sueltas, no un rango), informativa y **nunca** comprobada por el validador.
`Preferencias.fechasPreferidas` (BLANDO positivo, "quiero guardia aquí") se retiró en Fase 5.x
a petición del autor: no aportaba suficiente valor frente a la complejidad de mantenerlo.

## 3. Reglas derivadas (funciones puras)

### 3.1 Periodos por defecto — `defaultTrainingPeriods(inicio, fin)`
- Periodo k (1..3): `[inicio + (k−1) años, inicio + k años − 1 día]`. Periodo 4: `[inicio + 3 años, fin]`.
- Aniversarios 29-feb se ajustan a 28-feb en años no bisiestos.
- Editables después (bajas/embarazo, nota [a]): se permiten huecos entre periodos (promoción
  retrasada), **nunca solapes**.

### 3.2 Nivel — `nivel(periodos, fecha)`
- `PENDIENTE` si `fecha < periodos[0].fechaInicio`.
- `FINALIZADO` si `fecha > último.fechaFin`.
- Si no: `R{k}` del **último periodo cuyo inicio ≤ fecha** (en un hueco entre periodos se conserva
  el nivel anterior: una baja retrasa la promoción, no des-promociona).
- Consecuencia: cada residente sube en **su aniversario** (en la práctica, mayo); en junio ya han
  subido todos → cumple DoD-2 sin cron. Un residente con `FINALIZADO` deja de listarse por cálculo
  y su historial queda intacto.

### 3.3 Grupo — `grupo(nivel)`
`R3|R4 → MAYOR`, `R1|R2 → PEQUENO`, resto → `null` (no asignable).

### 3.4 Calendario
- Día de semana desde la fecha ISO (L,M,X,J,V,S,D); fin de semana = S|D.
- **Año académico** de una fecha: `mes ≥ 6 → año`, si no `año − 1` (jun-2026→may-2027 ⇒ 2026).
- **Trimestre**: T1 jun-ago, T2 sep-nov, T3 dic-feb, T4 mar-may (T3 cruza el año natural).
- **Festivos**: son *datos de entrada* (lista de fechas por año, la carga el responsable). Nunca se
  calculan ni se delegan a la IA (el cliente v1 le pedía al modelo "identifícalos tú": prohibido).
- **Puente**: día laborable (L–V, no festivo) cuyos dos vecinos son cada uno festivo o fin de semana.
  (Cubre: viernes tras jueves festivo; lunes ante martes festivo.)

## 4. Semántica del contaje — `contaje(asignaciones, ventana, festivos)`

Replica la semántica del Excel salvo mejoras documentadas. Devuelve por residente:

| Métrica | Definición | Fórmula Excel equivalente |
|---|---|---|
| `total` | nº de G + GF + GP | `O = C + D + M` (Resumen Anual) |
| `findes` | guardias (G/GF/GP) en sábado o domingo | `SUMPRODUCT((S∨D)·guardia)` |
| `festivos` | nº de GF | columna GF |
| `prefestivos` | nº de GP | columna GP |
| `dobletes` | viernes con guardia **y** domingo (+2 días) con guardia | `SUMPRODUCT((V)·g(d)·g(d+2))` |
| `tercerPuesto` | nº de 3P | columna 3P |
| `cedidasCompradas` | nº de asignaciones con `origen` (informativo) | — |

- **Contaje "tonto a propósito" (decisión T-1):** `tally(asignaciones, ventana)` cuenta códigos por
  fecha y **no recibe la lista de festivos**: `festivos` se deriva del código GF, no de un calendario.
  La coherencia código-vs-festivo oficial es el invariante **INV-12** (§5, pendiente), no la
  responsabilidad del contador (evita "corregir" en silencio y desincronizarse del Excel de referencia).
- **`puentes` NO es una métrica del contaje.** La normativa exige equidad de **puentes libres**
  (días puente en los que el residente **no** hace guardia) — una métrica de *ausencia*, no de guardia.
  Se computa en el validador con contexto de calendario (INV-3), no en `tally`. *(Corrección de la
  puerta de consistencia: la revisión 1 de esta spec confundía "guardias en puente" —que nadie
  necesita— con "puentes libres".)*
- **INV-4:** asignaciones con `origen` CEDIDA/COMPRADA y las 3P **no** entran en `total` ni en las
  métricas de equidad; se registran aparte (contadores `tercerPuesto` y `cedidasCompradas`). Una
  guardia comprada **no puede formar la mitad de un doblete**.
- **Doblete en borde de mes** (viernes 31-jul → domingo 2-ago): el dominio lo computa por **fechas
  reales** y lo atribuye **al mes del viernes**. *Mejora deliberada sobre el Excel*, que al operar
  por columnas de mes pierde estos dobletes y distorsiona la equidad anual. La proyección a Sheets
  (Fase 7) documentará la discrepancia de borde de sus fórmulas degradadas.
- **La ventana es del residente** (su año de residencia, aniversario→aniversario), no el año
  académico. El validador recibe el acumulado del año en curso: la normativa exige compensar entre
  meses ("quien asuma más guardias un mes lo vea compensado en los siguientes").

## 5. Invariantes — `validateMonth(cuadrante, contexto) → violaciones[]`

`violacion = {invariante, severidad: DURA|AVISO, fecha?, residenteId?, detalle}`.
Un cuadrante con violaciones **DURAS** no puede pasar a `VALIDADO`. Las `Excepcion` registradas
degradan a AVISO solo donde la normativa lo permite (columna "Excepciones").

Severidad `error` **bloquea** el paso a `VALIDADO`; `aviso` informa pero no bloquea (decisión V-4).
Estado: ✅ implementado y con test · ⏳ pendiente (fase indicada).

| # | Regla operativa | Ámbito | Severidad | Estado |
|---|---|---|---|---|
| INV-1 | Cada día: idealmente 1 MAYOR y 1 PEQUENO (por nivel derivado a esa fecha); 0 personas nunca es admisible | día | error (0 personas, o composición ≥2 incorrecta); **aviso** (cubierto por 1 sola persona, decisión V-12) | ✅ |
| INV-2 | 4 ≤ guardias computables/mes ≤ 6 por residente activo | mes | **aviso** en las dos direcciones (decisión V-14: la normativa llama a estas cifras «orientativas»); exento del mínimo en febrero/vacaciones/baja/R1-verano | ✅ |
| INV-3 | **Cierre anual** (año de residencia): dif ≤ 1 con cada compañero del mismo año en total, findes, festivos, **prefestivos**, puentes libres y dobletes V-D. **Cierre trimestral** (ago/nov/feb/may): dif ≤ 1 solo en **total** | año personal · trimestre | **aviso** en los dos cierres (decisión V-14: la equidad nunca bloquea) | ✅ (prefestivos tras la puerta de consistencia; cierre trimestral en P-8; `puentesLibres` derivado de `festivos` en la fase 3 de V-17 — antes comparaba ceros) |
| INV-4 | 3P/cedidas/compradas fuera del cómputo | contaje | — (no emite violación: se aplica excluyendo en `tally`) | ✅ vía `tally`, pero la rama `origen` es **inalcanzable desde la app**: ningún cliente manda `origen` al guardar, así que hoy no existe forma de registrar una guardia cedida o comprada |
| INV-5 | Ninguna asignación sobre Bloqueo motivo BAJA (vacaciones/rotación ya no bloquean la asignación, decisión V-8) | día | error | ✅ |
| INV-6 | Máx. 2 residentes de la misma promoción en rotación externa simultánea; rotación prioritaria sobre vacaciones | día | **aviso** (V-14: las ausencias ya están concedidas, el cuadrante no puede deshacerlas) | ✅ |
| INV-7 | Rotación en Alicante/colindante → ≥1 guardia en viernes y ≥1 en sábado dentro del periodo | periodo | **aviso** (V-14; evaluado solo en el mes de fin) | ✅ (ver contrato C-2) |
| INV-8 | 3P: cubrir L→D antes de repetir día (por voluntario); dif ≤ 1 entre voluntarios al cierre; prioridad a días con R1 de mochila | año | **aviso** en las cuatro reglas (decisión V-18: 8a y 8b bajan de error; 8c ya lo era por V-14 y 8d por V-4) | ✅ (en vigor desde V-18: tabla `voluntarios3P` con permanencia de 4 meses, `thirdPostHistoryStart`, `client/lib/thirdpost.js` y cableado en `marcarValidado` y `Calendar.jsx`) |
| INV-9 | 2×R2 el mismo día: solo desde el 1-dic del año académico con Excepcion justificada, **o** en un día de evento | día | **aviso** si no justificado (V-14: la Excepcion aún no se puede registrar desde la app) | ✅ (fix P0-3: los eventos eximen con independencia del mes) |
| INV-10 | Navidad y despedida: 2 R2 por sorteo documentado; los de Navidad libres en la despedida | evento | **aviso** | ⚠️ **implementado y con test, pero MUDO**: `validateEvents` lee `ctx.eventos`, que `buildMonthContext` no acepta ni propaga, y no hay tabla de eventos — con `eventos = {}` no puede emitir ni una violación |
| INV-11 | Junio–agosto: ningún R1 asignado; recuento de Pequeños entre R2 del mismo año (dif ≤ 1, compensable) | mes | error (R1 asignado); **aviso** (dif entre R2) | ✅ |
| INV-12 | Coherencia código↔festivo: GF solo en día festivo; G/GP no en festivo | día | aviso | ✅ (tabla `festivos` + `calendar.isHoliday`/`bridgesOfMonth`; decisión V-17) |
| INV-13 | Imaginaria: dos listas rotatorias por grupo; la sustitución de una incidencia sale de la lista del grupo del incidente; una guardia de incidencia cedida/comprada NO descuenta de la imaginaria | evento | error | ⏳ pendiente (Fase 4-5; entidad no modelada aún) |
| INV-14 | Responsable: nivel R3 en su periodo (enero→enero); método SORTEO solo sin voluntarios; sorteo reproducible | año | error | ✅ (Fase 5, decisión V-7) |

### 5.1 Procedencia normativa de cada invariante

Cada invariante declara de dónde sale su autoridad. Existe porque en julio de 2026 aparecieron en
`docs/` ocho documentos de propuesta que discutían las mismas reglas sin citar ni una vez un `INV-n`,
apoyándose en una numeración propia (`RN-nn`, `CN-nn`, `RF-nn`) y en documentos que no existen en el
repo: era imposible saber si una propuesta corregía la normativa, la reinterpretaba o la ignoraba.
Regla derivada: **una regla nueva se cita contra `docs/normativa.pdf`, o se declara explícitamente
como extensión sin respaldo normativo** (decisión libre del autor, igual de legítima, pero marcada).
Recordatorio de §0: si esta spec contradice la normativa, gana la normativa.

- **INV-1** — normativa p.1 §Organización: «Hay dos puestos de guardia, uno de Residente Mayor (R3 y
  R4) y otro de Residente Pequeño (R1 y R2). No puede haber dos residentes mayores ni dos pequeños,
  salvo en las excepciones previstas en este documento». La degradación a aviso del día cubierto por
  1 sola persona es decisión V-12, no normativa. La frase de p.1 que divide a los residentes en
  «2 grupos» y dice que «cada grupo elaborará un cuadrante provisional» describe **cómo se
  reparten las guardias** (siempre un Pequeño con un Mayor) y cómo se organiza cada grupo, no dos
  unidades de datos distintas: el cuadrante mensual sigue siendo uno solo, en una sola pestaña
  (decisión V-15, que cierra P-7).
- **INV-2** — p.1: «el mínimo de guardias por residentes debe ser 4 y máximo de 6 guardias al mes»,
  con el «salvo excepciones (por ejemplo febrero o vacaciones)» que funda la exención. La severidad
  `aviso` (nunca error) sale de p.2, que degrada estas cifras explícitamente: «Estas cifras son
  orientativas. El criterio obligatorio será [la equidad]» — decisión V-14.
- **INV-3** — p.1 funda tres ejes: «diferencia máxima de 1 guardia total, 1 fin de semana y 1
  festivo»; **prefestivos** sale del recuento exigido en p.1 («totales, fines de semana, prefestivos
  y festivos»); **dobletes** de p.1 («un número equivalente de fines de semana dobles […] diferencia
  máxima de 1»); **puentes libres** de p.4 («un número equivalente de puentes libres, con una
  diferencia máxima de 1»). La ventana «año de residencia» es literal de p.2. El **cierre
  trimestral** (P-8) sale de la frase de p.2 que la propia normativa llama obligatoria: «Estas
  cifras son orientativas. El criterio obligatorio será que, una vez cerrado el cuadrante
  trimestral, la diferencia de número de guardias entre residentes del mismo año no supere 1, y
  que quien asuma más guardias en un mes vea compensado ese exceso en los meses siguientes hasta
  equilibrar el cómputo dentro del año de residencia». De esa frase salen las dos diferencias con
  el cierre anual (decisión V-13): mide solo `total` («número de guardias» — los demás ejes los
  ancla la normativa al año, p.1/p.4) y avisa en vez de bloquear (la misma frase prevé la
  compensación en los meses siguientes).
- **INV-4** — p.2: «El conteo anual no incluye: tercer puesto de guardia ni guardias
  cedida/comprada». **Extensión sin respaldo normativo** (fase 3 de V-17): en el eje
  `puentesLibres` un **3P** en un día puente NO se lo quita a quien lo hace, y una guardia con
  `origen` (cedida/comprada) **sí**. La normativa no dice nada de esto —§4 deja `puentesLibres`
  fuera del contaje, así que la exclusión literal de INV-4 no la alcanza—, y la asimetría es una
  decisión: el 3P es voluntario (p.2, «será siempre voluntario»), de modo que quien lo hace
  renuncia él a su puente y el eje mide si **el reparto** se lo quitó; la cedida/comprada, en
  cambio, es una fila de guardia como cualquier otra y quien la tiene trabaja ese día.
- **INV-5** — **sin cita literal.** La normativa solo trata la baja en la nota [a] de p.2, y para
  descontar disponibilidad («se descontará de forma proporcional»), no para prohibir la asignación.
  Que BAJA bloquee es decisión V-5/V-8, fundada en seguridad y legalidad, no en la normativa.
- **INV-6** — p.2: «no ausentarse más de dos residentes del mismo año simultáneamente, teniendo en
  cuenta que no coincidan con periodo vacacional y siendo prioritarias sobre las vacaciones».
- **INV-7** — p.2: «se deberá realizar al menos una de las guardias de viernes y sábado que
  correspondan al periodo». ⚠️ **Redacción ambigua en la propia normativa**: «al menos una de las
  guardias de viernes y sábado» admite leerse como *una de entre {viernes, sábado}* (disyunción) o
  como *una de viernes y una de sábado* (conjunción). El código implementa la **conjunción**. Ver
  P-6 en §8: es el único punto donde la ambigüedad es de la fuente y no de la interpretación.
- **INV-8** — p.2-3: voluntariedad («será siempre voluntario»), lista rotatoria L-D antes de repetir
  día (con el ejemplo del domingo), «la diferencia máxima de 3.º puestos acumulados entre estos
  voluntarios no supere 1 al final del año de residencia», y la prioridad de mochila: «Los Residentes
  que hagan tercer puesto siempre deben cubrir primero los días que haya un R1».
  **Extensión sin respaldo normativo** (decisión V-18), dos puntos: (1) el **compromiso de
  permanencia de 4 meses** al apuntarse — la normativa dice cuándo el 3P es voluntario, no
  cuánto dura el voluntariado; los 4 meses y el alta en la fecha que uno quiera son criterio del
  autor sobre la práctica real («flexible a medias»), fundados en que sin continuidad la rotación
  L-D queda a medias; y (2) que el **ciclo de siete días arranque en la fecha de alta** de cada
  residente y se reinicie si se retira y vuelve a apuntarse. La normativa describe la rotación
  («no repetir día hasta completar el ciclo») pero no dice desde cuándo se cuenta; anclarla al
  alta es lo que hace que un 3P suelto de hace dos años no condicione el ciclo de hoy.
- **INV-9** — p.3: «a partir de diciembre-enero, nunca antes», «carácter excepcional y deberán estar
  justificadas por necesidades organizativas objetivas», y el cierre de equidad «no difiera en más
  de 1 respecto a sus compañeros del mismo año».
- **INV-10** — p.3: «Se cubrirá por dos R2, a sorteo, salvo que alguien no quiera acudir […] Los
  designados para Navidad estarán libres en la despedida».
- **INV-11** — p.1: «En junio, julio y agosto, dado que se organizan sin los R1, el recuento se hará
  en el grupo de Residentes pequeños (R1 y R2), entre los residentes del mismo año, de manera que no
  superará 1 guardia de diferencia».
- **INV-12** — **sin cita literal.** La normativa no define coherencia código↔festivo en ninguna
  parte; es una comprobación de consistencia interna derivada de S-4 (los festivos son datos de
  entrada). Extensión sin respaldo normativo, aplazada.
- **INV-13** — p.4: «Se dispone de dos listas de Imaginaria. Una para residentes mayores y otra para
  residentes pequeños […] La cesión/compra de guardia de incidencia NO descuenta de la imaginaria».
- **INV-14** — p.2: «recae sobre un R3 de enero a enero de R4 […] Está designado por sorteo en
  ausencia de voluntarios».

### Contratos del validador (verificados por la puerta de consistencia)
- **C-1 (lookahead de dobletes, ref. S-5):** cualquier cómputo mensual de `dobletes` que luego se sume
  (p. ej. la proyección a Sheets de la Fase 7, o los acumulados de `equity`) debe pasar a `tally` las
  asignaciones **más los ~2 primeros días del mes siguiente**, porque el domingo de un doblete de un
  viernes-31 cae fuera del mes. `tally` hace el *lookahead* correctamente **si el dato está presente**;
  omitirlo reintroduce el bug del Excel que S-5 corrige. `validateResidencyYearClose` es correcto para
  el mes de cierre (el domingo posterior al aniversario pertenece al año siguiente).
- **C-2 (periodo de INV-7):** `validateMonth` evalúa INV-7 solo en el mes en que **termina** la rotación,
  y para ello `asignaciones` debe incluir las guardias del residente **de todo el periodo** de rotación
  (que puede abarcar meses anteriores), no solo las del mes validado.

## 6. Decisiones registradas

| # | Decisión | Motivo |
|---|---|---|
| V-1 | **Reconciliación INV-1/INV-9:** un día con 2 Pequeños **ambos R2** lo gobierna INV-9 (excepción 2×R2); cualquier otro día defectuoso (2 mayores, R1+R2, falta puesto) es INV-1 | Los agentes de diseño de tests etiquetaron la misma situación con códigos distintos. El comportamiento aceptar/rechazar es el de la normativa; solo se unifica la etiqueta. La excepción 2×R2 solo se plantea cuando ambos son exactamente R2 |
| V-2 | **Cohorte (promoción) = año natural de `fechaInicio`**; distinta del **nivel** (derivado por fecha). INV-6/INV-11 comparan por cohorte; el rol Mayor/Pequeño usa nivel | El caso del aniversario de mayo: tres residentes de la promoción 2024 siguen siendo "el mismo año" aunque su nivel computado difiera unos días |
| V-3 | Severidades `error` (bloqueante) / `aviso` (informativo) | Alineado con la salida del validador; mapea DURA→error, AVISO→aviso |
| V-4 | **Clasificación de severidad** (tras la puerta de consistencia): `error` protege equidad/seguridad/legitimidad; `aviso` es advisory/compensable/social. Aviso: INV-2 (Pequeño con 3), INV-8d (mochila), INV-10 (eventos), INV-11 (dif mensual entre R2), INV-12 (coherencia festivo). El resto, `error` | La normativa dice "cifras orientativas, el criterio obligatorio es la equidad": un cuadrante no debe bloquearse por reglas blandas. El mecanismo `aviso` no existía y varias reglas blandas bloqueaban cuadrantes válidos |
| V-5 | Embarazo/paternidad se modela como `Bloqueo` motivo **BAJA** (para el descuento proporcional de la nota [a]) | Evita ampliar el enum; el descuento de disponibilidad es idéntico |
| V-6 | `Bloqueo` es rango `desde`/`hasta` (no un día suelto) y siempre DURO; BLANDO no es un `Bloqueo`, es `Preferencias.fechasEvitar` (fechas sueltas, no enforced) | Corrige la spec para que coincida con `validate.js` (ya implementado y probado E2E en Fase 3-4): INV-6/7 operan sobre periodos, no días sueltos; colapsar DURO/BLANDO en una tabla habría mezclado "prohibido" con "preferiría no" |
| V-7 | Responsable (Fase 5): (a) la `semilla` del sorteo la genera la app (no una fuente externa), pero el sorteo es puro/determinista sobre (candidatos, semilla) — recomputable a partir del registro guardado, y cambiar cualquiera de los dos a posteriori cambia el resultado (detecta manipulación); (b) si se ofrecen ≥2 voluntarios (la normativa solo cubre "sorteo en ausencia de voluntarios"), se sortea SOLO entre ellos, no entre todo el grupo de R3; (c) candidatos = residentes con nivel R3 exactamente en `periodoInicio` (1 de enero), derivado, nunca almacenado aparte | Respuestas del autor durante la Fase 5. (a) prioriza simplicidad de implementación sobre auditabilidad por terceros sin acceso a la app — aceptado conscientemente. (b) caso no cubierto por la normativa; se prefirió reutilizar el mismo mecanismo de sorteo antes que "gana el primero en ofrecerse" (más débil de auditar) |
| V-8 | Bloqueo (Fase 5.x): la severidad depende del `motivo`, ya no es uniforme. BAJA sigue bloqueando la asignación (INV-5 sin cambios para ese motivo). VACACIONES y ROTACION dejan de bloquear: no producen ninguna violación (igual que `fechasEvitar`), pero sus fechas siguen alimentando INV-2 (exención <4 guardias/mes), INV-6 (ausencias simultáneas por cohorte) e INV-7 (cobertura viernes/sábado en rotación cercana) y el descuento proporcional de equidad — nunca dejaron de ser datos relevantes, solo dejaron de bloquear la asignación en sí. `Preferencias.fechasPreferidas` (BLANDO positivo) se retira de la pantalla y del esquema. Corrige además una contradicción real preexistente: INV-7 exigía al menos una guardia de viernes y una de sábado *dentro* del periodo de rotación cercana, mientras INV-5 prohibía *cualquier* asignación en ese mismo periodo (rotación era DURO) — nunca detectada porque los tests de INV-7 no comprobaban INV-5 en el mismo escenario | Petición del autor: una guardia sobre vacaciones/rotación no debería bloquearse en la app — "muy a nuestro pesar, debería ponerse guardias esos días" si no hay alternativa. Baja médica se mantiene DURA por seguridad/legalidad (no se puede exigir una guardia a alguien de baja): decisión explícita del autor, no un default heredado |
| V-9 | Fase 6 (generador): (a) se trocea en **6.1** (prompt con contaje acumulado + bloqueos reales inyectados, y validación multi-mes correcta — contrato C-2) y **6.2** aparte (ciclo de estados BORRADOR→VALIDADO→PUBLICADO); (b) en Fase 6, PUBLICADO es un estado **interno de la app** (bloquea ediciones del mes) — la proyección real a la pestaña del Sheet legible por humanos queda para la Fase 7, tal y como ya preveía este documento; (c) solo el Responsable R3 en su periodo (rol de Fase 5) puede pasar un cuadrante de VALIDADO a PUBLICADO | Respuestas del autor antes de empezar la Fase 6: trocear reduce el riesgo por entrega, mismo patrón que 4.0/4.1-4.2 y 5/5.x; reutilizar el rol Responsable evita inventar un permiso nuevo; separar PUBLICADO=interno de PUBLICADO=Sheets evita mezclar el ciclo de estados de la Fase 6 con el trabajo de proyección real de la Fase 7 |
| V-10 | Fase 6.2 (ciclo de estados): (a) BORRADOR→VALIDADO es **automático** en cuanto el Responsable en mandato pulsa Validar y sale sin errores (sin botón "Marcar validado" aparte) — pero el servidor siempre revalida por su cuenta contra los datos del store, nunca confía en el resultado que calculó el cliente; (b) editar un mes VALIDADO lo revierte a BORRADOR sin fricción (guardar ya lo permite, no hace falta "desmarcar" antes); (c) PUBLICADO **sí se puede revertir**: el Responsable puede despublicar (PUBLICADO→VALIDADO) para corregir y volver a publicar — no es un estado terminal en esta fase; (d) solo el Responsable en mandato puede marcar VALIDADO, no cualquier residente | Respuestas del autor antes de empezar la 6.2. (a) simplicidad de UI sin sacrificar seguridad, mismo principio que el rol derivado ("nunca un flag que el cliente pueda falsear"); (c) sin vía de corrección, un error publicado por descuido quedaría sin arreglo hasta la Fase 7; (d) el Responsable controla todo el ciclo VALIDADO→PUBLICADO, no solo el último paso |
| V-11 | Fase 7.1 (proyección a Sheets): (a) `publicarCuadrante` proyecta de verdad la pestaña mensual + "Resumen" en el MISMO paso — no hay una acción separada "proyectar"; (b) despublicar (PUBLICADO→VALIDADO) **no toca** ninguna pestaña ya proyectada, se queda con la última proyección hasta la siguiente publicación; (c) "Resumen" agrupa la equidad por **cohorte de ingreso** (mismo criterio que INV-3/V-2), no por nivel actual como hacía "Resumen Anual" del .xlsm; (d) alcance de esta entrega: pestaña mensual + Resumen; Contaje Trimestral queda para una Fase 7.2 aparte | Respuestas del autor antes de empezar la 7.1 (sábado, sin acceso aún a la cuenta de Google del servicio — "adelantemos lo que podamos"). (a) simplicidad: "publicar" pasa a significar publicar de verdad, un solo concepto; `rebuildSheet` (server/src/sheets-store.js, ya implementado en Fase 2 pero sin invocador hasta ahora) es idempotente/autorreparable por shadow-swap, así que reintentar "Publicar" basta ante un fallo parcial — y `router.js` proyecta ANTES de escribir el estado PUBLICADO, para que un fallo de la API de Sheets deje el cuadrante intacto en VALIDADO en vez de un PUBLICADO fantasma con el Sheet a medias; (b) evita que el Sheet "parpadee" mientras alguien lo mira, coherente con que despublicar es para corregir y volver a publicar enseguida; (c) consistencia con el validador real — un umbral "Resumen" agrupado por nivel actual mostraría una equidad distinta de la que INV-3 exige de verdad; (d) menos fórmulas sin verificar en vivo antes del lunes (cuando llega el acceso), mismo patrón de troceo que 4.1/4.2 y 6.1/6.2. **Simplificación NO preguntada, a validar con el autor:** "Resumen" acumula TODOS los meses publicados desde siempre (no por año académico como el .xlsm, que se recreaba cada año) — el `.xlsm` legado no tenía en realidad pestañas por mes (una sola hoja "Cuadrante Anual" con 12 bloques apilados; "1 pestaña/mes" es arquitectura nueva, no una copia), así que no había un precedente literal que replicar. La equidad de INV-3 es por año de residencia individual, no por año académico ni acumulada de por vida — esta hoja es una lectura aproximada, no sustituye al validador |
| V-12 | INV-1: cubrir un día con **1 sola persona** (Mayor solo o Pequeño solo) deja de ser error duro y pasa a **aviso** — no bloquea Validar/Publicar. 0 personas ese día sigue siendo error duro (nunca admisible); cualquier composición con 2+ personas que no sea 1 Mayor+1 Pequeño (o el 2×R2 de INV-9) sigue siendo error | Petición del autor al intentar la verificación en vivo de la Fase 7.1: hay guardias reales cubiertas por 1 sola persona (comida de Navidad, despedida de R4, sobrecarga puntual con rotantes externos u otra circunstancia) — "siempre se debe cubrir pero lo dicho". La versión anterior de INV-1 bloqueaba estos días como si fueran un error de composición, cuando la normativa real los admite |
| V-13 | Fase 7.2 / P-8 (equidad trimestral): (a) el cierre trimestral mide **solo el eje `total`**, no los seis del cierre anual; (b) su severidad es **aviso**, no error — no bloquea Validar ni Publicar; (c) los cierres se **conectan de verdad** al flujo: `marcarValidado` (servidor, autoridad) y `Calendar.jsx` (para que quien valida vea la misma razón) comprueban ahora el trimestral Y el anual; (d) un residente con **menos de medio trimestre** disponible no entra en la comparación; (e) el eje `puentesLibres` de INV-3 sigue **sin comprobarse de verdad** (no hay tabla de festivos/puentes: mismo bloqueo que INV-12) — *(e) queda superado por la fase 3 de V-17: desde entonces el eje se deriva de la tabla `festivos` sobre el año de residencia entero; se conserva escrito porque explica por qué el eje estuvo comparando ceros* | Respuestas del autor antes de empezar. (a) y (b) son lectura literal de la frase de p.2 (ver §5.1): «diferencia de número de guardias» es un solo eje, y la propia frase prevé compensar el exceso «en los meses siguientes», que es la definición de aviso en el criterio V-4 — extender los seis ejes al trimestre sería inventar autoridad que la normativa no da. (c) es lo que convierte P-8 en comportamiento: hasta ahora `validateResidencyYearClose` (INV-3 anual) estaba implementado y probado desde la Fase 3 pero **no lo invocaba nadie**, ni el router ni ninguna pantalla, así que la equidad de cierre no se comprobaba nunca en producción. (d) normalizar `total/disponibilidad` con una fracción diminuta amplifica: media guardia en dos semanas disponibles se convertiría en un "13" y avisaría en falso cada trimestre; quien esté de baja más de medio trimestre sigue cubierto por el cierre anual, cuya ventana promedia. (e) documentado explícitamente para que un eje que compara ceros no se lea como un eje verificado |
| V-14 | **La equidad nunca bloquea, ni el reparto mensual.** Todas las violaciones de equidad son `aviso`, jamás `error`: INV-3 en sus dos cierres (anual y trimestral) e INV-8 en su diferencia de 3.º puestos acumulados. **INV-2** (4-6 guardias/mes) baja también a `aviso` en las dos direcciones, porque p.2 degrada esas cifras con todas las letras («Estas cifras son orientativas. El criterio obligatorio será [la equidad]»); no entra en `EQUITY_INVARIANTS` a propósito: un aviso de recuento mensual salta casi todos los meses y una confirmación que salta siempre deja de ser una decisión. **Bajan también a `aviso` INV-6, INV-7 e INV-9**, por el mismo criterio extendido: su causa no vive en el cuadrante del mes (ausencias ya concedidas, huecos de viernes/sábado que pueden no existir, una Excepcion que la app todavía no permite registrar), así que bloquear por ellas es dejar un mes sin validar por algo que nadie puede corregir dentro de la herramienta. **Lo único que sigue bloqueando es lo imposible y lo ilegal**: un día que nadie cubre o una composición de 2+ personas que no puede ser (INV-1), una guardia sobre una baja médica (INV-5) y un R1 asignado en junio-agosto (INV-11). Validar un cuadrante que incumple la equidad **sí exige confirmación explícita** en la UI («Validar de todas formas»), mostrada junto a los avisos y después de poder leerlos. Los invariantes de equidad están enumerados en `cuadrante.js` (`EQUITY_INVARIANTS`), no reconocidos por el texto del mensaje | Petición del autor (2026-07-26), con el criterio rector del proyecto por delante: la app tiene que pasar de generación en generación sin administrador, y una regla de equidad que bloquea deja al servicio **sin cuadrante** cuando nadie sabe desbloquearla — el coste de bloquear es mayor que el del aviso. Además la normativa está de su lado: p.2 prevé compensar el exceso «en los meses siguientes hasta equilibrar el cómputo dentro del año de residencia», así que un desequilibrio es por definición corregible y encaja en el criterio V-4 (aviso = advisory/compensable). La confirmación explícita evita el otro extremo: que un aviso que nadie mira se convierta en equidad que nadie vigila |
| V-15 | **P-7 resuelto: un solo cuadrante mensual.** Los «2 grupos» de la normativa (R1-R2 / R3-R4) y su «cuadrante provisional» por grupo describen la **composición** de cada guardia (siempre un Pequeño con un Mayor, que es INV-1) y cómo se organiza cada grupo para repartirse los días — no dos tablas ni dos pestañas. El modelo de datos, el ciclo BORRADOR→VALIDADO→PUBLICADO (V-9/V-10) y la proyección a Sheets (V-11) siguen operando sobre **un** cuadrante mensual, sin cambios | Lectura del autor (2026-07-26), que es quien conoce el uso real: «se describen dos cuadrantes R1 y R2 —— R3 y R4; pero sí que se puede poner todo en el mismo cuadrante mensual […] eso afecta únicamente a cómo se ponen las guardias, no a cómo se expresan los datos en las tablas de excel». Cierra la propuesta más profunda de §8 sin tocar una línea de código: lo que la normativa exige ya lo cumple INV-1 |
| V-16 | **Sin Responsable designado, el ciclo no se bloquea.** Si no hay mandato vigente a día de hoy, cualquier residente **Mayor** (R3/R4, derivado de fechas como todo lo demás) puede validar, publicar y despublicar, y la pantalla lo dice en vez de callárselo («no hay Responsable del contaje designado para este periodo»). Con mandato vigente sigue siendo exclusivo del titular (V-9c, sin cambios). NO se crea ningún mandato ficticio: INV-14 queda intacto, esto es una regla de permiso, no un registro. El permiso se relee del store en CADA llamada (`requireCicloPermiso`), no del `rol` firmado dentro del token, que puede ser de hace horas. Además, `estadoResponsable` devuelve también el periodo SIGUIENTE, y tanto Inicio como la pantalla de Responsable invitan a ofrecerse voluntario para el mandato que aún no está decidido | Petición del autor (2026-07-27) al descubrir que el mandato de 2026 no lo tiene nadie en producción y que, por tanto, **nadie podía validar ni publicar**: el ciclo entero de las Fases 6 y 7 estaba muerto por una fila que falta en una tabla. El criterio rector manda otra vez (≥10 años sin administrador): en algún enero de los próximos diez años nadie lanzará el sorteo, y un cuadrante que no se puede publicar es peor que uno publicado por el R4 que estaba delante. Se limita a Mayores porque la normativa hace recaer el contaje en un R3/R4, nunca en un Pequeño. La invitación al voluntariado del periodo siguiente existe para que la ausencia de mandato se corrija sola: el aviso solo se le muestra a quien puede actuar (elegible, sin decidir, sin ofrecerse aún) y desaparece en cuanto se ofrece |
| V-17 | **Festivos como tabla, e INV-12 en vigor.** (a) Los festivos son una tabla de datos (`fecha`, `nombre`, `ambito`, `activo`), cargada en lote y corregible reinsertando `activo=false`, nunca derivada ni pedida a la IA (S-4); se guardan **fecha a fecha** e incluyen los **locales de Alicante**, porque son festivos reales que cambian cada año y sin ellos INV-12 avisaría en falso sobre GF correctas. (b) Los **puentes se derivan** de esa lista (`bridgesOfMonth`), nunca se escriben. (c) INV-12 es **aviso** siempre. (d) Cuando falta el calendario, INV-12 avisa **solo si hay GF escritas** en el mes, no en todo mes sin festivos: febrero no tiene ninguno en España, así que avisar sin más sería un aviso falso cada febrero — se avisa cuando la falta impide comprobar algo que alguien ya escribió. (e) Cargar y anular festivos usa el permiso del ciclo (V-16), porque es dato compartido de todo el servicio; leerlos está abierto a cualquier sesión | Decisión del autor (2026-07-27) sobre las tres fases y el ámbito. (d) matiza su respuesta original («si falta el año, que avise»): la intención era no callar cuando no se puede comprobar, y eso se cumple sin gritar cada febrero. El orden de las fases es de dependencia pura: sin la tabla, INV-12 no puede existir; y el eje `puentesLibres` de INV-3 (fase 3) necesita además la lista de DOS años naturales, porque el año de residencia cruza mayo. **Las tres fases están implementadas** (fase 3 en §7, contrato C-3 de CLAUDE.md) |
| V-18 | **El tercer puesto entra en vigor: tabla `voluntarios3P`, permanencia de 4 meses y las cuatro reglas en aviso.** (a) INV-8a (3P a quien no consta voluntario) e INV-8b (repetir día de semana) **bajan de `error` a `aviso`**: con 8c y 8d ya en aviso, ninguna de las cuatro reglas del 3.º puesto bloquea. (b) El voluntariado es **autoservicio y sin periodo**: cada residente se apunta cuando quiere —nadie apunta a nadie, ni el Responsable— y su ciclo L-D **empieza el día en que se apunta**, por el día de la semana que prefiera. (c) A cambio, al apuntarse asume un **compromiso de permanencia de 4 meses** que **acepta explícitamente** (`compromisoAceptado`, registrado) y que el servidor hace cumplir: hasta cumplirlo, `retirarVoluntariado3P` se rechaza diciendo la fecha. (d) La tabla `voluntarios3P` NO lleva `periodoInicio` (a diferencia de `voluntariosResponsable`): lleva `desde`, la fecha de alta real, porque es lo que acota el ciclo de 8b y lo que fija el compromiso. (e) `thirdPostHistoryStart` decide el histórico que hay que leer: el `desde` de cada voluntario para 8b, y la ventana del año de residencia para 8c, la más antigua de las dos | Respuestas del autor (2026-08-02) al preguntarle por el modelo antes de escribirlo. Sobre (b)/(c), literal: «cada residente se apunta si quiere y cuando quiere y puede empezar el día de la semana que quiera con ese criterio de no repetir días de la semana hasta completar el ciclo de 7 días, lo que pasa es que tiene que ser continuo durante todo el año, por eso cuando te apuntas debes tener al menos un periodo de permanencia de varios meses (al menos 4 meses, que debería salir como un disclaimer que tienen que aceptar cuando te apuntas)» — «flexible a medias». La permanencia no es burocracia: sin ella la rotación L-D queda a medias y 8c se queda sin con quién comparar. Sobre (a), el criterio de V-14 llevado a su conclusión: la causa de un 8a o un 8b no siempre vive en el cuadrante del mes (alguien se apuntó después; el ciclo arrastra de meses que ya nadie va a reabrir), así que bloquear por ellas deja al servicio sin cuadrante por la regla más blanda que tiene la normativa. INV-8 sigue en `EQUITY_INVARIANTS`, así que la confirmación explícita de la UI lo cubre. Esto es además lo que **cablea** INV-8: estaba implementado y probado desde la Fase 3 sin que lo invocara nadie, y no se podía conectar antes porque sin tabla de voluntarios marcaba TODO 3P como no-voluntario |
| S-1 | Fechas ISO string + UTC, meses 1–12 | Mata la clase de bug del v1 (desfase +1 mes, `navMes` incoherente) |
| S-2 | Nivel por aniversario personal, no por año académico | Normativa mide equidad por año de residencia individual; el Excel (año-entero) no puede expresar la nota [a] |
| S-3 | Hueco entre periodos = nivel anterior; solape = inválido | Baja retrasa promoción; no existe des-promoción |
| S-4 | Festivos como datos, jamás derivados por IA | El v1 delegaba festivos al modelo: alucinables |
| S-5 | Doblete de borde de mes contado por fechas reales, atribuido al mes del viernes | El Excel los pierde; la equidad anual es la que manda |
| S-6 | Cero dependencias en el dominio (`node:test`, ES modules) | Durabilidad 10 años: sin toolchain que se pudra |
| S-7 | Código en inglés, dominio documentado en español (JSDoc), códigos G/GF/GP/3P/V/R/B literales | Convención del proyecto |

## 7. Estado de implementación

- [x] `v2/domain/calendar.js` — calendario puro (S-1)
- [x] `v2/domain/residents.js` — periodos, nivel, grupo, activo (S-2, S-3)
- [x] `v2/domain/tally.js` — contaje (§4), 19 tests
- [x] `v2/domain/validate.js` — `validateMonth`: INV-1,2,5,6,7,9,10,11 (§5), 63 tests
- [x] `v2/domain/thirdpost.js` — **INV-8 en vigor** (decisión V-18): deja de ser dominio que no invoca nadie. Estaba implementado y probado desde la Fase 3, pero ni `marcarValidado` ni ninguna pantalla lo llamaban, y no se podía cablear porque sin tabla de voluntarios marcaba TODO 3P como no-voluntario. Ahora: (1) las cuatro reglas son `aviso` —8a y 8b bajan de `error`—, así que ninguna bloquea, pero INV-8 sigue en `EQUITY_INVARIANTS` y por tanto exige la confirmación explícita de V-14; (2) tabla `voluntarios3P` (append-only, `desde` de tipo `"date"`, `compromisoAceptado`, `activo` para retirarse por reinserción) — **sin `periodoInicio`**, a diferencia de `voluntariosResponsable`, porque el 3P no se elige por periodos comunes: cada uno se apunta el día que quiere y su ciclo L-D arranca ahí; (3) `thirdPostHistoryStart` decide el histórico a leer (el `desde` de cada voluntario para 8b, la ventana del año de residencia para 8c, la más antigua de las dos), simétrico de `rotationHistoryStart`/C-2 y `yearCloseHistoryStart`; (4) `calendar.js` gana `addMonths`, y `thirdpost.js` `thirdPostCommitmentEnd`/`canWithdrawThirdPost`/`THIRD_POST_PERMANENCIA_MESES` para el compromiso de permanencia. Backend: acciones `estadoVoluntariado3P`/`ofrecerse3P`/`retirarVoluntariado3P` (autoservicio puro: la acción ignora cualquier `residenteId` del cliente y escribe siempre `session.sub`) y `buildThirdPostCtx` en `marcarValidado`. Cliente: `client/lib/thirdpost.js` (módulo `.js` real y testeable, al estilo de `closes.js`, que nunca da por comprobado lo que falló al cargar), usado por `Calendar.jsx` en paralelo con los cierres, y una tarjeta de autoservicio en `Prefs.jsx` con el disclaimer de permanencia que hay que aceptar para que se habilite el botón. 36 tests nuevos (15 dominio + 9 `client/lib` + 12 router), más 6 tests existentes reencuadrados al dejar INV-8 de tener severidad `error` y la paridad del bundle ampliada a las cuatro funciones nuevas. **Verificado en vivo** contra `dev-server.mjs`: alta con disclaimer, retirada bloqueada por permanencia («Apuntado desde el 2 ago, tu compromiso llega hasta el 1 dic»), y un 3P de quien no consta voluntario apareciendo bajo «Avisos — informativos», no bajo «Errores — bloquean la publicación»
- [x] `v2/domain/equity.js` — `validateResidencyYearClose`: INV-3 + INV-4 (cierre de año), 15 tests
- [x] **Festivos y INV-12** (decisión V-17) — cierra S-4. Tabla `festivos` (append-only, `fecha` de tipo `"date"`, `ambito` informativo, `activo` para anular por reinserción; `anio` NO se almacena, se deriva). `v2/domain/calendar.js`: `isHoliday` (consulta, nunca deriva) y `bridgesOfMonth` (§3.4 literal: laborable L-V no festivo entre dos no laborables, con los vecinos del día 1 y del último día tomados FUERA del mes). `v2/domain/validate.js`: rama INV-12, siempre aviso, con `festivos` entrando por `buildMonthContext`. Backend: `listFestivosRango` (abierta a cualquier sesión: la necesitan validador, puentes y prompt), `crearFestivos` (lote, un solo lock) y `anularFestivo`, las dos últimas con el permiso de V-16. Cliente: `Calendar.jsx` los carga al validar y `Generator.jsx` los mete en el prompt junto a los puentes derivados — antes le pedía al modelo distinguir GF/GP sin darle una sola fecha festiva, que es exactamente lo que S-4 prohíbe. 15 tests nuevos
- [x] **Eje `puentesLibres` de INV-3** (fase 3 de V-17) — cierra la laguna que V-13(e) dejó anotada: `buildYearCloseContext` lo fijaba a 0 y no pasaba ningún puente, así que ese eje del cierre anual comparaba ceros y salía «cuadrado» sin haber mirado nada. Ahora los puentes se DERIVAN de la tabla `festivos` (V-17b) sobre la ventana entera del año de residencia, no sobre el mes: `v2/domain/calendar.js` gana `bridgesBetween(desde, hasta, festivos)` (itera `bridgesOfMonth` y recorta por los extremos) y `v2/domain/equity.js` gana `yearCloseFestivosRange` — el rango de festivos que hay que leer, con un día de margen a cada lado, simétrico de `yearCloseHistoryStart` (contrato C-3). La ventana **cruza dos años naturales** porque el aniversario cae en mayo: el puente de diciembre pertenece al cierre del mayo siguiente. El reparto acumulado/mes se mantiene: los puentes anteriores al mes validado salen de `historicas` (el store) y los del mes de `asignacionesDelMes` (lo que hay en pantalla, ediciones sin guardar incluidas). Un 3P en un puente NO se lo quita a quien lo hace (INV-4: es voluntario); una cedida/comprada sí, porque quien tiene la fila trabaja ese día. **Si falta el calendario, se avisa de que el eje no se ha podido comprobar** en lugar de callar, y la comprobación es **por año natural**, no «¿hay algún festivo en la ventana?»: como la ventana cruza siempre dos años y `crearFestivos` carga un año de golpe (V-17a), «2026 cargado y 2027 no» es el estado intermedio normal del sistema, y la pregunta laxa daba por comprobados los puentes de 2027 con solo tener un festivo de 2026 — el eje habría vuelto a comparar ceros en silencio, que es justo lo que esta fase venía a cerrar (lo encontró la revisión adversarial de 50 agentes, cuatro lentes por separado). Por eso `yearCloseFestivosRange` devuelve los **años naturales completos** que toca la ventana (±1 día), no la ventana recortada: sin ver el año entero no se puede distinguir «ese año no está cargado» de «ese tramo del año no tiene festivos». Aquí no aplica el matiz de V-17(d) —no gritar cada febrero— porque la unidad ya no es el mes: un año natural español entero sin ningún festivo no existe. El aviso solo se emite si además hay alguna cohorte con ≥2 miembros, es decir si el eje se iba a comparar con alguien. Backend: `closeViolations` filtra `snap.festivos` por ese rango. Cliente: `closes.js` pide `listFestivosRango` solo cuando el mes cierra año (el trimestral mide únicamente `total`, V-13a) y un fallo de red NO se degrada a «no hay puentes». 20 tests nuevos (14 dominio + 5 `closes.js` + 1 router), verificados por mutación (poner el eje a 0 pone 7 en rojo) y con la paridad del bundle ampliada a las dos funciones nuevas
- [ ] INV-8a juzga un mes pasado con la lista de voluntarios de **hoy**: `activeThirdPostVolunteers` proyecta el estado actual, así que a quien se retiró en diciembre se le avisa en falso por los 3P que hizo legítimamente en julio, y a quien se apuntó en septiembre se le deja de avisar por los de junio. La tabla ya guarda `desde` y —desde este cambio— `hasta`, así que el dato para arreglarlo existe; falta que `validateThirdPost` reciba los periodos y responda «¿era voluntario ESE día?» en vez de «¿lo es ahora?». Es un aviso, nunca bloquea (V-18), y el flujo normal (validar el mes en curso) no lo sufre
- [ ] `Generator.jsx` sigue comprobando el mes **solo** con `validateMonth`: ni los cierres de equidad de INV-3 (laguna previa, desde P-8) ni ahora INV-8. Su `comprobar()` es síncrono y sin red a propósito, y conectarle `client/lib/closes.js` y `client/lib/thirdpost.js` lo convierte en asíncrono; el veredicto que manda sigue siendo el de `Calendar.jsx` y el del servidor, pero quien aplica una propuesta de la IA no ve ahí los 3P mal repartidos. Es exactamente el caso que avisa CLAUDE.md: «quien añada otra pantalla que valide un mes tiene que llamar también a `closes.js`»
- [ ] Ausencias y `puentesLibres`: el eje NO se normaliza por disponibilidad (no está en `PROPORCIONAL`) y `residentIsFreeOnBridge` no mira los bloqueos, así que **cualquier** ausencia larga hace aparecer al residente «libre» en todos los puentes de ese tramo. No es solo la baja: **ROTACION y VACACIONES producen el mismo sesgo y son bastante más frecuentes**, y además —a diferencia de BAJA— no descuentan disponibilidad en ningún eje (V-8: alimentan INV-2/6/7 pero no la nota [a]), así que ahí ni siquiera hay una corrección parcial. Es un aviso, nunca bloquea (V-14); queda anotado porque las dos correcciones posibles (excluir esos puentes del recuento, o normalizarlos) distorsionan en sentidos opuestos y ninguna tiene respaldo en la normativa
- [ ] INV-13 (Imaginaria) — entidad + dos listas rotatorias por grupo (Fase 4-5)
- [x] `v2/domain/responsible.js` — `eligibleCandidates`, `resolveMethod`, `drawResponsible`, `validateResponsible`: INV-14 (Responsable R3, sorteo reproducible), 19 tests — Fase 5, backend (acciones `estadoResponsable`/`ofrecerseResponsable`/`retirarVoluntariadoResponsable`/`ejecutarSorteoResponsable`/`listResponsables`, tabla `voluntariosResponsable`) y cliente (`Responsable.jsx`) probados E2E en navegador real
- [x] `v2/domain/accumulate.js` — `accumulatedTally`: contaje acumulado por residente en SU año de residencia en curso (§4, decisión V-9/Fase 6.1), respeta el lookahead de doblete (C-1); usa `periodOn` (nuevo en `residents.js`, misma semántica que `levelOn` pero devuelve el periodo completo). Backend: acción `listAsignacionesRango` (rango de fechas ISO, cruza meses/años). Cliente: `Generator.jsx` inyecta contaje acumulado y bloqueos reales en el prompt portátil (antes decía "que conozcas por el contexto de esta conversación" sin datos); `comprobar()` pasa por fin `bloqueos` a `validateMonth` (antes INV-5/6/7 nunca se comprobaban desde el Generador). Bug real preexistente desde la Fase 4 encontrado al diseñar la 6.1 (no en el propio código nuevo): `Calendar.jsx` tampoco cumplía el contrato C-2 (INV-7 solo veía las asignaciones del mes validado, nunca las de un mes anterior de una rotación en curso) — corregido junto con el mismo fix en el Generador. Cerrada con una puerta de consistencia de 4 agentes (normativa, referencias colgantes, cobertura de tests, UI) que encontró y corrigió 4 fallos reales antes de cerrar: `Generator.jsx` duplicaba las asignaciones del día 1-2 del mes en `comprobar()` (el histórico se pide con lookahead hasta 2 días dentro del mes nuevo para el doblete de borde, pero se reusaba sin recortar); el `desde` del histórico en `Generator.jsx` se calculaba por aniversario del residente en vez de por la fecha real del bloqueo ROTACION (podía no alcanzar lo bastante atrás); un fallo de red al cargar bloqueos/histórico en el Generador dejaba la pantalla operativa en silencio (INV-5 podía no comprobarse nunca sin avisar); y una condición de carrera en `Calendar.jsx` si se cambiaba de mes a mitad de una validación en vuelo (ahora ◀/▶ se deshabilitan mientras `validando`)
- [x] `v2/domain/cuadrante.js` — `canValidate`/`canPublish`/`canUnpublish`/`canEdit`/`stateAfterEdit`: ciclo de estados BORRADOR→VALIDADO→PUBLICADO (§2, decisión V-10, Fase 6.2), 9 tests. `v2/domain/validate.js` gana `buildMonthContext` (ensambla el ctx de `validateMonth` — una sola vez, reusada por Calendar.jsx/Generator.jsx/router.js en vez de reimplementar la misma forma de objeto tres veces). Backend: tabla `cuadrantes` (append-only, `readLatest` por mes|anio, sin fila = BORRADOR implícito), acciones `estadoCuadrante`/`marcarValidado`/`publicarCuadrante`/`despublicarCuadrante` (las 3 últimas solo Responsable en mandato; `marcarValidado` **revalida en el servidor** contra el store, nunca confía en el `violaciones` que calculó el cliente), `guardarAsignaciones` ahora bloquea ediciones de un mes PUBLICADO y revierte VALIDADO→BORRADOR al guardar. Cliente: `Calendar.jsx` muestra el estado (badge + botones Validar/Publicar/Despublicar, solo Responsable) y bloquea la rejilla si PUBLICADO; `Generator.jsx` bloquea "Aplicar" igual. 30 tests nuevos (9 dominio + 17 router + 1 api.js + 3 buildMonthContext). Cerrada con una puerta de consistencia de 8 agentes en paralelo (línea a línea, comportamiento eliminado, cross-file, reuse, simplificación, eficiencia, altitud, convenciones) que encontró y corrigió: nombres de función en español violando S-7 (`puedeValidar`→`canValidate` etc.); `Calendar.jsx`/`Generator.jsx` reimplementaban inline la misma regla que ya vivía en el dominio nuevo (ahora la importan); `router.js` reconstruía a mano el ctx de `validateMonth` tres veces (ahora `buildMonthContext` compartido) y repetía el guard de rol/mes-anio/escritura de transición en 3-4 sitios (extraído a `requireResponsable`/`validCuadranteMesAnio`/`writeCuadranteEstado`); `guardarAsignaciones` partía la fecha a mano (`slice`+`split`) en vez de `parseISO`, lo que dejaba pasar fechas imposibles sin aviso claro; un fallo de red al comprobar `estadoCuadrante` se asumía silenciosamente como BORRADOR en ambas pantallas (mismo patrón de bug que ya se había corregido en 6.1, reintroducido aquí — ahora bloquea la edición y avisa); en `Calendar.jsx`, el botón Publicar no se deshabilitaba mientras había una validación en vuelo (carrera con `marcarValidado`), y `cicla()` (editar celda) no se bloqueaba durante un guardado en curso (podía perder una edición en silencio); validar con cambios sin guardar podía disparar `marcarValidado` sobre datos del servidor distintos de lo que mostraba la pantalla (ahora se omite si hay cambios pendientes). Evaluado y NO corregido (mismo criterio que Fase 6.1): la relectura de `asignaciones`/`bloqueos` en `marcarValidado` duplica una lectura que el cliente ya hizo en una petición separada momentos antes — inherente a que el servidor revalida por su cuenta y nunca confía en el cliente, magnitud irrelevante frente a la latencia de Apps Script/Sheets a esta escala (~15 usuarios)
- [x] `v2/domain/projection.js` — proyección a Sheets legible (Fase 7.1, decisión V-11): `buildMonthSheetRows` (pestaña "YYYY-MM": código día a día como valor + totales G/GF/GP/3P/Total/Fines de Semana/Dobletes V-D como fórmulas COUNTIF/SUMPRODUCT locales a la propia fila, mismo idioma que "Cuadrante Anual" del .xlsm legado) y `buildResumenRows` (hoja "Resumen": SUMIF encadenado cruzando TODAS las pestañas mensuales publicadas por nombre de hoja + MAXIFS/MINIFS de equidad por cohorte de ingreso), 23 tests. El doblete V-D solo empareja viernes/domingo DENTRO del propio mes (nunca ve la pestaña siguiente) — misma limitación que ya tenía el .xlsm, aceptada en S-5/§4, no corregida aquí a propósito. Backend: `router.js`, acción `publicarCuadrante` ahora proyecta de verdad (`store.rebuildSheet`, ya implementado en Fase 2 pero sin invocador hasta esta fase) ANTES de escribir el estado PUBLICADO — un fallo de la API de Sheets deja el cuadrante intacto en VALIDADO, nunca un PUBLICADO fantasma; `despublicarCuadrante` no toca ninguna pestaña (V-11b). 7 tests nuevos de router (proyección real con valor exacto de celda, asignación de otro mes no se filtra, acumulación de Resumen a través de 2 meses, fallo de Sheets no persiste el estado, fallo específico de Resumen tras mensual ya escrito, reintento tras fallo sana del todo). `build/build-gas.mjs` (`DOMAIN_MODULES`) y `server/Code.gs` (`deps.domain`) actualizados; `server/domain.gs` regenerado. **Código completo, sin verificar en vivo**: no hay Sheet real hasta que llegue el acceso a la cuenta del servicio (mismo bloqueo que dejó pendiente 2.6) — la corrección de las fórmulas SUMPRODUCT/MAXIFS está probada por igualdad de texto contra fórmulas construidas a mano, no por ejecución real en Google Sheets. Contaje Trimestral (la 3ª pieza de "Resumen/Contaje" del plan) queda para una Fase 7.2 aparte (V-11d). Cerrada con una puerta de consistencia de 4 agentes en paralelo (lógica/fórmulas, integración en router, cobertura de tests, documentación) que encontró y corrigió un bug real: `buildMonthSheetRows` no excluía las guardias cedidas/compradas (`origen`) de los totales, contradiciendo `tally.js`/INV-4 (una guardia cedida contaba igual que una propia en G/GF/GP/Total/Fines de Semana/Dobletes, y ese Total inflado se arrastraba a "Resumen" por SUMIF, distorsionando también la equidad) — ahora se marca con "*" en la celda (p.ej. "G*") para que COUNTIF/SUMPRODUCT la excluyan sin cambiar las fórmulas; el 3P NO se marca (tally.js lo cuenta siempre, con independencia del origen). Además: `buildResumenRows` deduplica `publishedMonths` (defensivo, ningún invocador actual lo dispara). Limitaciones evaluadas y NO corregidas (documentadas en el código): el SUMIF de "Resumen" cruza por nombre de residente, no por id — dos homónimos activos el mismo mes mezclarían sus totales, mismo riesgo que ya tenía el .xlsm legado; si `rebuildSheet` falla en "Resumen" tras haber tenido éxito en la pestaña mensual, esta queda con un adelanto visible mientras el cuadrante sigue en VALIDADO (nunca PUBLICADO) hasta el siguiente "Publicar" con éxito, que repara ambas pestañas — ventana estrecha, de bajo impacto frente a la complejidad de una transacción conjunta a esta escala (~15 usuarios)

- [x] `v2/domain/equity.js` — cierre TRIMESTRAL de equidad (INV-3 trimestral, Fase 7.2 / P-8, decisión V-13): `validateQuarterClose` (solo el eje `total`, severidad aviso, ventana del trimestre que cierra el mes validado, descuento proporcional de BAJA de la nota [a], residentes con <½ trimestre disponible fuera de la comparación) y `quarterCloseWindow`; `v2/domain/calendar.js` gana `trimesterWindow` (definición única de los meses de cada trimestre, compartida con `trimesterOf`). Además, el cierre ANUAL pasa de código muerto a comportamiento: `yearCloseHistoryStart` (qué histórico hace falta, simétrico de `rotationHistoryStart`/C-2) y `buildYearCloseContext` (ensambla el ctx de `validateResidencyYearClose` con `accumulatedTally`, traduciendo `finde`→`findes` en un solo sitio y pasando el mes como lookahead de doblete sin sumarlo dos veces, C-1). Backend: `marcarValidado` comprueba ahora el mes **y** los dos cierres con una sola lectura del store (`monthSnapshot`), acción nueva `listBloqueosRango` (las bajas del trimestre/año completo, no solo las del mes), `bloqueosInRange` extraído. Cliente: `client/lib/closes.js` (módulo `.js` real y testeable —un `.jsx` no puede importar otro— que decide si el mes cierra algo, pide solo el rango necesario y nunca da por comprobado un cierre que falló al cargar) usado por `Calendar.jsx`; el rechazo del servidor en `marcarValidado` ahora se avisa en pantalla en vez de dejar el cuadrante en BORRADOR sin explicación. `accumulate.js` entra en `DOMAIN_MODULES` (el servidor necesita el contaje acumulado) y en `deps.domain` de `Code.gs`; `server/dev-server.mjs` recupera además `buildMonthSheetRows`/`buildResumenRows`, que le faltaban desde la Fase 7.1 (Publicar fallaba en local). 34 tests nuevos (20 dominio + 8 `closes.js` + 6 router) y la paridad del bundle ampliada a las 5 funciones nuevas. **Sin verificar en vivo contra el Sheet real**, como el resto de la Fase 7

- [x] `server/src/sheets-schema.js` — nuevo tipo de columna `"date"` (bug real de primer uso en vivo, 2026-07-21, tras conceder acceso a la cuenta del servicio): Google Sheets detecta un string `"YYYY-MM-DD"` y convierte la celda a tipo Fecha interno; `SpreadsheetApp.getValues()` devuelve entonces un `Date` real, no el string original, y `deserialize` hacía `String(fecha)` esperando ya-texto — producía basura tipo `"Tue May 07 2024 00:00:00 GMT+0200..."` que rompía `parseISO` en cascada (pantalla en blanco). Se manifestó en la primera alta autoservicio real (residentes.fechaInicio) pero afectaba a las 8 columnas de fecha del esquema por igual — ningún test lo detectó antes porque el `ss` falso de los tests nunca simula la autoconversión de tipos de Sheets. Fix: `serialize` prefija con apóstrofe (fuerza texto plano en Sheets, invisible tras guardar); `deserialize` recupera `"YYYY-MM-DD"` tanto de un `Date` real (getters LOCALES, no UTC — Apps Script corre con el huso horario del proyecto, el mismo que ancló la medianoche de esa celda) como del string con apóstrofe (el `ss` falso no simula el despojo de Sheets). 4 tests nuevos. Columnas marcadas `"date"`: residentes/periodos.fechaInicio/fechaFin, bloqueos.desde/hasta, asignaciones.fecha, responsables.periodoInicio/periodoFin/fechaSorteo, voluntariosResponsable.periodoInicio, sorteos.fecha, cuadrantes.fecha. **Verificado en vivo el mismo día** (2026-07-21): el autor repegó `server-lib.gs`, desplegó nueva versión, y confirmó que el login/alta ya funciona correctamente contra el Sheet real — el `Date` que ya estaba corrompido se autorreparó solo al releer, sin tocar la celda a mano

**Núcleo de dominio (invariantes de mes y de cierre): 151 tests en verde, cero dependencias, cero I/O.**
Lagunas conocidas y aplazadas con su fase, tras la puerta de consistencia (§5: INV-12/13). Fuera
del núcleo puro (proceso, Fase 2+): comunicación trimestral a tutoría y envío del cuadrante a
Coordinación (Raquel); responsabilidad del busca del Pequeño; distribución de tareas intra-guardia.

## 8. Registro de propuestas

Cola única de reglas propuestas y **no** vigentes. Existe porque los ocho documentos de `docs/`
(julio 2026, autoría de Agustín) proponen reglas de negocio sin citar ningún `INV-n`, de modo que
nadie podía saber si una propuesta corregía un invariante, lo ampliaba o lo desconocía. Un documento
de `docs/` **no introduce una regla**: propone una fila aquí, y solo al pasar a `aceptado` se toca
§5 o el dominio.

Estados: `propuesto` (sin decidir) · `aceptado` (decidido, sin implementar) · `implementado` ·
`rechazado` (decidido en contra; se registra para que no vuelva a proponerse sin datos nuevos).

| # | Propuesta | Origen | Toca | Respaldo en `normativa.pdf` | Estado |
|---|---|---|---|---|---|
| P-1 | Medir la equidad con un **índice de puntos ponderados** (pesos por tipo de día, decimales) en lugar de contadores enteros | `EQUITY_SYSTEM.md`, `reglas-equidad-descanso.md`, `impacto-descanso-pesos-propuestos.md` | INV-3, INV-4 | **En contra.** p.1 y p.2 fijan «diferencia máxima de 1» sobre cada eje por separado, y el umbral 1 solo tiene sentido sobre guardias enteras | `propuesto` |
| P-2 | Tratar **vacaciones y rotación como bloqueo DURO** que impide asignar guardia | `casos-de-prueba-validador.md` (D1), `paquete-generacion-prompt.md` | INV-5, V-8 | **Ausente.** p.2 hace la rotación «prioritaria sobre las vacaciones» pero nunca prohíbe asignar guardia en esos días | `rechazado` |
| P-3 | Redefinir la **«mochila» del R1** como un tercero que cubre al R1 | `reglas-equidad-descanso.md`, `EQUITY_SYSTEM.md`, `GUARD_COMPOSITION_RULES.md`, `paquete-generacion-prompt.md` | INV-8, INV-1 | **En contra.** p.3 es literal: «Los Residentes que hagan tercer puesto siempre deben cubrir primero los días que haya un R1» | `propuesto` |
| P-4 | Comparar la equidad **fuera de la cohorte** (R4 con R3) | `EQUITY_SYSTEM.md` (§4), `reglas-equidad-descanso.md` | INV-3, V-2 | **En contra.** «del mismo año formativo» / «del mismo año» aparece cinco veces (p.1, p.2, p.3, p.4) | `propuesto` |
| P-5 | Mochila del R1 activa de **junio a diciembre** | `EQUITY_SYSTEM.md`, `GUARD_COMPOSITION_RULES.md`, `paquete-generacion-prompt.md` | INV-11, INV-2 | **En contra.** p.1: «En junio, julio y agosto, dado que se organizan sin los R1» | `propuesto` |
| P-6 | Leer INV-7 como **viernes _o_ sábado** en vez de viernes _y_ sábado | `casos-de-prueba-validador.md` (D3) | INV-7 | **Ambiguo en la fuente.** p.2 dice «al menos una de las guardias de viernes y sábado», que admite ambas lecturas | `propuesto` |
| P-7 | **Un cuadrante independiente por grupo** (Mayores y Pequeños) en vez de uno único mensual | `casos-de-prueba-validador.md` (G3/CO2) | INV-1, V-9, V-10, V-11 | **Solo en apariencia.** p.1 («Los residentes se dividen en 2 grupos […] Cada grupo elaborará un cuadrante provisional») describe la composición de cada guardia y la organización de cada grupo, no dos unidades de datos — ver decisión V-15 | `rechazado` |
| P-8 | Comprobar la equidad también **al cierre de cada trimestre**, no solo del año de residencia | `EQUITY_SYSTEM.md`; ya previsto como Fase 7.2 | INV-3 | **A favor.** p.2: «una vez cerrado el cuadrante trimestral, la diferencia de número de guardias entre residentes del mismo año no supere 1» | `implementado` |
| P-9 | Catálogo cerrado de **tipos de guardia y horarios** (`TipoGuardia`, retribución, tramos) | `GUARD_SHIFT_TIME_RULES.md` | T-1, S-4, INV-12 | **Ausente.** La normativa no menciona horarios, tramos ni retribución en ninguna de sus 4 páginas: extensión sin respaldo normativo, decisión libre del autor | `rechazado` |
| P-10 | Vacación solicitada en fechas de evento (Navidad/despedida) exige **visto bueno de compañeros de guardia + tutoría + Jefe de Servicio** antes de aprobarse | `propuesta-visto-bueno-vacaciones-eventos.md` (lectura directa de `normativa.pdf`, sin documento previo) | Sin invariante existente — ninguna entidad de aprobación modelada hoy en §2 | **A favor.** p.3, «Eventos del servicio»: «En esas fechas no se puede optar a vacaciones sin el visto bueno de los compañeros de puesta de guardias, de tutoría y del Jefe de Servicio (puesto que cae fuera del periodo vacacional contemplado por GVA)» | `propuesto` |
| P-11 | Modelo de datos concreto para **Imaginaria** (INV-13): entidad `ImaginariaCobertura` append-only, cola derivada por última cobertura, exclusión de R1 y de quien tenga guardia el día anterior/siguiente a la incidencia, sin exigencia de equidad | `imaginaria-modelo-propuesto.md` (lectura de `normativa.pdf` + respuestas del autor sobre la práctica real, no escritas en la normativa) | INV-13 | **Parcial.** p.4 («-Imaginaria») funda las dos listas, el criterio "lista del grupo de la incidencia" y que cesión/compra no descuenta de la imaginaria; el orden de la lista, la exclusión de R1, la exclusión por proximidad de fecha y la ausencia de exigencia de equidad **no están en la normativa** — son respuestas del autor sobre la práctica real, marcadas como tal en el documento | `propuesto` |

### 8.1 La que sigue abierta (y las cuatro ya cerradas)

**P-9, rechazada el 2026-08-01 por decisión directa del autor** (no
había normativa que evaluar: la propia fila ya decía "extensión sin
respaldo normativo, decisión libre del autor"). Horario explícito por
guardia: rechazado — "los residentes ya conocen el horario de memoria,
y no aporta nada que la app no resuelva ya". Retribución (NORMAL/DOBLE):
rechazado — se gestiona fuera de la app (RRHH/nómina), no algo que la
app deba calcular ni exportar.

**P-2, cerrada el 2026-08-01 (no tenía su propia fecha de cierre —
detectada obsoleta al revisar la cola completa).** Proponía tratar
vacaciones y rotación como bloqueo DURO. `V-8` (§6, ya implementada en
Fase 5.x) decidió exactamente lo contrario: BAJA sigue bloqueando
(INV-5 sin cambios), pero VACACIONES y ROTACION dejaron de bloquear la
asignación — la fila de la cola seguía marcada `propuesto` sin que
nadie la hubiera actualizado tras esa decisión. Marcada `rechazado`
porque el comportamiento implementado es el contrario al que propone,
no porque se haya evaluado de nuevo contra la normativa.

**P-6 (ambigüedad real de la fuente).** Es el único punto donde la ambigüedad está en la normativa y
no en su lectura. El código exige conjunción (una de viernes **y** una de sábado), que es la lectura
más exigente y la coherente con el propósito declarado en la misma frase («para evitar la sobrecarga
del resto del grupo»). Si se adopta la disyunción, INV-7 se relaja y hay que reescribir sus tests.
Se resuelve preguntando a tutoría, no leyendo el PDF otra vez.

**P-7 y P-8, cerradas ambas el 2026-07-26.** Eran las dos donde el contraste dio la razón a `docs/`
y no a `v2/domain`, y ninguna ha terminado cambiando el modelo de datos:
- **P-8 → implementada** (Fase 7.2, decisiones V-13 y V-14): cierre trimestral de INV-3 con un solo
  eje (`total`) y severidad aviso. De paso se conectó al flujo el cierre anual, que llevaba desde la
  Fase 3 implementado sin que lo invocara nadie.
- **P-7 → rechazada** (decisión V-15): los dos «cuadrantes» de la normativa son la regla de
  composición Pequeño+Mayor (INV-1) y la organización de cada grupo, no dos tablas. El cuadrante
  mensual único, el ciclo de estados y la proyección a Sheets se quedan como están.

### 8.2 Referencias documentales inexistentes

Los documentos de `docs/` citan como fuentes vigentes al menos diez artefactos que **nunca han
existido en este repo** (verificado con `git log --all --diff-filter=A`, no solo con `ls`):
`VACATION_IMPACT_MODEL.md`, `DOMAIN_MODEL.md`, `DOMAIN_DESIGN_CALENDARIO.md`,
`DOMAIN_DESIGN_PLANIFICACION.md`, `FLEXIBLE_COHORTS_REVIEW.md`, `INSTITUTIONAL_CONTINUITY.md`,
`Reglas_de_Negocio_App_Guardias.docx`, un «SRS», un «Diseño Técnico del Motor de Planificación» y un
«Diseño de Base de Datos» — más las entidades `ParametroConfiguracion` y `BalanceEquidadHistorico`,
que se dan por modeladas y no están en las 9 tablas de `server/src/sheets-schema.js`.

Son citas generadas por plausibilidad al redactar con asistencia de IA, no documentos perdidos. El
problema práctico: `EQUITY_SYSTEM.md` construye todo su índice sobre un «RN-24» que nadie puede
leer, así que **esas afirmaciones no son auditables por nadie**, ni hoy ni dentro de diez años.
`test/docs-trazabilidad.test.js` congela la lista como deuda conocida y falla ante cualquier
referencia **nueva** a un fichero que no exista.
