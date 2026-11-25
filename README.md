# restep-proxy

A reverse HTTP proxy that watches the [Restep 1](https://w3id.org/restep/1/) (draft 7) contract
in real traffic. It sits in front of an API, forwards everything untouched and checks each
request/response pair against the specification and against that API's discovery document
(§4.2). One file, Node 18+, no dependencies.

Where [`restep-check`](https://w3id.org/restep/tools/restep-check/) generates its own traffic to test an
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
text the proxy knows: `"1.0-draft.7"` (§1.2, `KNOWN_TEXTS`). Such a document is also validated
against the embedded `discovery.json` schema (`discovery.schema`).

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

Each check names its section of the specification (draft 7). The ones that depend on the discovery
document (collections, singletons, filters, profiles) only run if there is one. The `cache` ones
(`cache-control`, `cache-etag`, `if-none-match` on reads) only if `cache` is announced, and the
`writes` ones only if `writes` is announced: since draft 6, `Cache-Control` and `304` belong to
`cache`. `deprecations` notices are read where they live (root, collection or singleton) and with
the draft 7 `kind` values; one with another `kind` is ignored.

| Check | § | Level | What it verifies |
|---|---|---|---|
| `json` | 3 | MUST | A JSON body is valid JSON in UTF-8 |
| `json-type` | 3 | MUST | A 2xx with a body carries Content-Type: application/json (a schema may be application/schema+json) |
| `media-type` | 3 | MUST | A POST or QUERY with a body and no Content-Type, another type or a charset other than UTF-8, or a PATCH of another type, gets 415; an empty body with application/json gets 400 |
| `media-type.accept-patch` | 5.1 | SHOULD | A 415 to a PATCH carries Accept-Patch |
| `media-type.accept-post` | 5.1 | SHOULD | A 415 to a POST to a collection that declares upload carries Accept-Post |
| `upload.json` | 5.1 | MUST | A collection with upload creates items from JSON only where it declares schemas.create: elsewhere a JSON body its media_types do not admit, also by a wildcard (application/* or */*), gets 415; where it does, a JSON POST creates an item, never a file; a +json body is a file like any other |
| `upload.multipart` | 5.1 | MUST | An outer multipart/form-data body selects multipart upload: it gets 415 unless upload declares "multipart": true, even when media_types admits it |
| `upload.filename` | 5.1 | MUST | The server does not require filename on the file part of a multipart upload: it reads an otherwise valid part without it as the file |
| `leap-second` | 3 | MUST | A response never writes a leap second (:60) in a declared datetime or localdatetime field, and a PATCH body with one there does not succeed and, with 422 invalid, carries a format entry (or read_only); a POST may carry one in a field only the server sets, which it ignores (5.1) |
| `i-json` | 3 | MUST | A 422 for an unpaired surrogate or a noncharacter in a request body points at the string that holds it, or at "" when that string is a member name |
| `links` | 3 | MUST | next and href are absolute URIs or absolute paths under the API root, and an absolute URI (also in Location and Link) uses https or the root's scheme |
| `discovery.schema` | 4.2 | MUST | The discovery document of a version whose text the proxy knows matches that version's `discovery.json` schema |
| `discovery.version` | 1.1 | MUST | The discovery document's restep follows the grammar major.minor[-draft.N\|-rc.N] and is Restep 1 |
| `profile-link` | 4.1 | SHOULD | Every response carries a single rel="profile" link, to the version URI |
| `health` | 4.4 | MUST | The status resource answers 200 or 503 with Cache-Control: no-store (or 401, 403, 429) |
| `allow` | 4.3 | MUST | A 405 names in Allow the declared methods and no others; a declared method never gets 405 |
| `status.success` | 5.1 | MUST | Successes use the status in the table: GET 200, POST 201, PATCH 200 (204 with return=minimal), DELETE 204 |
| `location` | 5.1 | MUST | A 201 carries Location with the item path: its collection's path, / and its id |
| `id.assigned` | 5.1 | MUST | A PATCH with another id gets 422; so does a POST with an id where id_from does not allow it, and one without an id where id_from is "client" |
| `patch.object` | 5.1 | MUST | A patch that is not a JSON object does not succeed: 422 invalid if it is JSON, 400 if it is not |
| `collection.shape` | 5.2 | MUST | A collection answers {items, next}, with next present (string or null) |
| `reserved` | 5.3 | MUST | A reserved parameter the resource does not implement gets 400 unsupported_parameter; it is not ignored |
| `error.media-type` | 5.4 | MUST | 4xx and 5xx with a body are application/problem+json |
| `error.schema` | 5.4 | MUST | The error body matches the problem.json schema |
| `error.status` | 5.4 | MUST | The body's status is the response's |
| `error.code` | 5.4 | MUST | code comes from the closed table for that status, or is `http_` and the three digits of a status the table does not list (never a name from the IANA registry) |
| `error.type` | 5.4 | SHOULD | type is the Restep error URI for that code or another URI |
| `error.about-blank` | 5.4 | MUST | type is about:blank only for a problem with nothing beyond its status: the only code the table gives that status, or `http_NNN`, and no `reason`, `errors` or `parameter` |
| `error.no-store` | 5.4 | MUST | A 428, 429, 431 or 511 carries Cache-Control: no-store |
| `error.detail` | 5.4 | SHOULD | Errors carry detail |
| `error.401` | 5.4 | MUST | A 401 carries WWW-Authenticate |
| `error.405` | 5.1 | MUST | A 405 carries Allow |
| `error.retry-after` | 5.4 | SHOULD | A 429, a 503 or a 409 request_in_progress (7.1) carries Retry-After |
| `error.parameter` | 5.3 | MUST | invalid_parameter and unsupported_parameter name in parameter the parameter as it arrived |
| `error.reason` | 5.4 | MUST | reason follows the naming grammar and, if the discovery document declares reasons, is one of them with its code |
| `cache-private.auth` | 5.1 | MUST | A 401 or a 403 is private or no-store |
| `cache-private.shared` | 5.1 | MUST | A private or no-store response carries no field aimed at shared caches (`CDN-Cache-Control`, `Surrogate-Control`) that would let one store it |
| `no-error-in-200` | 5.4 | MUST | No problem object inside a 2xx |
| `deprecation` | 5.5 | MUST | A resource retired whole (`version`, `collection`, `singleton`, `action`) carries Deprecation with the notice's `announced` instant, a Link rel="deprecation" and, once dated, Sunset; a notice that retires part of a resource puts neither Deprecation nor Sunset; after the date, what is retired no longer works |
| `singleton` | 5.9 | MUST | A singleton answers GET with a JSON object, and POST and DELETE with 405 |
| `sync.undeclared` | 10 | MUST | :changes on a collection that does not declare sync gets 404 |
| `events` | 10 | MUST | The events response carries Cache-Control: no-store |
| `item.discovery` | 4.2 | MUST | Items fit the discovery document: declared types, language maps, relations and inheritance |
| `relations.link` | 9 | MUST | A link of a relation to several collections carries type (one of them), and one to an item of a subcollection carries href, that item's path |
| `relations.include` | 9 | MUST | include of a relation that is undeclared, not expandable, deeper than include_depth, or that continues past a relation to several collections gets unsupported_parameter |
| `relations.fields` | 9 | MUST | A dotted path in fields whose relation is not in include gets invalid_parameter |
| `actions.listed` | 11.1 | MUST | Each action in _actions is declared on the collection, as an item action and with the same method |
| `actions.undeclared` | 11.1 | MUST | An undeclared action, or one declared on the other kind of resource, gets 404; with another method, 405 |
| `actions.response` | 11.1 | MUST | An action answers 200, 201 with Location or 204; an unsafe collection action never 200, a safe action never 201, a 204 without ETag (7.2), and a result with `output` without `_etag` or `_actions` |
| `actions.empty-body` | 11.1 | MUST | A POST action treats an empty body, with or without Content-Type, as {}: it never gets 400 or 415 for it |
| `actions.params` | 11.1 | MUST | A GET action answers a query parameter its params do not declare (any, where it declares no params) with 400 unsupported_parameter, and does not reject a declared one with it |
| `query.declared-rejected` | 5.3 | MUST | A declared filter, sort or count is not rejected with unsupported_parameter |
| `query.named-value` | 6.1 | MUST | A switch with a value, or a named filter with type and no value or a value that does not fit, gets invalid_parameter |
| `query.required` | 6.1 | MUST | A list request without a filter declared `"required": true` gets invalid_parameter |
| `query.undeclared` | 5.3 | MUST | An undeclared filter field or operator, or sort field, gets unsupported_parameter |
| `query.null-once` | 6.1 | MUST | More than one null filter on the same to-many relationship or list field, its own or that of a path through it, gets 400 invalid_parameter, even when their values agree |
| `query.operand` | 6.1 | MUST | An integer or number operand of a filter, or of a GET action parameter (each list element too), follows the number grammar of RFC 8259 (2e1 is 20; +20, .5, 020 and 0x14 are not numbers): an invalid one gets invalid_parameter and a valid one is not rejected with it |
| `filter.match` | 6.1 | MUST | Every returned item matches the filters, comparing by the declared type |
| `sort.order` | 6.2 | MUST | Items come in the requested order, with those without a value at the end |
| `fields` | 6.3 | MUST | With fields only those fields come back, plus id and members starting with _ |
| `limit` | 6.4 | MUST | A page does not exceed limit, and a limit outside 1..max_limit gets invalid_parameter |
| `next` | 6.4 | MUST | next carries a cursor and keeps the other parameters unchanged |
| `count` | 6.5 | MUST | count=true adds total, an integer; with count exact, without total_estimated |
| `idempotency.key` | 7.1 | MUST | A malformed Idempotency-Key gets 400 bad_request; with "anonymous": false, so does one without credentials (except on an idempotent action, which ignores it); an idempotent action does not reject a well-formed one |
| `idempotency.replay` | 7.1 | MUST | The same request with the same Idempotency-Key returns the same status and Location, and the stored body or the item's current representation (with the current ETag) |
| `idempotency.replayed-header` | 7.1 | SHOULD | A replay carries Idempotent-Replayed: true |
| `idempotency.replay-validators` | 7.1 | MUST | A replay whose body is not the item's current representation carries no Content-Location, ETag or _etag, and a replayed 201 without a body carries no ETag (7.3) |
| `idempotency.mismatch` | 7.1 | MUST | The same Idempotency-Key with a different request does not succeed (422 idempotency_mismatch) |
| `etag` | 7.2 | MUST | The GET of a full item carries its strong ETag, and every response whose body is an item carries _etag |
| `etag.collection` | 7.2 | SHOULD | Items in a collection carry _etag when they allow PATCH or DELETE |
| `etag.synced` | 7.2 | MUST | In a collection that declares sync, every item that allows PATCH or DELETE carries _etag on every page |
| `if-match` | 7.2 | MUST | If-Match with an old ETag gets 412; with the current one, it does not; a write to a just-deleted item gets 404, not 412 |
| `precondition` | 7.2 | MUST | A 412 answers a conditional header and a 428 answers a write without If-Match; where a resource requires If-Match, an If-None-Match other than * does not meet it |
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
`idempotency.replay-validators` compares the `ETag` and `_etag` of a replay (one that carries
`Idempotent-Replayed: true` or repeats a request the proxy saw) with the item's current ETag, which
the proxy also learns from the `Content-Location` and `ETag` of a `200` to an item action. A replay body
that differs from the stored one passes `idempotency.replay` when its `ETag` and `_etag` are that
current ETag (or the proxy does not know it): §7.1 lets the server return the current representation.

Filters follow the decisions of the draft 7 council: `20.0` is a valid operand of an `integer` field
(the same as `20`), a time with `:60` is not a valid `datetime` operand, a filter with `null` on a
to-many relationship or a list field treats an empty list as `null`, and such a declaration (with
`type` `string` or the elements' type, without `quantifier`) does not make the item's list a type
error. `leap-second` knows which fields are instants or local date-times from their `filter`
declarations of type `datetime` or `localdatetime` and from `local_times`.

From the council's round 3: integer and number operands of filters and of `GET` action parameters
(each list element too) follow the number grammar of RFC 8259 (`2e1` is `20`; `+20`, `.5`, `020`
and `0x14` are not numbers), judged both ways (`query.operand`); `null` with `quantifier` tests the
whole list: alone, empty or absent; with other filters on the same list field, `true` when no
element matches them all at once and `false` when some does (on a relationship, only `null` alone, from the links
the item lists); `leap-second` judges a `PATCH` but not a `POST`, which ignores `:60` in a field only
the server sets and the proxy cannot tell which those are; a collection with `upload` creates from
JSON only with `schemas.create`, and with it a JSON `POST` never stores a file (`upload.json`); a
replayed `201` without a body carries no `ETag`; a write that answered `428` to a request without
`If-Match` does not succeed later with an `If-None-Match` other than `*` (`precondition`); and a
`format` entry for a surrogate in a member name points at `""` (`i-json`). From round 4: without
`create`, `*/*` and `application/*` admit a JSON file, and a `+json` body (`application/ld+json`)
is a file, so an item created from it without `_content` is a violation (`upload.json`); an outer
`multipart/form-data` gets `415` unless `upload.multipart` is `true`, even when `media_types` admits
it (`upload.multipart`); a `400` or `422` to a `file` part without `filename` whose type
`media_types` admits is a violation (`upload.filename`); two `null` filters on the same group (the
first step of a path through a to-many relationship, or a field with `quantifier`) accepted, or
rejected with another code, are a violation (`query.null-once`); `null=true` with several filters
of a list field selects the items where no element matches them all at once; and a numeric operand
is compared exactly, also outside the range of a double, so `1e-400` that matches `0` or `-1e400`
that matches as an infinity is a `filter.match`, and a `400` other than `invalid_parameter`, a `422`
or a `500` to one is a `query.operand` (its `invalid_parameter` is not judged: it may be a request
limit, §5.3).

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
undeclared, on the other kind of resource, with another method). From draft 7 it also sends: `find_or_create` twice (the second time `204`), an upload to `/files`
(and a `text/plain` one), `/genres` with `Accept-Language` and `prefix`, `/orders` with and without
its default filter and `:new`, `/payments` (no `GET`), a subcollection with `reusable_ids`, the
`/readers/{reader_id}/settings` singleton and an upsert in `drafts`. Then it replays the same traffic
against 71 mutated copies of the server in a temporary directory, and each one has to
trigger the check that covers it. It also
tests the embedded `problem.json` and `discovery.json` against the published ones, the JSON Schema
validator (`$ref`, `allOf`, `if`/`then`/`else`, `const`, `not`, `oneOf`, `contains`…), `--strict`, the
HTML page, the exit code, hop-by-hop headers, streaming and gzip (with a helper server on 8872,
which also returns a `409 request_in_progress` without `Retry-After` and the draft 7 error cases:
an IANA name, `about:blank` with a parameter, a `429` without `no-store`, `CDN-Cache-Control` on a
private response); `--strict` uses 8873; and a server with a discovery document of its own on 8874
(a partial notice with `Deprecation`, an unsafe collection action that answers `200`, a result
with `output` and `_etag`, a `next` with `[` unencoded, a missing required filter and a
`shared_cache` that `discovery.json` forbids; and, from the council's decisions, `GET` actions with and
without `params` that accept undeclared parameters, a `415` without `Accept-Post` from an upload-only
collection, `filter[n]=20.0`, `null` on a list field and a to-many relationship, `:60` in a response
and in accepted or badly rejected bodies, and an action replayed after another write with its old
`Content-Location`, `ETag` and `_etag`; from round 3, numeric operands and `GET` action parameters,
`null` with `quantifier` alone and with `in`, JSON bodies to upload collections with and without
`create`, a replayed minimal `201` with and without `ETag`, `If-None-Match` with a list after a `428`,
`:60` in a `PATCH` to a `datetime` and a `localdatetime`, and the pointer of a surrogate in a member
name; from round 4, a JSON file through `*/*`, `application/ld+json` with `create`, `multipart/form-data`
without `"multipart": true` and a `file` part without `filename`, operands outside the range of a
double, two `null` filters on one group and `null` with two other filters of a list). It also validates discovery documents with `null` as the only
operator and a singleton's `method_effects` against the embedded schema. `RESTEP_REF=/path/to/restep-server.mjs` runs it
against another copy of the reference.

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
- From draft 7 it does not check: localized fields and `Vary` (§3, §5.6), the groups of filters with
  `quantifier` beyond `null` on a list field (§6.1), uploads beyond their media type and the JSON
  rules of `create` (`413`, `_content`), `upsert` and `reusable_ids` (§5.1), `params` of `GET` actions
  beyond undeclared names and numeric values (§11.1), `inherit_items` (§11.6), which fields only the
  server sets (so not `:60` in a `POST`, §3) or a literal `+`
  in `next` (indistinguishable from a space); `prefix` and `contains` only with code points.
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
site, where the tool is developed alongside the [specification](https://w3id.org/restep/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
