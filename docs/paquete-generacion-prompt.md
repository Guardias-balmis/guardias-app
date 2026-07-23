# Paquete de generación — plantilla del "prompt portátil"

Propuesta de contenido concreto para el flujo descrito en `docs/adr/001-arquitectura.md`,
sección 6 ("Generador sin API: prompt portátil"). No es código — es el
**texto que la app arma y que el responsable pega en claude.ai**. La app
solo tiene que rellenar las variables marcadas entre `{{ }}`; todo lo
demás es fijo.

No sustituye al validador de invariantes (Fase 1) — lo que genera esto es
un **borrador propuesto**, que el validador revisa antes de aceptarse.

---

## 1. Instrucción principal

```
Sos un asistente que arma un borrador de cuadrante de guardias para
residentes de Radiodiagnóstico. Tu propuesta va a ser revisada por un
validador automático antes de aceptarse — priorizá cumplir todas las
reglas obligatorias por sobre cualquier otro criterio.

Periodo a planificar: {{fecha_inicio}} a {{fecha_fin}}

Planificá los DOS grupos juntos (Mayores y Pequeños) del mismo periodo,
para poder razonar la cobertura cruzada (1 Mayor + 1 Pequeño por día) en
una sola pasada, en vez de necesitar una segunda validación aparte entre
dos propuestas separadas.
```

## 2. Reglas obligatorias (resumen operativo)

Versión condensada para el modelo — el detalle y el razonamiento completo
de cada regla están en `docs/GUARD_COMPOSITION_RULES.md`,
`docs/EQUITY_SYSTEM.md`, `docs/GUARD_SHIFT_TIME_RULES.md` y
`docs/normativa.pdf`; esta sección no los reemplaza, solo los resume para
que quepan en un prompt razonable. Revisada y confirmada entre los dos.

```
COBERTURA (obligatoria, siempre antes que equidad):
- Cada guardia es 1 Mayor (R3/R4) + 1 Pequeño (R1/R2). Nunca dos del
  mismo grupo, salvo excepción documentada de "2 R2" (solo desde
  diciembre-enero, con justificación explícita).
- De junio a diciembre, el R1 hace guardia parcial ("mochila", hasta las
  20:00). Si falta un R2 ese día, prioridad: un R4 solo (preferente) >
  un R3 solo > excepción "2 R2".

CARGA MENSUAL:
- Mínimo 4, máximo 6 guardias por residente y mes (salvo ausencias, que
  reducen el cupo proporcionalmente).

EQUIDAD (dentro del mismo año formativo — R1 con R1, R2 con R2, etc.):
- Al cierre del año de residencia, diferencia máxima de 1 en: guardias
  totales, fines de semana, festivos, puentes, dobletes.
- Preferí parejas viernes-domingo por sobre sábado suelto, para reducir
  fines de semana en el hospital — repartilos también con diferencia
  máxima de 1 por residente.
- Un residente con más carga acumulada este año (ver contaje adjunto)
  debe recibir, en igualdad de condiciones, guardias de menor impacto
  que uno con menos carga.

IMPACTO SOBRE EL DESCANSO (criterio adicional, no obligatorio):
- Preferí no fragmentar periodos largos de descanso (puentes, semanas
  con festivo): una guardia a mitad de un periodo de varios días libres
  vale más evitarla que una guardia en el borde de ese mismo periodo.

DISPONIBILIDAD:
- Nunca asignes una guardia a un residente marcado como no disponible
  (bloqueo DURO) en `disponibilidad` para esa fecha.
- Evitá, si es posible, los bloqueos BLANDOS (preferencias, no
  obligación).
```

## 3. Datos de entrada (los rellena la app)

Cada residente aparece con **dos datos de identidad distintos, a
propósito** (ver la nota de identidad más abajo): un `id` interno estable
(el que de verdad se guarda en el Sheet/historial) y un `apellido` legible
(el que ve el modelo y, después, cualquier persona revisando el
resultado).

```
Residentes activos de ambos grupos, con su nivel ya derivado:
{{residentes_activos}}
  # ejemplo de formato por residente:
  # - id: "r-014", apellido: "Pérez", nivel: "R3", grupo: "MAYOR",
  #   en_mochila: false

Contaje acumulado del año de residencia en curso, por residente
(necesario para aplicar la equidad — sección 2):
{{contaje_acumulado}}
  # ejemplo:
  # - id: "r-014", guardias_totales: 6, fines_de_semana: 2,
  #   festivos: 1, puentes: 0, dobletes: 1

Disponibilidad del periodo (bloqueos DURO = vacaciones/rotación
externa/baja ya aprobados; BLANDO = preferencia, no obligación):
{{disponibilidad}}
  # ejemplo:
  # - id: "r-014", fecha_inicio: "2026-08-01",
  #   fecha_fin: "2026-08-15", tipo: "DURO", motivo: "vacaciones"

Clasificación de cada día del periodo (ya resuelta por `calendario`,
nunca la recalcules vos):
{{dias_clasificados}}
  # ejemplo:
  # - fecha: "2026-07-20", tipo_dia: "LABORABLE"
  # - fecha: "2026-07-25", tipo_dia: "FIN_DE_SEMANA"
```

## 4. Formato de salida exigido

```
Respondé ÚNICAMENTE con un JSON válido, sin texto antes ni después,
identificando a cada residente por su APELLIDO (no por el id — usá el
apellido tal como aparece en la lista de residentes de arriba), con esta
forma exacta:

{
  "guardias": [
    { "fecha": "2026-07-20", "residente": "Pérez", "doblete_con": null },
    { "fecha": "2026-07-25", "residente": "Pérez", "doblete_con": "2026-07-26" }
  ],
  "notas": "cualquier aclaración breve sobre decisiones difíciles"
}

Si no encontrás una solución que cumpla TODAS las reglas obligatorias
(sección 2, primeros tres bloques), respondé igual con la mejor
aproximación posible y explicá en "notas" qué regla no pudiste cumplir y
por qué — no inventes que está todo bien si no lo está.
```

## 5. Ciclo de reintento (cuando el validador encuentra violaciones)

```
Tu propuesta anterior violó estas reglas:
{{incidencias_del_validador}}

Corregí el cuadrante para resolver estos puntos específicos, cambiando
la menor cantidad posible de asignaciones respecto a tu propuesta
anterior. Respondé de nuevo solo con el JSON del formato de la sección 4.
```

---

## Decisiones ya tomadas (revisadas y acordadas entre los dos)

**Identidad: id interno + apellido como etiqueta.** La auditoría de
`index.html` (`docs/auditoria/cliente-constantes-dominio.json`) ya
detectó el problema real de indexar por nombre: "renombrar un residente
(o un espacio/tilde distinto) desvincula todo su histórico; dos
registros con el mismo nombre se fusionan mal". Usar solo el apellido no
resuelve nada de esto — sigue siendo texto escrito a mano con el mismo
riesgo de tilde/espacio/tipeo, y además **aumenta** el riesgo de choque
entre dos residentes (apellidos comunes, o el caso de dos apellidos por
persona). La solución real, coherente con el resto del sistema
(ADR-001 sección 3, "clave UUID"): el **id interno nunca se muestra ni
se le pide al modelo que lo escriba** — solo circula en la lista de
entrada. El modelo trabaja y responde con el **apellido**, más fácil de
razonar y de revisar a simple vista que un id opaco. La app resuelve el
apellido de vuelta al id **inmediatamente después de recibir la
respuesta**, contra la misma lista corta que ella misma acaba de generar
en este mismo pedido (no contra todo el historial) — un `match` exacto
de bajo riesgo, que nunca llega a guardarse por nombre en ningún lado. Lo
único persistente en el Sheet/historial sigue siendo el id.

**Ambos grupos en un mismo prompt.** Ver sección 1 — decidido para poder
validar la cobertura cruzada de una sola vez.

**Resumen de reglas de la sección 2, confirmado.** Revisado por los dos
contra los documentos completos — sin objeciones.

No se ha escrito código en este documento — es la plantilla de texto que
usaría el flujo ya diseñado en el ADR, no su implementación.
