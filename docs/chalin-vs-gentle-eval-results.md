# Chalin vs Gentle: ultimos resultados de evals

Fecha de corrida: 2026-05-31  
Fuente principal preservada: `.pi-chalin/evals/workflow-quality-2026-05-31T05-33-05-292Z-sdk-12-cases-chalin-gentle-r1-57932-cd21cb37.json`  
Fuente routed mas reciente: `.pi-chalin/evals/workflow-quality-2026-05-31T18-06-17-461Z-sdk-complex-sqlite-c-tokenizer-bugfix-chalin-r1-90945-2cab77f4.json`
Fuente comparativa routed mas reciente: `.pi-chalin/evals/workflow-quality-2026-05-31T17-59-06-355Z-sdk-complex-sqlite-c-tokenizer-bugfix-chalin-gentle-r1-81821-5f08d3a3.json`
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
- Chalin debe ejecutar pasos internos de agentes dentro de `chalin_route`; no basta con una llamada superficial al router.
- Gentle debe llamar `subagent` cuando corre con el companion bundle.
- El gate falla si cualquiera de los dos resuelve directo en esos casos.
- El evaluador acepta `Final answer material` de `chalin_route` como respuesta efectiva, aunque el parent no escriba una segunda respuesta.
- Los reportes route-required preservan `toolHistory` y `agentHistory` acotados para auditar la trayectoria sin guardar stdout completo por defecto.

Smoke real en `complex-bun-zig-runtime-plan`:

| Corrida | Resultado |
| --- | --- |
| Primer routed smoke | Chalin `chalin_route=0`; Gentle `subagent=0`; ambos fallaron el gate. |
| Despues del route-required scope/topologia docs | Chalin `chalin_route=1`, trace `100`, tokens `166,370`, duracion `267,137ms`; el artefacto pasa con scorer corregido (`score=84`) pero excede presupuesto de tiempo. |
| Gentle en las corridas routed | Gentle siguio con `subagent=0`; no hay evidencia todavia de Gentle full usando `pi-subagents` en esta matriz. |
| Routed smoke con metricas internas de agentes | Mismo fixture `abe818fb23c6`; Chalin paso (`workspace=84`, `quality=100`) con `chalin_route=1`, `agentRuns=1`, `agentSteps=3`, agentes `scout/planner/worker`, `208,776` tokens y `342,110ms`. Gentle fallo (`workspace=45`, `quality=55`) con `subagent=0`, `314,902` tokens y `144,243ms`. Reporte: `.pi-chalin/evals/workflow-quality-2026-05-31T14-54-05-084Z-sdk-complex-bun-zig-runtime-plan-chalin-gentle-r1-78009-2949c2e2.json`. |
| Judge blind manual limpio sobre artifacts routed | Ejecutado con `--no-extensions --no-skills --no-context-files`, sin nombres de harness ni metricas operativas. Candidate B era Chalin y gano: arquitectura `8` vs `6`, ABI safety `8` vs `6`; el judge marco que Chalin uso evidencia de codigo actual, contrato `#[repr(C)]` struct/pointer, lifecycle/ownership y tabla de coupling. Tambien marco deuda: Gentle fue mejor en riesgos explicitos (`8` vs `5`) y validacion (`7` vs `5`). |
| Routed implementation smoke alineado con reviewer-gate | `complex-sqlite-c-tokenizer-bugfix` paso con `workspace quality=100`, `score=84`, `chalin_route=1`, `agentSteps=5`, agentes `scout/worker/reviewer`, `verificationPassed=true`, hidden validation pass, anti-cheat pass, `193,047` tokens y `308,632ms`. El reviewer/reparacion cubrio gaps de implementacion y tests antes del PASS final. Reporte: `.pi-chalin/evals/workflow-quality-2026-05-31T17-18-35-410Z-sdk-complex-sqlite-c-tokenizer-bugfix-chalin-r1-10110-78ca28f1.json`. |
| Comparativa routed post coverage-guard | Chalin gano el blind judge de codigo contra Gentle (`95` vs `40`) porque paso hidden validation y Gentle fallo escaped quotes. Pero el gate global fallo: Chalin perdio puntos por evidencia final incompleta y Gentle no uso `subagent` (`0` llamadas). Tokens: Chalin `207,500`, Gentle `174,350`; Chalin no fue mas barato en esa muestra. Reporte: `.pi-chalin/evals/workflow-quality-2026-05-31T17-59-06-355Z-sdk-complex-sqlite-c-tokenizer-bugfix-chalin-gentle-r1-81821-5f08d3a3.json`. |
| Routed implementation con footer de evidencia | Chalin paso gates Chalin-only: `workspace quality=100`, `score=89`, `chalin_route=1`, `agentSteps=2`, agentes `worker/reviewer`, `verificationPassed=true`, hidden validation pass, anti-cheat pass, `79,095` tokens y `101,806ms`. El material final incluyo `src/sql_tokenizer.c`, `tests/test_sql_tokenizer.c` y `make test`. Reporte: `.pi-chalin/evals/workflow-quality-2026-05-31T18-06-17-461Z-sdk-complex-sqlite-c-tokenizer-bugfix-chalin-r1-90945-2cab77f4.json`. |

Conclusion honesta actualizada: Chalin ya entra por `chalin_route`, ejecuta subagentes internos reales y el reviewer puede bloquear una implementacion incompleta para forzar reparacion o cobertura permanente. En el smoke routed de implementacion mas reciente la calidad fue correcta y hidden validation paso. En la comparativa routed mas reciente el blind judge prefirio el codigo de Chalin, pero no fue una victoria limpia de harness completo: Gentle no activo `subagent` en esa corrida y Chalin no fue mas barato en tokens dentro de esa muestra comparativa. Lo correcto es reportar direct-mode como ganado, routed Chalin como funcional y mejorado, y routed Chalin-vs-Gentle-subagent como pendiente de una matriz justa donde Gentle use realmente sus subagentes.

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
