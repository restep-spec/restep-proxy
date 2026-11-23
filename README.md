# restep-proxy

Proxy HTTP inverso que vigila el contrato [Restep 1](https://restep.wubytes.com/1/) (borrador 6)
en tráfico real. Se pone delante de una API, reenvía todo sin alterarlo y comprueba cada par
petición/respuesta contra la especificación y contra el documento de descubrimiento (§4.2) de esa
API. Un solo archivo, Node 18+, sin dependencias.

Donde [`restep-check`](https://restep.wubytes.com/tools/restep-check/) genera su propio tráfico para probar una
API, `restep-proxy` mira el que ya hay: el de una aplicación, una batería de pruebas de integración
o un agente. Sirve para descubrir qué parte del contrato rompe un cliente o un servidor de verdad.

## Uso

```bash
# con tu API escuchando en :8080
npx restep-proxy --target http://localhost:8080 --port 8871
curl -g 'http://localhost:8871/books?filter[price][le]=15'                   # el tráfico va al proxy
```

| Opción | Qué hace |
|---|---|
| `--target <url>` | API a la que se reenvía (obligatoria). Si la raíz de la API no es la del host, va con su ruta: `http://api:8080/v1/`. Las rutas se reenvían tal cual. |
| `--port <n>` | Puerto del proxy (8871 por omisión). |
| `--host <host>` | Interfaz en la que escucha (`127.0.0.1` por omisión). |
| `--report <archivo>` | Al terminar, escribe el informe en JSON. |
| `--strict` | Sustituye por un `502` problem+json toda respuesta que incumpla un DEBE (para CI). |
| `--max-body <bytes>` | Cuerpo máximo que se analiza (2 MiB por omisión); los mayores se reenvían sin analizar. |
| `--preserve-host` | Reenvía el `Host` del cliente en vez del del objetivo. |
| `--quiet` | Sin log en vivo; solo el resumen final. |

Al arrancar hace un `GET` a la raíz para leer el descubrimiento (con `Authorization: Bearer` si
está `RESTEP_TOKEN`). Si no lo consigue, supone solo `core` hasta que pase uno por el proxy; cada
`GET` a la raíz que pasa lo actualiza. Un documento cuyo `restep` no sigue la gramática de §1.1 o
no es de Restep 1 no se usa (y su respuesta da `discovery.version`). Las partes experimentales
(`sync`, `inherit`) solo se juzgan si la versión declarada es una cuyo texto conoce el proxy:
`"1.0-draft.6"` (§1.2, `KNOWN_TEXTS`).

### Salida

- **Log en vivo**, agrupado por comprobación, método y ruta (`GET /books/{id}`): la primera vez
  sale con el caso concreto; después, solo un recordatorio a las 10, 100, 1000… repeticiones.
- **Resumen** al recibir `SIGINT` o `SIGTERM`, con cada grupo, su número de casos y el primero.
- **`--report`**: el mismo resumen en JSON (`violations`, `warnings`, `groups` con `check`,
  `section`, `level`, `spec`, `method`, `route`, `count`, `first`, `last`).
- **`GET /_restep-proxy`**: página HTML con el resumen (se refresca cada 10 s);
  **`GET /_restep-proxy.json`**: el informe en JSON, sin parar el proxy.
- Código de salida: `0` sin violaciones, `1` con alguna, `2` si no puede arrancar.

Un DEBE incumplido es una **violación**; un DEBERÍA, un **aviso**. `--strict` solo actúa con las
violaciones. Su `502` lleva `code: "bad_gateway"`, `upstream_status` y la lista `violations`.

### En CI

```bash
npx restep-proxy --target http://localhost:8080 --port 8871 \
  --report restep-proxy.json --strict --quiet &
PROXY=$!
API_URL=http://localhost:8871 npm test        # las pruebas de integración, contra el proxy
kill -INT $PROXY; wait $PROXY                  # sale con 1 si hubo alguna violación
```

## Qué comprueba

Cada comprobación nombra su apartado de la especificación (del borrador 6). Las que dependen del
descubrimiento (colecciones, singletons, filtros, perfiles) solo se hacen si lo hay. Las de
`cache` (`cache-control`, `cache-etag`, `if-none-match` en lecturas) solo si se anuncia `cache`, y
las de `writes` solo si se anuncia `writes`: desde el borrador 6, `Cache-Control` y `304` son de
`cache`. Los avisos de `deprecations` se leen en su sitio (raíz, colección o singleton) y con los
`kind` del borrador 6; uno con otro `kind` se ignora.

| Comprobación | § | Nivel | Qué verifica |
|---|---|---|---|
| `json` | 3 | DEBE | Un cuerpo JSON es JSON válido en UTF-8 |
| `json-type` | 3 | DEBE | Un 2xx con cuerpo lleva Content-Type: application/json (un esquema puede ir como application/schema+json) |
| `media-type` | 3 | DEBE | Un POST o QUERY con cuerpo sin Content-Type, de otro tipo o con un charset que no es UTF-8, o un PATCH de otro tipo, da 415; un cuerpo vacío con application/json da 400 |
| `media-type.accept-patch` | 5.1 | DEBERÍA | Un 415 a un PATCH lleva Accept-Patch |
| `links` | 3 | DEBE | next y href son URI absolutas o rutas absolutas bajo la raíz de la API, y una URI absoluta (también en Location y Link) usa https o el esquema de la raíz |
| `discovery.version` | 1.1 | DEBE | El restep del descubrimiento sigue la gramática mayor.menor[-draft.N\|-rc.N] y es de Restep 1 |
| `profile-link` | 4.1 | DEBERÍA | Cada respuesta lleva un único enlace rel="profile", a la URI de la versión |
| `health` | 4.4 | DEBE | El recurso de status responde 200 o 503 con Cache-Control: no-store (o 401, 403, 429) |
| `allow` | 4.3 | DEBE | Un 405 nombra en Allow los métodos declarados y ninguno más; un método declarado nunca da 405 |
| `status.success` | 5.1 | DEBE | Éxitos con el estado de la tabla: GET 200, POST 201, PATCH 200 (204 con return=minimal), DELETE 204 |
| `location` | 5.1 | DEBE | Un 201 lleva Location con la ruta del elemento: la de su colección, / y su id |
| `id.assigned` | 5.1 | DEBE | Un PATCH con otro id da 422; un POST con id, donde id_from no lo permite, también; y sin id, donde id_from es "client" |
| `patch.object` | 5.1 | DEBE | Un parche que no es un objeto JSON da 400, no éxito |
| `collection.shape` | 5.2 | DEBE | Una colección responde {items, next}, con next presente (cadena o null) |
| `reserved` | 5.3 | DEBE | Un parámetro reservado que el recurso no implementa da 400 unsupported_parameter; no se ignora |
| `error.media-type` | 5.4 | DEBE | Los 4xx y 5xx con cuerpo van en application/problem+json |
| `error.schema` | 5.4 | DEBE | El cuerpo de error cumple el esquema problem.json |
| `error.status` | 5.4 | DEBE | El status del cuerpo es el de la respuesta |
| `error.code` | 5.4 | DEBE | code sale de la tabla para ese estado, del registro de la IANA o es http_NNN |
| `error.type` | 5.4 | DEBERÍA | type es la URI de error de Restep para ese code, otra URI o about:blank |
| `error.detail` | 5.4 | DEBERÍA | Los errores llevan detail |
| `error.401` | 5.4 | DEBE | Un 401 lleva WWW-Authenticate |
| `error.405` | 5.1 | DEBE | Un 405 lleva Allow |
| `error.retry-after` | 5.4 | DEBERÍA | Un 429, un 503 o un 409 request_in_progress (7.1) llevan Retry-After |
| `error.parameter` | 5.3 | DEBE | invalid_parameter y unsupported_parameter nombran en parameter el parámetro tal como llegó |
| `error.reason` | 5.4 | DEBE | reason sigue la gramática de los nombres y, si el descubrimiento declara reasons, es una de ellas con su code |
| `cache-private.auth` | 5.1 | DEBE | Un 401 o un 403 es private o no-store |
| `no-error-in-200` | 5.4 | DEBE | Ningún objeto problem dentro de un 2xx |
| `deprecation` | 5.5 | DEBE | Lo que el descubrimiento retira lleva Deprecation y un Link rel="deprecation" (y Sunset si es un recurso, una acción o la versión); pasada la fecha, ya no funciona |
| `singleton` | 5.9 | DEBE | Un singleton responde a GET con un objeto JSON, y a POST y DELETE con 405 |
| `sync.undeclared` | 10 | DEBE | :changes en una colección que no declara sync da 404 |
| `events` | 10 | DEBE | La respuesta de events lleva Cache-Control: no-store |
| `item.discovery` | 4.2 | DEBE | Los elementos encajan con el descubrimiento: tipos declarados, mapas de idioma, relaciones y herencia |
| `relations.link` | 9 | DEBE | Un enlace de una relación a varias colecciones lleva type (una de ellas), y uno a un elemento de una subcolección lleva href, la ruta de ese elemento |
| `relations.include` | 9 | DEBE | include de una relación no declarada, no expandible, más honda que include_depth o que sigue tras una relación a varias colecciones da unsupported_parameter |
| `relations.fields` | 9 | DEBE | Una ruta con punto en fields cuya relación no está en include da invalid_parameter |
| `actions.listed` | 11.1 | DEBE | Cada acción de _actions está declarada en la colección, de elemento y con el mismo método |
| `actions.undeclared` | 11.1 | DEBE | Una acción no declarada, o declarada en el otro tipo de recurso, da 404; con otro método, 405 |
| `actions.response` | 11.1 | DEBE | Una acción responde 200 (el recurso afectado), 201 con Location (uno nuevo) o 204 |
| `actions.empty-body` | 11.1 | DEBE | Una acción con POST trata el cuerpo vacío, con o sin Content-Type, como {}: nunca da 400 ni 415 por él |
| `query.declared-rejected` | 5.3 | DEBE | Un filtro, orden o recuento declarados no se rechazan con unsupported_parameter |
| `query.named-value` | 6.1 | DEBE | Un interruptor con valor, o un filtro con nombre con type sin valor o con uno que no encaja, dan invalid_parameter |
| `query.undeclared` | 5.3 | DEBE | Un campo u operador de filtro o un campo de orden no declarados dan unsupported_parameter |
| `filter.match` | 6.1 | DEBE | Cada elemento devuelto cumple los filtros, comparando según el tipo declarado |
| `sort.order` | 6.2 | DEBE | Los elementos vienen en el orden pedido, con los que no tienen valor al final |
| `fields` | 6.3 | DEBE | Con fields solo vienen esos campos, id y los miembros que empiezan por _ |
| `limit` | 6.4 | DEBE | Una página no pasa de limit, y un limit fuera de 1..max_limit da invalid_parameter |
| `next` | 6.4 | DEBE | next lleva cursor y conserva sin cambios los demás parámetros |
| `count` | 6.5 | DEBE | count=true añade total, un entero; con count exact, sin total_estimated |
| `idempotency.key` | 7.1 | DEBE | Una Idempotency-Key mal formada da 400 bad_request; con "anonymous": false, también una sin credenciales (salvo en una acción idempotente, que la ignora); una acción idempotente no rechaza una bien formada |
| `idempotency.replay` | 7.1 | DEBE | La misma petición con la misma Idempotency-Key devuelve el mismo estado y el mismo cuerpo |
| `idempotency.replayed-header` | 7.1 | DEBERÍA | Una repetición lleva Idempotent-Replayed: true |
| `idempotency.mismatch` | 7.1 | DEBE | La misma Idempotency-Key con otra petición no tiene éxito (422 idempotency_mismatch) |
| `etag` | 7.2 | DEBE | El GET de un elemento completo lleva su ETag fuerte, y toda respuesta cuyo cuerpo es un elemento lleva _etag |
| `etag.collection` | 7.2 | DEBERÍA | Los elementos de una colección llevan _etag cuando admiten PATCH o DELETE |
| `etag.synced` | 7.2 | DEBE | En una colección que declara sync, todo elemento que admite PATCH o DELETE lleva _etag en todas las páginas |
| `if-match` | 7.2 | DEBE | If-Match con una ETag antigua da 412; con la vigente, no; una escritura a un elemento recién borrado da 404, no 412 |
| `precondition` | 7.2 | DEBE | Un 412 responde a una cabecera condicional y un 428 a una escritura sin If-Match |
| `if-none-match` | 8 | DEBE | If-None-Match que coincide da 304 a GET y HEAD (cache) y 412 a una escritura (writes) |
| `cache-control` | 8 | DEBE | Con cache, toda respuesta a GET o HEAD, también de error, lleva Cache-Control |
| `cache-etag` | 8 | DEBE | Con cache, el GET de un elemento completo o de un singleton lleva ETag |
| `cache-private` | 5.1 | DEBE | Una respuesta a una petición con credenciales es private o no-store |
| `minimal.etag` | 7.3 | DEBE | Una respuesta mínima a una escritura que no borra lleva la ETag del elemento |
| `minimal` | 7.3 | DEBERÍA | Una respuesta mínima lleva Preference-Applied |

Las comprobaciones que comparan peticiones entre sí (`if-match`, `if-none-match` en escrituras,
`idempotency.*`) usan lo que el proxy ha aprendido del tráfico: la última ETag de cada elemento y
las respuestas guardadas por clave. Se saltan si hay otra escritura sobre el mismo elemento en
curso, y una clave cuya primera respuesta no fue `2xx` no se juzga, porque el servidor PUEDE no
guardarla.

## Reenvío

- Petición y respuesta van en flujo, sin cambiar cuerpo, estado ni cabeceras salvo las hop-by-hop
  (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`,
  `Proxy-Authorization`, `Proxy-Authenticate` y las que nombre `Connection`) y `Host`, que pasa a
  ser el del objetivo salvo con `--preserve-host`. Las cabeceras repetidas se conservan.
- Mientras se reenvía se guarda una copia del cuerpo (hasta `--max-body`), que se descomprime
  (`gzip`, `deflate`, `br`) para analizarla. La respuesta se cierra después del análisis, para que
  lo aprendido esté al día antes de la petición siguiente del mismo cliente.
- Con `--strict`, la respuesta se guarda entera antes de entregarla (más latencia). Un flujo
  `text/event-stream` y un cuerpo mayor que `--max-body` se entregan siempre sin esperar.
- Si el objetivo no responde, el proxy da `502` problem+json (`bad_gateway`); eso no cuenta como
  violación.

## Pruebas

```bash
node tools/restep-proxy/test.mjs            # desde projects/restep
node tools/restep-proxy/test.mjs etag       # solo las mutaciones cuyo nombre contiene «etag»
```

Arranca el servidor de referencia en el puerto 8871 y el proxy en el 8870, manda tráfico variado
(descubrimiento, status, filtros, orden, paginación, `fields`, recuento, errores, escrituras con
`If-Match`, `If-None-Match`, `Idempotency-Key` y `Prefer`), con y sin `RESTEP_TOKEN`, y exige 0
violaciones y 0 avisos. El tráfico incluye lo del borrador 6: un `POST` como `text/plain`, un cuerpo
vacío, un `PATCH` de otro tipo, altas con y sin `id` en `categories` (`id_from: "either"`), un `id`
repetido, el singleton `shop` (con `fields`, `include`, `POST` y `DELETE`), una escritura a un
elemento recién borrado y la misma `Idempotency-Key` con otra query; y de `relations` y `actions`,
que la referencia anuncia: `include` declarado, demasiado hondo o polimórfico, `fields` con punto
con y sin `include`, la subcolección `/books/{book_id}/reviews` y un enlace con `href`, y acciones
de elemento y de colección (con `input`, con el cuerpo vacío, `GET`, no declarada, en el otro tipo
de recurso, con otro método). Después repite el mismo tráfico contra 70 copias mutadas del servidor en un directorio temporal, y cada una tiene que hacer
saltar la comprobación que la cubre. También
prueba `--strict`, la página HTML, el código de salida, las cabeceras hop-by-hop, el flujo y gzip
(con un servidor auxiliar en el 8872, que también da un `409 request_in_progress` sin
`Retry-After`; `--strict` usa el 8873).

## Límites

- Solo HTTP/1.1 hacia el cliente; no reenvía `Upgrade` (WebSocket).
- No analiza el cuerpo de los flujos SSE ni de los cuerpos mayores que `--max-body`.
- Lo aprendido del tráfico (ETags, claves) solo ve lo que pasa por el proxy: si otro cliente
  escribe directamente en la API, `if-match` puede tomar por antigua una ETag que ya no lo es.
- De `relations` comprueba los enlaces (`type`, `href`), qué `include` se acepta y `fields` con
  punto; no que `include` rellene el objeto (un relacionado que el cliente no puede ver se queda en
  su `id`, y el proxy no sabe cuál es), ni que el `href` lleve a un elemento que existe. De
  `actions`, `_actions`, la respuesta, el `404` y el `405`, el cuerpo vacío y `Idempotency-Key` en
  las idempotentes; no el `422` frente a `input`, ni que `_actions` liste solo lo disponible en el
  estado del elemento. No comprueba `batch`, `filter-expr` ni `query-method` más allá de lo pasivo
  (formato de errores, cabeceras), ni `Accept-Language`/`Vary` (§5.6), ni la paginación completa (sin repetidos ni
  huecos), que necesita recorrerla entera: eso lo hace `restep-check`. De `sync` solo mira que
  `:changes` dé `404` en una colección sin `sync`, el `_etag` de las sincronizadas y el
  `Cache-Control` de `events`; no el contenido de `:changes` ni los eventos.
- Del borrador 6 no comprueba: que el descubrimiento sea el mismo para todos los principales
  (§4.2), la gramática de los nombres que declara (§3), el orden de los errores (§5.4) salvo los
  casos de arriba, `If-Match` en un `POST` a una colección (§7.2), los grupos de caché (§8), la
  comprobación de `Origin` de §5.8, el `href` de las relaciones de un singleton ni que un `429` o
  `503` llegue solo a peticiones sin efecto (§5.7). La mayoría las prueba `restep-check`.
- `restep-check` no exporta funciones, así que las piezas que comparten (tabla de códigos,
  comparación tipada de 6.1, enlaces) están copiadas; `problem.json` también, y la prueba
  comprueba que la copia coincide con el publicado.

## Dudas sobre la spec

El borrador 6 resolvió varias del 5: el destino de una clave no incluye la query, pero la query
cuenta para «la misma petición» (§7.1); recodificar `next` no es cambiarlo (§5.2); la `ETag` de una
respuesta mínima es obligatoria (§7.3); y qué es «usar» un campo retirado (§5.5: toda respuesta que
lo lleva y toda petición que lo nombra en un parámetro). Quedan estas:

- **§7.2 y 7.3, ETag de un `201` completo.** §7.3 exige la `ETag` del elemento en una respuesta
  mínima, pero no dice si la cabecera `ETag` de un `201` con cuerpo es la ETag de elemento (sí su
  `_etag`). El proxy aprende la del `_etag` y, si no hay, la de la cabecera.
- **§5.1, «depende de las credenciales».** El proxy solo cuenta `Authorization` para exigir
  `private` o `no-store` en una lectura; no puede saber si la respuesta cambia con ellas, así que
  exige más de lo que dice el texto («una respuesta que depende de credenciales»).
- **§7.2, `HEAD` de un elemento.** Solo se exige la ETag al `GET`; por el RFC 9110 el `HEAD`
  DEBERÍA llevar las mismas cabeceras. El proxy no lo comprueba.
- **§5.5, «usar» una relación retirada.** ¿Es solo `include`, o también un filtro u orden por una
  ruta con punto que pasa por ella? El proxy cuenta las dos cosas.
- **§3, cuerpo vacío en un `PATCH`.** §3 dice que un cuerpo vacío con `application/json` da `400`
  en un `POST` o un `QUERY`; para el `PATCH` remite a §5.1, que solo dice que un parche que no es un
  objeto da `400`. El proxy trata el vacío igual que un parche que no es objeto.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-proxy>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
