# Chalin vs Gentle: ultimos resultados de evals

Fecha de corrida: 2026-05-31  
Fuente principal preservada: `.pi-chalin/evals/workflow-quality-2026-05-31T05-33-05-292Z-sdk-12-cases-chalin-gentle-r1-57932-cd21cb37.json`  
Log `.jsonl` original: `evals/results/workflow-quality-final-12-post-empty-segment-rule-zai-glm51-r1.jsonl`  
Modo: `sdk`  
Modelo de ejecucion: `zai/glm-5.1`  
Judge: `zai/glm-5.1`  
Comparative judge mode: `content-only`, con override de implementacion cuando un candidato falla validacion deterministica.  
Gentle evaluado con `gentleRoot=/Users/cristianfonseca/Documents/personal/gentle-pi` y `gentleCompanionRoot=/private/tmp/gentle-harness-runtime/node_modules`.

## Resultado ejecutivo

Chalin gano la corrida final contra Gentle en los 12 casos comparados.

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
| `chalin_route` calls | 0 | 0 |
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
- En esta corrida Chalin no uso `chalin_route` ni fan-out de subagentes; resolvio por caminos directos/native. Eso explica buena parte del ahorro de tokens.
- El punto critico del judge actualizado es correcto: en tareas de implementacion, no basta con una explicacion bonita. El codigo, los tests, la validacion ejecutable y los hidden checks pesan por encima del texto.
- Los `.jsonl` se borran despues de este snapshot; el reporte JSON principal queda preservado en `.pi-chalin/evals`.
