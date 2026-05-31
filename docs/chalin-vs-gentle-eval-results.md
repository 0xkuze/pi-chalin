# Chalin vs Gentle: ultimos resultados de evals

Fecha de corrida: 2026-05-31  
Fuente principal preservada: `.pi-chalin/evals/workflow-quality-2026-05-31T05-33-05-292Z-sdk-12-cases-chalin-gentle-r1-57932-cd21cb37.json`  
Log `.jsonl` original: `evals/results/workflow-quality-final-12-post-empty-segment-rule-zai-glm51-r1.jsonl` (borrado despues del snapshot)
Modo: `sdk`  
Modelo de ejecucion: `zai/glm-5.1`  
Judge: `zai/glm-5.1`  
Comparative judge mode: `content-only`, con override de implementacion cuando un candidato falla validacion deterministica.  
Gentle evaluado con `gentleRoot=/Users/cristianfonseca/Documents/personal/gentle-pi` y `gentleCompanionRoot=/private/tmp/gentle-harness-runtime/node_modules`.

## Alcance exacto

Este snapshot NO mide el harness completo de subagentes. Mide la calidad/costo del camino directo de Chalin contra Gentle full en 12 tareas de implementacion/docs donde el harness las trato como direct-eligible.

Evidencia:

- `chalin_route` calls: `0`
- Gentle `subagent` calls observadas en esta matriz: `0`
- Chalin resolvio con tools nativas (`write`, `bash`, etc.).
- Gentle tambien resolvio con tools nativas aunque tenia cargado el companion bundle.

La suite que valida decision/topologia de `chalin_route` existe separada: `evals/orchestration.eval.ts`. El ultimo reporte local preservado de esa familia, `.pi-chalin/evals/orchestration-2026-05-27T03-44-14-013Z.json`, paso `19/19` con `13` casos esperados usando `chalin_route` y `6` directos. Esa suite valida routing/topologia, pero no es el mismo blind judge de output contra Gentle.

Conclusion honesta: estos resultados prueban que Chalin direct-mode fue superior a Gentle full en esta matriz final. No prueban por si solos que `chalin_route` sea superior a Gentle `pi-subagents`.

## Seguimiento routed

Se agrego un preset route-required: `bun run eval:workflow:routed`.

Que valida ahora:

- Chalin debe llamar `chalin_route` en casos complejos de arquitectura/docs.
- Gentle debe llamar `subagent` cuando corre con el companion bundle.
- El gate falla si cualquiera de los dos resuelve directo en esos casos.
- El evaluador acepta `Final answer material` de `chalin_route` como respuesta efectiva, aunque el parent no escriba una segunda respuesta.

Smoke real en `complex-bun-zig-runtime-plan`:

| Corrida | Resultado |
| --- | --- |
| Primer routed smoke | Chalin `chalin_route=0`; Gentle `subagent=0`; ambos fallaron el gate. |
| Despues del route-required scope/topologia docs | Chalin `chalin_route=1`, trace `100`, tokens `166,370`, duracion `267,137ms`; el artefacto pasa con scorer corregido (`score=84`) pero excede presupuesto de tiempo. |
| Gentle en las corridas routed | Gentle siguio con `subagent=0`; no hay evidencia todavia de Gentle full usando `pi-subagents` en esta matriz. |

Conclusion honesta actualizada: Chalin ya entra por `chalin_route` en el caso routed probado y produce output correcto, pero el modo subagentes es bastante mas lento/caro que direct-mode en ese caso. Gentle full no activo `subagent` en los routed smoke runs observados, asi que todavia no hay una comparacion blind completa de Chalin-route vs Gentle-subagent. Lo correcto es reportar direct-mode como ganado y routed-mode como instrumentado/con Chalin funcionando en smoke, pero pendiente de una matriz completa con Gentle subagents efectivamente activos.

## Resultado ejecutivo

Chalin gano esta corrida final directa contra Gentle en los 12 casos comparados.

| Metrica | Chalin | Gentle |
| --- | ---: | ---: |
| Casos deterministamente correctos | 12/12 | 6/12 |
| Blind judge wins | 12/12 | 0/12 |
| Tokens totales | 418,239 | 2,492,183 |
| Costo estimado | $2.0913 | $12.4610 |
| Duracion total observada | 752,620 ms | 1,072,553 ms |
| Tool calls totales | 144 | 282 |
| Promedio workspace score | 95.4 | 71.1 |
| Promedio workspace quality | 99.3 | 82.0 |
| Promedio efficiency score | 94.3 | 79.3 |
| Promedio judge score | 95.8 | 87.6 |
| `chalin_route` / `subagent` calls observadas | 0 | 0 |
| Agent retries | 0 | 0 |
| Infra retries | 0 | 0 |

Lectura simple: en esta corrida final, Chalin uso 83.2% menos tokens, costo 83.2% menos, hizo 48.9% menos tool calls y termino aproximadamente 29.8% mas rapido. MAS IMPORTANTE: no solo fue mas barato; tambien paso mas casos y el judge eligio su output en todos los casos despues de mirar la implementacion/validacion.

## Casos

| Caso | Chalin | Gentle | Winner | Tokens Chalin | Tokens Gentle | Lectura simple |
| --- | --- | --- | --- | ---: | ---: | --- |
| `scaffold-cli-tool` | pass | pass | Chalin | 14,259 | 168,469 | Ambos cumplen, pero Chalin maneja mejor argumentos multi-palabra, trae mas cobertura util y mantiene TypeScript estricto. |
| `holdout-scaffold-config-loader` | pass | fail | Chalin | 45,912 | 615,534 | Gentle dejo tests fuera de la ubicacion esperada y no pudo validar ejecutablemente; Chalin paso 32/32. |
| `holdout-docs-runbook` | pass | pass | Chalin | 21,465 | 192,642 | Gentle fue mas largo, pero en ingles, con una afirmacion factual incorrecta y un snippet roto; Chalin fue mas breve pero correcto. |
| `complex-rust-workspace-cache-feature` | pass | pass | Chalin | 27,892 | 123,950 | Empate tecnico en codigo; Chalin gano por mejor evidencia, documentacion de API y perfil limpio de aceptacion. |
| `community-python-feature-flags` | pass | fail | Chalin | 33,923 | 146,451 | El judge textual preferia partes de Gentle, pero Gentle fallo validacion deterministica; para tareas de implementacion, codigo verificado gana. |
| `complex-redis-c-expire-feature` | pass | pass | Chalin | 35,038 | 103,657 | Chalin uso una estructura mas robusta y tests de TTL mas fuertes; Gentle introdujo limites fijos/truncamiento no pedidos. |
| `refactor-pricing` | pass | pass | Chalin | 37,594 | 149,817 | Chalin hizo una descomposicion mas limpia y cubrio helpers con mas profundidad; Gentle extrajo alguna logica trivial. |
| `holdout-bugfix-date-parser` | pass | fail | Chalin | 48,358 | 169,636 | Codigo base similar, pero Chalin tuvo cobertura mucho mas completa y entrega final sin warning de evidencia. |
| `small-feature-search-filter` | pass | fail | Chalin | 44,261 | 144,627 | Chalin normalizo query con `trim` y cubrio espacios/descripcion vacia/no-mutacion; Gentle fallo hidden validation. |
| `large-feature-rate-limit` | pass | fail | Chalin | 29,146 | 303,104 | Chalin paso visible + hidden con reloj inyectable; Gentle fallo hidden tests, probablemente por edge cases temporales/enteros. |
| `community-next-api-validation` | pass | pass | Chalin | 40,575 | 220,720 | Chalin tuvo validacion mas granular, mas tests runner-discoverable y evito restricciones arbitrarias. |
| `complex-uv-rust-index-url-bugfix` | pass | fail | Chalin | 39,816 | 153,576 | Chalin paso 14/14 visibles + 3 hidden; Gentle fallo hidden tests aunque su salida visible parecia mas extensa. |

## Notas importantes

- Esta evidencia prueba la corrida final registrada, no una verdad universal sobre cualquier proyecto futuro.
- La comparacion fue contra Gentle con companion bundle, no contra una instancia contaminada con extensiones de Chalin.
- En esta corrida Chalin no uso `chalin_route` ni fan-out de subagentes; resolvio por caminos directos/native. Gentle tampoco uso `subagent` en esta matriz. Eso explica buena parte del ahorro de tokens y limita el alcance de la conclusion.
- El punto critico del judge actualizado es correcto: en tareas de implementacion, no basta con una explicacion bonita. El codigo, los tests, la validacion ejecutable y los hidden checks pesan por encima del texto.
- Para comparar harness completo ya existe el preset route-required, pero falta una matriz completa donde Gentle efectivamente use `subagent`; los smoke runs actuales muestran `subagent=0`.
- Los `.jsonl` se borran despues de este snapshot; el reporte JSON principal queda preservado en `.pi-chalin/evals`.
