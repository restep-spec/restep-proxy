# restep-proxy

Proxy HTTP inverso que vigila el contrato [Restep 1](https://restep.wubytes.com/1/) en tráfico
real. Se pone delante de una API, reenvía todo sin alterarlo y comprueba cada par
petición/respuesta contra la especificación y contra el documento de descubrimiento (§4.2) de esa
API. Un solo archivo, Node 18+, sin dependencias.

Donde [`restep-check`](https://restep.wubytes.com/tools/restep-check.mjs) genera su propio tráfico para probar una
API, `restep-proxy` mira el que ya hay: el de una aplicación, una batería de pruebas de integración
o un agente. Sirve para descubrir qué parte del contrato rompe un cliente o un servidor de verdad.

## Uso

```bash
node vendor/restep-server.mjs                                            # API de prueba en :8080
node tools/restep-proxy/restep-proxy.mjs --target http://localhost:8080 --port 8871
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
`GET` a la raíz que pasa lo actualiza.

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
node tools/restep-proxy/restep-proxy.mjs --target http://localhost:8080 --port 8871 \
  --report restep-proxy.json --strict --quiet &
PROXY=$!
API_URL=http://localhost:8871 npm test        # las pruebas de integración, contra el proxy
kill -INT $PROXY; wait $PROXY                  # sale con 1 si hubo alguna violación
```

## Qué comprueba

Cada comprobación nombra su apartado de la especificación. Las que dependen del descubrimiento
(colecciones, filtros, perfiles) solo se hacen si lo hay.

| Comprobación | § | Nivel | Qué verifica |
|---|---|---|---|
| `json` | 3 | DEBE | Un cuerpo JSON es JSON válido en UTF-8 (también comprimido) |
| `links` | 3 | DEBE | `next` es una URI absoluta o una ruta absoluta bajo la raíz |
| `profile-link` | 4.1 | DEBERÍA | Un enlace `rel="profile"` por perfil y extensión anunciados |
| `health` | 4.4 | DEBE | El `status` declarado da `200`/`503` con `no-store` (o `401`, `403`, `429`) |
| `allow` | 4.3 | DEBE | `Allow` de un `405` = `methods`/`item_methods` declarados; un método declarado no da `405` |
| `status.success` | 5.1 | DEBE | `GET` 200, `POST` 201, `PATCH` 200 (204 con `return=minimal`), `DELETE` 204 |
| `location` | 5.1 | DEBE | Un `201` lleva `Location` = ruta de la colección + `/` + `id` |
| `id.assigned` | 5.1 | DEBE | Un `POST` con `id` o un `PATCH` con otro `id` no tienen éxito |
| `patch.object` | 5.1 | DEBE | Un parche que no es un objeto JSON no tiene éxito |
| `collection.shape` | 5.2 | DEBE | `{items, next}`, con `next` cadena o `null` |
| `reserved` | 5.3 | DEBE | Un parámetro reservado no implementado (o en una forma no admitida, o `$…`) no se ignora |
| `error.media-type` | 5.4 | DEBE | Los `4xx`/`5xx` con cuerpo van en `application/problem+json` |
| `error.schema` | 5.4 | DEBE | El error cumple [`problem.json`](https://restep.wubytes.com/1/schema/problem.json) |
| `error.status` | 5.4 | DEBE | `status` del cuerpo = estado de la respuesta |
| `error.code` | 5.4 | DEBE | `code` de la tabla para ese estado, del registro de la IANA o `http_NNN` |
| `error.type`, `error.detail` | 5.4 | DEBERÍA | `type` coherente con `code`; hay `detail` |
| `error.401`, `error.405` | 5.4, 5.1 | DEBE | `WWW-Authenticate` en un `401`; `Allow` en un `405` |
| `error.retry-after` | 5.4 | DEBERÍA | `Retry-After` en `429` y `503` |
| `error.parameter` | 5.3 | DEBE | `parameter` presente y, en `unsupported_parameter`, uno de los que llegaron |
| `no-error-in-200` | 5.4 | DEBE | Ningún objeto problem dentro de un `2xx` |
| `deprecation` | 5.5 | DEBE | Lo listado en `deprecations` lleva `Deprecation` (y `Sunset`); pasada la fecha, deja de funcionar |
| `item.discovery` | 3, 4.2, 5.7 | DEBE | Los elementos encajan con el tipo de sus campos de filtro, `language_maps`, `relations` e `inherit` |
| `query.declared-rejected` | 5.3 | DEBE | Un filtro, orden, recuento o `limit`/`cursor`/`fields` anunciados no se rechazan con `unsupported_parameter` |
| `query.undeclared` | 5.3 | DEBE | Un campo u operador de filtro o un orden no declarados no se aceptan |
| `filter.match` | 6.1 | DEBE | Cada elemento devuelto cumple cada filtro, según el tipo declarado (decimales exactos) |
| `sort.order` | 6.2 | DEBE | La página viene en el orden pedido, con los valores ausentes al final |
| `fields` | 6.3 | DEBE | Solo los campos pedidos, `id` y los miembros `_` |
| `limit` | 6.4 | DEBE | La página no pasa de `limit`; un `limit` fuera de rango no se acepta |
| `next` | 6.4 | DEBE | `next` lleva `cursor` y conserva los demás parámetros |
| `count` | 6.5 | DEBE | `count=true` añade `total` |
| `idempotency.key` | 7.1 | DEBE | Una `Idempotency-Key` mal formada no se acepta |
| `idempotency.replay` | 7.1 | DEBE | La misma petición con la misma clave devuelve el mismo estado y cuerpo |
| `idempotency.replayed-header` | 7.1 | DEBERÍA | La repetición lleva `Idempotent-Replayed: true` |
| `idempotency.mismatch` | 7.1 | DEBE | La misma clave con otro cuerpo no tiene éxito |
| `etag` | 7.2 | DEBE | `GET` de un elemento: ETag fuerte o, con `fields`/codificación, `_etag` |
| `if-match` | 7.2 | DEBE | `If-Match` con una ETag que el proxy sabe antigua da `412`; con la vigente, no |
| `precondition` | 7.2 | DEBE | Un `412` responde a una cabecera condicional; un `428`, a una escritura sin `If-Match` |
| `if-none-match` | 7.3 | DEBE | Si coincide: `304` a `GET`/`HEAD`, `412` a una escritura |
| `cache-control` | 7.3 | DEBE | Todo `GET`/`HEAD` (también los errores) lleva `Cache-Control` (con `writes`) |
| `cache-private` | 7.3 | DEBE | Con `Authorization`, `private` o `no-store` |
| `minimal` | 7.4 | DEBERÍA | Una respuesta mínima lleva `ETag`, `Location` (en `201`) y `Preference-Applied` |

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
violaciones y 0 avisos. Después repite el mismo tráfico contra 42 copias mutadas del servidor en un
directorio temporal, y cada una tiene que hacer saltar la comprobación que la cubre. También
prueba `--strict`, la página HTML, el código de salida, las cabeceras hop-by-hop, el flujo y gzip
(con un servidor auxiliar en el 8872; `--strict` usa el 8873).

## Límites

- Solo HTTP/1.1 hacia el cliente; no reenvía `Upgrade` (WebSocket).
- No analiza el cuerpo de los flujos SSE ni de los cuerpos mayores que `--max-body`.
- Lo aprendido del tráfico (ETags, claves) solo ve lo que pasa por el proxy: si otro cliente
  escribe directamente en la API, `if-match` puede tomar por antigua una ETag que ya no lo es.
- No comprueba `relations` (`include`), `sync`, `batch`, `actions`, `filter-expr` ni
  `query-method` más allá de lo pasivo (formato de errores, cabeceras), ni `Accept-Language`/`Vary`
  (§5.6), ni la paginación completa (sin repetidos ni huecos), que necesita recorrerla entera:
  eso lo hace `restep-check`.
- `restep-check` no exporta funciones, así que las piezas que comparten (tabla de códigos,
  comparación tipada de 6.1, enlaces) están copiadas; `problem.json` también, y la prueba
  comprueba que la copia coincide con el publicado.

## Dudas sobre la spec

- **§7.1, destino de una clave.** «Una clave es […] de un destino (método y ruta)». ¿La ruta
  incluye la query? El proxy la incluye; el servidor de referencia usa solo la ruta.
- **§6.4, `next` «sin cambios».** El servidor de referencia vuelve a codificar los parámetros
  (`filter[price]` sale como `filter%5Bprice%5D`). El proxy compara los valores descodificados; no
  está claro si recodificar cuenta como cambiarlos.
- **§7.2 y 7.4, ETag de un `201` completo.** 7.4 dice que un `201` mínimo lleva `ETag`, pero no
  dice si la `ETag` de un `201` con cuerpo es la ETag de elemento. El proxy lo supone para aprender
  la ETag vigente.
- **§7.4, `ETag` en la respuesta mínima.** «PUEDEN responder sin cuerpo: `201` con `Location` y
  `ETag`» no dice si `ETag` es obligatoria cuando se responde así. El proxy lo trata como DEBERÍA.
- **§5.5, qué es «usar» un campo retirado.** Para `filter`, `sort`, `method` o `collection` está
  claro; para `field` no (¿una respuesta que lo contiene?, ¿una escritura que lo envía?). El proxy
  no comprueba `kind: "field"`.
- **§7.3, «depende de las credenciales».** El proxy solo cuenta `Authorization`. ¿Cuentan las
  cookies o un certificado de cliente?
- **§7.2, `HEAD` de un elemento.** Solo se exige la ETag al `GET`; por el RFC 9110 el `HEAD`
  DEBERÍA llevar las mismas cabeceras. El proxy no lo comprueba.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-proxy>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
