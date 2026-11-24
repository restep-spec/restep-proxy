# restep-proxy

A reverse HTTP proxy that watches the [Restep 1](https://restep.wubytes.com/1/) (draft 6) contract
in real traffic. It sits in front of an API, forwards everything untouched and checks each
request/response pair against the specification and against that API's discovery document
(§4.2). One file, Node 18+, no dependencies.

Where [`restep-check`](https://restep.wubytes.com/tools/restep-check/) generates its own traffic to test an
API, `restep-proxy` watches the traffic that is already there: an application's, an integration
test suite's or an agent's. It tells you which part of the contract a real client or server breaks.

## Usage

```bash
# with your API listening on :8080
npx restep-proxy --target http://localhost:8080 --port 8871
curl -g 'http://localhost:8871/books?filter[price][le]=15'                   # traffic goes through the proxy
```

| Option | What it does |
|---|---|
| `--target <url>` | API to forward to (required). If the API root is not the host root, include its path: `http://api:8080/v1/`. Paths are forwarded as they are. |
| `--port <n>` | Proxy port (8871 by default). |
| `--host <host>` | Interface to listen on (`127.0.0.1` by default). |
| `--report <file>` | On exit, writes the report as JSON. |
| `--strict` | Replaces every response that breaks a MUST with a `502` problem+json (for CI). |
| `--max-body <bytes>` | Largest body that is analysed (2 MiB by default); larger ones are forwarded unanalysed. |
| `--preserve-host` | Forwards the client's `Host` instead of the target's. |
| `--quiet` | No live log; only the final summary. |

On startup it sends a `GET` to the root to read the discovery document (with `Authorization: Bearer`
if `RESTEP_TOKEN` is set). If that fails, it assumes only `core` until one passes through the proxy;
every `GET` to the root that passes through updates it. A document whose `restep` does not follow
the grammar of §1.1 or is not Restep 1 is not used (and its response triggers `discovery.version`).
The experimental parts (`sync`, `inherit`) are only judged if the declared version is one whose
text the proxy knows: `"1.0-draft.6"` (§1.2, `KNOWN_TEXTS`).

### Output

- **Live log**, grouped by check, method and route (`GET /books/{id}`): the first occurrence shows
  the concrete case; after that, only a reminder at 10, 100, 1000… repetitions.
- **Summary** on `SIGINT` or `SIGTERM`, with each group, its number of cases and the first one.
- **`--report`**: the same summary as JSON (`violations`, `warnings`, `groups` with `check`,
  `section`, `level`, `spec`, `method`, `route`, `count`, `first`, `last`).
- **`GET /_restep-proxy`**: HTML page with the summary (refreshes every 10 s);
  **`GET /_restep-proxy.json`**: the JSON report, without stopping the proxy.
- Exit code: `0` with no violations, `1` with any, `2` if it cannot start.

A broken MUST is a **violation**; a broken SHOULD, a **warning**. `--strict` only acts on
violations. Its `502` carries `code: "bad_gateway"`, `upstream_status` and the `violations` list.

### In CI

```bash
npx restep-proxy --target http://localhost:8080 --port 8871 \
  --report restep-proxy.json --strict --quiet &
PROXY=$!
API_URL=http://localhost:8871 npm test        # the integration tests, against the proxy
kill -INT $PROXY; wait $PROXY                  # exits with 1 if there was any violation
```

## What it checks

Each check names its section of the specification (draft 6). The ones that depend on the discovery
document (collections, singletons, filters, profiles) only run if there is one. The `cache` ones
(`cache-control`, `cache-etag`, `if-none-match` on reads) only if `cache` is announced, and the
`writes` ones only if `writes` is announced: since draft 6, `Cache-Control` and `304` belong to
`cache`. `deprecations` notices are read where they live (root, collection or singleton) and with
the draft 6 `kind` values; one with another `kind` is ignored.

| Check | § | Level | What it verifies |
|---|---|---|---|
| `json` | 3 | MUST | A JSON body is valid JSON in UTF-8 |
| `json-type` | 3 | MUST | A 2xx with a body carries Content-Type: application/json (a schema may be application/schema+json) |
| `media-type` | 3 | MUST | A POST or QUERY with a body and no Content-Type, another type or a charset other than UTF-8, or a PATCH of another type, gets 415; an empty body with application/json gets 400 |
| `media-type.accept-patch` | 5.1 | SHOULD | A 415 to a PATCH carries Accept-Patch |
| `links` | 3 | MUST | next and href are absolute URIs or absolute paths under the API root, and an absolute URI (also in Location and Link) uses https or the root's scheme |
| `discovery.version` | 1.1 | MUST | The discovery document's restep follows the grammar major.minor[-draft.N\|-rc.N] and is Restep 1 |
| `profile-link` | 4.1 | SHOULD | Every response carries a single rel="profile" link, to the version URI |
| `health` | 4.4 | MUST | The status resource answers 200 or 503 with Cache-Control: no-store (or 401, 403, 429) |
| `allow` | 4.3 | MUST | A 405 names in Allow the declared methods and no others; a declared method never gets 405 |
| `status.success` | 5.1 | MUST | Successes use the status in the table: GET 200, POST 201, PATCH 200 (204 with return=minimal), DELETE 204 |
| `location` | 5.1 | MUST | A 201 carries Location with the item path: its collection's path, / and its id |
| `id.assigned` | 5.1 | MUST | A PATCH with another id gets 422; so does a POST with an id where id_from does not allow it, and one without an id where id_from is "client" |
| `patch.object` | 5.1 | MUST | A patch that is not a JSON object gets 400, not success |
| `collection.shape` | 5.2 | MUST | A collection answers {items, next}, with next present (string or null) |
| `reserved` | 5.3 | MUST | A reserved parameter the resource does not implement gets 400 unsupported_parameter; it is not ignored |
| `error.media-type` | 5.4 | MUST | 4xx and 5xx with a body are application/problem+json |
| `error.schema` | 5.4 | MUST | The error body matches the problem.json schema |
| `error.status` | 5.4 | MUST | The body's status is the response's |
| `error.code` | 5.4 | MUST | code comes from the table for that status, from the IANA registry, or is http_NNN |
| `error.type` | 5.4 | SHOULD | type is the Restep error URI for that code, another URI, or about:blank |
| `error.detail` | 5.4 | SHOULD | Errors carry detail |
| `error.401` | 5.4 | MUST | A 401 carries WWW-Authenticate |
| `error.405` | 5.1 | MUST | A 405 carries Allow |
| `error.retry-after` | 5.4 | SHOULD | A 429, a 503 or a 409 request_in_progress (7.1) carries Retry-After |
| `error.parameter` | 5.3 | MUST | invalid_parameter and unsupported_parameter name in parameter the parameter as it arrived |
| `error.reason` | 5.4 | MUST | reason follows the naming grammar and, if the discovery document declares reasons, is one of them with its code |
| `cache-private.auth` | 5.1 | MUST | A 401 or a 403 is private or no-store |
| `no-error-in-200` | 5.4 | MUST | No problem object inside a 2xx |
| `deprecation` | 5.5 | MUST | What the discovery document deprecates carries Deprecation and a Link rel="deprecation" (and Sunset if it is a resource, an action or the version); after the date, it no longer works |
| `singleton` | 5.9 | MUST | A singleton answers GET with a JSON object, and POST and DELETE with 405 |
| `sync.undeclared` | 10 | MUST | :changes on a collection that does not declare sync gets 404 |
| `events` | 10 | MUST | The events response carries Cache-Control: no-store |
| `item.discovery` | 4.2 | MUST | Items fit the discovery document: declared types, language maps, relations and inheritance |
| `relations.link` | 9 | MUST | A link of a relation to several collections carries type (one of them), and one to an item of a subcollection carries href, that item's path |
| `relations.include` | 9 | MUST | include of a relation that is undeclared, not expandable, deeper than include_depth, or that continues past a relation to several collections gets unsupported_parameter |
| `relations.fields` | 9 | MUST | A dotted path in fields whose relation is not in include gets invalid_parameter |
| `actions.listed` | 11.1 | MUST | Each action in _actions is declared on the collection, as an item action and with the same method |
| `actions.undeclared` | 11.1 | MUST | An undeclared action, or one declared on the other kind of resource, gets 404; with another method, 405 |
| `actions.response` | 11.1 | MUST | An action answers 200 (the affected resource), 201 with Location (a new one) or 204 |
| `actions.empty-body` | 11.1 | MUST | A POST action treats an empty body, with or without Content-Type, as {}: it never gets 400 or 415 for it |
| `query.declared-rejected` | 5.3 | MUST | A declared filter, sort or count is not rejected with unsupported_parameter |
| `query.named-value` | 6.1 | MUST | A switch with a value, or a named filter with type and no value or a value that does not fit, gets invalid_parameter |
| `query.undeclared` | 5.3 | MUST | An undeclared filter field or operator, or sort field, gets unsupported_parameter |
| `filter.match` | 6.1 | MUST | Every returned item matches the filters, comparing by the declared type |
| `sort.order` | 6.2 | MUST | Items come in the requested order, with those without a value at the end |
| `fields` | 6.3 | MUST | With fields only those fields come back, plus id and members starting with _ |
| `limit` | 6.4 | MUST | A page does not exceed limit, and a limit outside 1..max_limit gets invalid_parameter |
| `next` | 6.4 | MUST | next carries a cursor and keeps the other parameters unchanged |
| `count` | 6.5 | MUST | count=true adds total, an integer; with count exact, without total_estimated |
| `idempotency.key` | 7.1 | MUST | A malformed Idempotency-Key gets 400 bad_request; with "anonymous": false, so does one without credentials (except on an idempotent action, which ignores it); an idempotent action does not reject a well-formed one |
| `idempotency.replay` | 7.1 | MUST | The same request with the same Idempotency-Key returns the same status and the same body |
| `idempotency.replayed-header` | 7.1 | SHOULD | A replay carries Idempotent-Replayed: true |
| `idempotency.mismatch` | 7.1 | MUST | The same Idempotency-Key with a different request does not succeed (422 idempotency_mismatch) |
| `etag` | 7.2 | MUST | The GET of a full item carries its strong ETag, and every response whose body is an item carries _etag |
| `etag.collection` | 7.2 | SHOULD | Items in a collection carry _etag when they allow PATCH or DELETE |
| `etag.synced` | 7.2 | MUST | In a collection that declares sync, every item that allows PATCH or DELETE carries _etag on every page |
| `if-match` | 7.2 | MUST | If-Match with an old ETag gets 412; with the current one, it does not; a write to a just-deleted item gets 404, not 412 |
| `precondition` | 7.2 | MUST | A 412 answers a conditional header and a 428 answers a write without If-Match |
| `if-none-match` | 8 | MUST | A matching If-None-Match gets 304 on GET and HEAD (cache) and 412 on a write (writes) |
| `cache-control` | 8 | MUST | With cache, every response to GET or HEAD, errors included, carries Cache-Control |
| `cache-etag` | 8 | MUST | With cache, the GET of a full item or of a singleton carries ETag |
| `cache-private` | 5.1 | MUST | A response to a request with credentials is private or no-store |
| `minimal.etag` | 7.3 | MUST | A minimal response to a write that does not delete carries the item's ETag |
| `minimal` | 7.3 | SHOULD | A minimal response carries Preference-Applied |

The checks that compare requests with each other (`if-match`, `if-none-match` on writes,
`idempotency.*`) use what the proxy has learned from the traffic: the last ETag of each item and
the responses stored per key. They are skipped if another write to the same item is in flight, and
a key whose first response was not `2xx` is not judged, because the server MAY not store it.

## Forwarding

- Request and response are streamed, without changing body, status or headers except the
  hop-by-hop ones (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`,
  `Proxy-Authorization`, `Proxy-Authenticate` and any named in `Connection`) and `Host`, which
  becomes the target's unless `--preserve-host` is set. Repeated headers are kept.
- While forwarding, a copy of the body is kept (up to `--max-body`) and decompressed (`gzip`,
  `deflate`, `br`) for analysis. The response is closed after the analysis, so that what was
  learned is up to date before the same client's next request.
- With `--strict`, the whole response is buffered before it is delivered (more latency). A
  `text/event-stream` stream and a body larger than `--max-body` are always delivered without waiting.
- If the target does not answer, the proxy returns `502` problem+json (`bad_gateway`); that does
  not count as a violation.

## Tests

```bash
node tools/restep-proxy/test.mjs            # from projects/restep
node tools/restep-proxy/test.mjs etag       # only the mutations whose name contains "etag"
```

It starts the reference server on port 8871 and the proxy on 8870, sends varied traffic
(discovery, status, filters, sorting, pagination, `fields`, count, errors, writes with `If-Match`,
`If-None-Match`, `Idempotency-Key` and `Prefer`), with and without `RESTEP_TOKEN`, and requires 0
violations and 0 warnings. The traffic covers what draft 6 added: a `POST` as `text/plain`, an empty
body, a `PATCH` of another type, creations with and without `id` in `categories` (`id_from:
"either"`), a repeated `id`, the `shop` singleton (with `fields`, `include`, `POST` and `DELETE`), a
write to a just-deleted item and the same `Idempotency-Key` with another query; and, from
`relations` and `actions`, which the reference announces: declared, too deep or polymorphic
`include`, dotted `fields` with and without `include`, the `/books/{book_id}/reviews` subcollection
and a link with `href`, and item and collection actions (with `input`, with an empty body, `GET`,
undeclared, on the other kind of resource, with another method). Then it replays the same traffic against 70 mutated copies of the server in a temporary directory, and each one has to
trigger the check that covers it. It also
tests `--strict`, the HTML page, the exit code, hop-by-hop headers, streaming and gzip (with a
helper server on 8872, which also returns a `409 request_in_progress` without `Retry-After`;
`--strict` uses 8873).

## Limits

- HTTP/1.1 only towards the client; it does not forward `Upgrade` (WebSocket).
- It does not analyse the body of SSE streams or of bodies larger than `--max-body`.
- What it learns from the traffic (ETags, keys) only covers what goes through the proxy: if another
  client writes directly to the API, `if-match` may take an ETag as old when it is not.
- From `relations` it checks the links (`type`, `href`), which `include` values are accepted and
  dotted `fields`; not that `include` fills in the object (a related item the client cannot see
  stays as its `id`, and the proxy does not know which one it is), nor that the `href` leads to an
  existing item. From `actions`, `_actions`, the response, the `404` and `405`, the empty body and
  `Idempotency-Key` on idempotent ones; not the `422` against `input`, nor that `_actions` lists
  only what is available in the item's state. It does not check `batch`, `filter-expr` or
  `query-method` beyond the passive parts (error format, headers), nor `Accept-Language`/`Vary`
  (§5.6), nor full pagination (no repeats or gaps), which requires walking all of it: `restep-check`
  does that. From `sync` it only checks that `:changes` gets `404` on a collection without `sync`,
  the `_etag` of synced collections and the `Cache-Control` of `events`; not the content of
  `:changes` or the events.
- From draft 6 it does not check: that the discovery document is the same for every principal
  (§4.2), the grammar of the names it declares (§3), the order of errors (§5.4) beyond the cases
  above, `If-Match` on a `POST` to a collection (§7.2), cache groups (§8), the `Origin` check of
  §5.8, the `href` of a singleton's relations, or that a `429` or `503` only reaches requests with
  no effect (§5.7). `restep-check` tests most of them.
- `restep-check` does not export functions, so the pieces they share (code table, typed comparison
  from 6.1, links) are copied; `problem.json` too, and the tests check that the copy matches the
  published one.

## Questions about the spec

Draft 6 settled several from draft 5: a key's target does not include the query, but the query
counts towards "the same request" (§7.1); re-encoding `next` is not changing it (§5.2); the `ETag`
of a minimal response is mandatory (§7.3); and what "using" a deprecated field means (§5.5: every
response that carries it and every request that names it in a parameter). These remain:

- **§7.2 and 7.3, ETag of a full `201`.** §7.3 requires the item's `ETag` in a minimal response,
  but does not say whether the `ETag` header of a `201` with a body is the item ETag (its `_etag`
  is). The proxy learns the one from `_etag` and, if there is none, the one from the header.
- **§5.1, "depends on credentials".** The proxy only counts `Authorization` to require `private`
  or `no-store` on a read; it cannot know whether the response varies with them, so it requires
  more than the text says ("a response that depends on credentials").
- **§7.2, `HEAD` of an item.** The ETag is only required on `GET`; per RFC 9110 the `HEAD` SHOULD
  carry the same headers. The proxy does not check it.
- **§5.5, "using" a deprecated relation.** Is it only `include`, or also a filter or sort on a
  dotted path that goes through it? The proxy counts both.
- **§3, empty body in a `PATCH`.** §3 says an empty body with `application/json` gets `400` on a
  `POST` or a `QUERY`; for `PATCH` it refers to §5.1, which only says that a patch that is not an
  object gets `400`. The proxy treats an empty one like a patch that is not an object.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-proxy>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
