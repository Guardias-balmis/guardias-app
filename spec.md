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
  residenteId, fecha: date
  tipo: DURO | BLANDO
  motivo: VACACIONES | ROTACION | BAJA | PERSONAL
  provinciaColindante?: bool    # solo ROTACION: rotación en Alicante/Valencia/Murcia/Albacete (INV-7)
}
Asignacion {
  fecha: date, residenteId, codigo: G|GF|GP|3P, puesto: MAYOR|PEQUENO|TERCERO
  origen?: CEDIDA | COMPRADA    # si existe, se excluye del cómputo anual (INV-4)
}
Cuadrante { mes: 1..12, anio, estado: BORRADOR|VALIDADO|PUBLICADO, generadoPor, validadoPor, validadoEn }
Responsable { periodoInicio, periodoFin, residenteId, metodo: VOLUNTARIO|SORTEO,
              semilla?, candidatos[]?, fechaSorteo? }   # sorteo reproducible y auditable
Excepcion {                     # degrada una violación DURA→AVISO donde la normativa lo permite
  invariante, ambito: {mes?|fecha?|residenteId?}, justificacion, registradaPor, fecha
}
```

**Bloqueos:** `DURO` (V/R/B — el generador y el validador prohíben guardia ese día) vs `BLANDO`
(PERSONAL — "preferiría no"; se minimiza su incumplimiento, no se prohíbe). Esta distinción es
núcleo del generador: no se colapsa.

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
| `puentes` | guardias (G/GF/GP) en día puente (§3.4) | — (el Excel no lo computa; la normativa sí lo exige para INV-3) |
| `dobletesVD` | viernes con guardia **y** domingo (+2 días) con guardia | `SUMPRODUCT((V)·g(d)·g(d+2))` |
| `tercerosPuesto` | nº de 3P | columna 3P |

- **INV-4:** asignaciones con `origen` CEDIDA/COMPRADA y las 3P **no** entran en `total` ni en las
  métricas de equidad; se registran aparte.
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

| # | Regla operativa | Ámbito | Severidad | Excepciones |
|---|---|---|---|---|
| INV-1 | Cada día: exactamente 1 MAYOR y 1 PEQUENO (por nivel derivado a esa fecha) | día | DURA | 2×R2 solo vía INV-9 |
| INV-2 | 4 ≤ guardias computables/mes ≤ 6 por residente activo | mes | DURA | febrero, vacaciones, alta/baja a mitad de mes → AVISO documentado |
| INV-3 | Al cierre del año de residencia de cada residente: dif ≤ 1 con cada compañero del mismo año formativo en total, findes, festivos, puentes y dobletesVD | año personal | DURA al cierre; AVISO si la proyección con meses restantes ya no puede converger | nota [a]: bajas descuentan proporcionalmente |
| INV-4 | 3P/cedidas/compradas fuera del cómputo | contaje | DURA (error de cómputo) | — |
| INV-5 | Ninguna asignación sobre Bloqueo DURO | día | DURA | — |
| INV-6 | Máx. 2 residentes del mismo año formativo en rotación externa simultánea; rotación prioritaria sobre vacaciones | día | DURA | — |
| INV-7 | Rotación en provincia colindante → ≥1 guardia en viernes y ≥1 en sábado dentro del periodo | periodo | AVISO hasta que el periodo cierre; DURA al cerrar sin cumplir | — |
| INV-8 | 3P: cubrir L→D antes de repetir día (por voluntario, sobre su historial); dif ≤ 1 entre voluntarios al cierre; prioridad a días con R1 de mochila | año | DURA (repetición); AVISO (prioridad mochila) | — |
| INV-9 | 2×R2 el mismo día: solo desde el 1 de diciembre del año académico, con Excepcion justificada | día | DURA antes de diciembre incluso justificada; AVISO desde diciembre con justificación | la propia regla es la excepción |
| INV-10 | Navidad y despedida: 2 R2 por sorteo documentado; los de Navidad libres en la despedida | evento | AVISO | voluntarios |
| INV-11 | Junio–agosto: ningún R1 asignado; recuento de Pequeños entre R2 del mismo año (dif ≤ 1, compensable antes del cierre del año) | mes | DURA (R1 asignado); AVISO (dif entre R2) | — |

## 6. Decisiones registradas

| # | Decisión | Motivo |
|---|---|---|
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
- [ ] `v2/domain/tally.js` — contaje (§4)
- [ ] `v2/domain/validate.js` — validador (§5)
