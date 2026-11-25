// Tests for restep-proxy:
//  1. The embedded error schema matches schema/problem.json.
//  2. In front of the reference server, with varied traffic: 0 violations and 0 warnings.
//  3. In front of mutated copies of the server (in a temporary directory): each mutation trips
//     the check that covers it.
//  4. --strict replaces the response that breaks the contract with a 502 problem+json and lets the others through
//     byte for byte.
//  5. Forwarding: hop-by-hop headers, streamed response and compressed body.
//   node tools/restep-proxy/test.mjs            (from projects/restep)
//   node tools/restep-proxy/test.mjs cursor     (only the mutations whose name contains "cursor")
// Ports: 8870 (proxy), 8871 (server), 8872 (auxiliary server), 8873 (strict proxy), 8874 (server with its own discovery document).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { PROBLEM_SCHEMA, DISCOVERY_SCHEMA, CHECKS, sectionUrl, schemaErrors } from './restep-proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// RESTEP_REF: another copy of the reference server (while public/ref is being edited, for instance).
const SERVER = readFileSync(process.env.RESTEP_REF ?? join(here, 'vendor/restep-server.mjs'), 'utf8');
const PROXY = join(here, 'restep-proxy.mjs');
const PROXY_PORT = 8870, SERVER_PORT = 8871, AUX_PORT = 8872, STRICT_PORT = 8873, THINGS_PORT = 8874;
const TOKEN = 'restep-proxy-test';
const OAUTH = 'oauth';
const only = process.argv[2];

// [name, check that must trip, [[server text, replacement], ...], mode]
const MUTATIONS = [
  ['next missing at the end', 'collection.shape',
    [[' next,\n    ...(count', ' ...(next && { next }),\n    ...(count']]],
  ['collection without _etag', 'etag.collection', [['_etag: etag(r) })), next,', '})), next,']]],
  ['errors as application/json', 'error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['different status in the body', 'error.status',
    [["title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,", "title: text(TITLES[p.status] ?? 'Error', lang), status: 400,"]]],
  ['404 with another code', 'error.code',
    [['code: p.code, detail: text(p.detail, lang),', "code: p.status === 404 ? 'missing' : p.code, detail: text(p.detail, lang),"]]],
  ['errors entry without code', 'error.schema',
    [["if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), code: 'required', detail:", 'if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), detail:']]],
  ['405 without Allow', 'error.405',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, {}"]]],
  ['Allow different from what is declared', 'allow',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, { Allow: 'GET, HEAD' }"]]],
  ['unsupported_parameter without parameter', 'error.parameter',
    [["new Problem(400, 'unsupported_parameter', detail, { parameter });", "new Problem(400, 'unsupported_parameter', detail, {});"]]],
  ['body that is not JSON', 'json',
    [["const body = data === undefined ? '' : JSON.stringify(data);", "const body = data === undefined ? '' : JSON.stringify(data) + (status === 404 ? '}' : '');"]]],
  ['reserved parameter ignored', 'reserved',
    [['if (!allowed.includes(base)) throw unsupported(key);', 'if (!allowed.includes(base)) continue;']]],
  ['no profile header', 'profile-link',
    [['res.writeHead(status, { Link: link,', 'res.writeHead(status, {']]],
  ['errors without Cache-Control', 'cache-control',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]]],
  ['status without no-store', 'health',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });",
      "res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'max-age=60' });"]]],
  ['POST gets 200', 'status.success', [['const response = [201, prefer ? undefined : withEtag(shown)', 'const response = [200, prefer ? undefined : withEtag(shown)']]],
  ['201 without Location', 'location', [['{ Location: location(row), ETag: etag(shown),', '{ ETag: etag(shown),']]],
  ['POST with id accepted', 'id.assigned', [["if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "if (false) return [{ pointer: '/id', code: 'read_only'"]]],
  ['PATCH with another id accepted', 'id.assigned', [["if ('id' in patch && patch.id !== id) throw invalid(", 'if (false) throw invalid(']]],
  ['patch that is an array accepted', 'patch.object',
    [['  if (!isObject(v)) return [v, v];', '  if (Array.isArray(v)) return [{}, v];\n  if (!isObject(v)) return [v, v];']]],
  ['price as a number', 'item.discovery', [["price: '18.50', rating: 4.6", 'price: 18.5, rating: 4.6']]],
  // The reference retires sorting by year (5.5) and sends Deprecation when it is used: the mutation stops sending it.
  ['deprecation without Deprecation', 'deprecation',
    [['return notice ? { Deprecation: epoch(notice.announced),', 'return false ? { Deprecation: epoch(notice.announced),']]],
  ['deprecation without Link rel="deprecation"', 'deprecation',
    [['Link: `${link}, <${SPEC}#versions>; rel="deprecation"` } : {};', 'Link: link } : {};']]],
  ['limit silently clamped', 'limit',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['next loses the parameters', 'next', [['const q = new URLSearchParams(params);', 'const q = new URLSearchParams();']]],
  ['relative next', 'links', [['next = `${path}?${q}`;', 'next = `${path.slice(1)}?${q}`;']]],
  ['ge returns missing values', 'filter.match',
    [['test = (x) => x != null && OPS[op](compare(type, x, v, collation));',
      "test = (x) => (x == null && op === 'ge') || (x != null && OPS[op](compare(type, x, v, collation)));"]]],
  ['eq does not filter', 'filter.match', [['eq: (c) => c === 0,', 'eq: () => true,']]],
  ['missing values first when sorting', 'sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['fields ignored', 'fields', [['  if (!fields) return row;', '  return row;']]],
  ['count without total', 'count', [["...(count === 'true' && { total: items.length }),", '']]],
  ['declared filter rejected', 'query.declared-rejected',
    [['if (!Object.hasOwn(coll.filter ?? {}, field)) throw unsupported(key);', "if (!Object.hasOwn(coll.filter ?? {}, field) || field === 'year') throw unsupported(key);"]]],
  ['unsafe collection action that answers 200', 'actions.response', [['if (found) return [204];', 'if (found) return [200, found];']]],
  ['undeclared filter accepted', 'query.undeclared',
    [['if (!Object.hasOwn(coll.filter ?? {}, field)) throw unsupported(key);', 'if (!Object.hasOwn(coll.filter ?? {}, field)) continue;']]],
  ['named filter rejected', 'query.declared-rejected',
    [["if (named) { // 6.1", "if (named && field === 'featured') throw unsupported(key);\n    if (named) { // 6.1"]]],
  ['operator on named filter accepted', 'query.undeclared',
    [["if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));",
      'if (m[2] !== undefined) { items = items.filter((r) => named.apply(r)); continue; }']]],
  ['switch with a value accepted', 'query.named-value',
    [["if (!named.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));", '']]],
  ['weak ETag', 'etag', [['const etag = (value) => `"${hash(', 'const etag = (value) => `W/"${hash(']]],
  ['fields without _etag', 'etag', [['data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : withEtag(row);',
    'data = fields || included.length ? pick(expand(row, coll, included), fields) : withEtag(row);']]],
  ['If-Match ignored', 'if-match', [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (false)']]],
  ['412 without a conditional header', 'precondition',
    [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (ifMatch === undefined || !strongMatch(ifMatch, etag(current)))']]],
  ['If-None-Match ignored on GET', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);\n    return send(res, 200, data, headers, method === 'HEAD');", "return send(res, 200, data, headers, method === 'HEAD');"]]],
  ['If-None-Match ignored on a write', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], etag(current)))\n    throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.'",
      "if (false)\n    throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.'"]]],
  ['malformed Idempotency-Key accepted', 'idempotency.key',
    [["if (!m) throw new Problem(400, 'bad_request', t('Idempotency-Key must", "if (!m) return null; if (false) throw new Problem(400, 'bad_request', t('Idempotency-Key must"]]],
  ['replay that does not return the same', 'idempotency.replay', [['    if (live && live.print === print) return sendReplay(', '    if (false) return sendReplay(']]],
  ['different request with the same key accepted', 'idempotency.mismatch',
    [["coincide con la colección actual.'));\n    if (live) throw new Problem(422, 'idempotency_mismatch'", "coincide con la colección actual.'));\n    if (false) throw new Problem(422, 'idempotency_mismatch'"]]],
  ['minimal response without Preference-Applied', 'minimal',
    [["const applied = prefer ? { 'Preference-Applied': 'return=minimal' } : {};", 'const applied = {};']]],
  // Borrador 6
  ['POST as text/plain accepted', 'media-type', [["if (!mediaTypeOk(req.headers['content-type'], types))", 'if (false)']]],
  ['415 to a PATCH without Accept-Patch', 'media-type.accept-patch',
    [["types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {}", '{}']]],
  ['2xx with another media type', 'json-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "status >= 400 ? 'application/problem+json' : 'application/vnd.restep+json'"]]],
  ['id_from client and creation without id accepted', 'id.assigned',
    [['...(c.id_from && { id_from: c.id_from }), // 5.1', "...(c.id_from && { id_from: n === 'categories' ? 'client' : c.id_from }), // 5.1"]]],
  ['reason not in reasons', 'error.reason',
    [["return new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { errors:",
      "return new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { reason: 'id_taken', errors:"]]],
  ['Location with another scheme', 'links', [['{ Location: location(row), ETag: etag(shown),', "{ Location: `ftp://example.com${location(row)}`, ETag: etag(shown),"]]],
  ['malformed restep', 'discovery.version', [["const RESTEP = '1.0-draft.7';", "const RESTEP = '1.0.7';"]]],
  ['singleton that accepts POST', 'singleton',
    [["  if (!allow.split(', ').includes(method))\n    throw", "  if (method === 'POST') return send(res, 200, withEtag(shop.row));\n  if (!allow.split(', ').includes(method))\n    throw"]]],
  ['singleton without _etag', 'etag', [['const data = fields ? { ...pick(shop.row, fields), _etag: etag(shop.row) } : withEtag(shop.row);',
    'const data = fields ? { ...pick(shop.row, fields), _etag: etag(shop.row) } : { ...shop.row };']]],
  ['include on a singleton ignored', 'reserved', [["if (!read || base !== 'fields' || key !== base) throw unsupported(key);", 'if (false) throw unsupported(key);']]],
  ['write to a deleted item gets 412', 'if-match',
    [['if (id !== undefined && !coll.rows.has(id)) throw missing(url);',
      "if (id !== undefined && !coll.rows.has(id)) { if (req.headers['if-match']) throw new Problem(412, 'precondition_failed', 'x'); throw missing(url); }"]]],
  ['minimal response without ETag', 'minimal.etag',
    [['prefer ? undefined : withEtag(row), { ETag: etag(row), ...invalidation, ...applied });', 'prefer ? undefined : withEtag(row), { ...invalidation, ...applied });']]],
  ['same key with another query accepted', 'idempotency.mismatch', [['    const print = scope && fingerprint(params, sent);', '    const print = scope && hash(canonical([[], sent]));']]],
  ['keys without credentials with anonymous false', 'idempotency.key',
    [['idempotency: { ttl: TTL / 1000 },', 'idempotency: { ttl: TTL / 1000, anonymous: false },']]],
  // relations (9) and actions (11.1), which the reference announces since the final draft 6
  ['link to a subcollection without href', 'relations.link', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1' } },"]]],
  ['polymorphic link without type', 'relations.link', [["showcase: { type: 'products', id: '2' }, tax_rate_own: null,", "showcase: { id: '2' }, tax_rate_own: null,"]]],
  ['include deeper than include_depth accepted', 'relations.include', [['if (segs.length > (coll.include_depth ?? 1))', 'if (false)']]],
  ['dotted fields without include accepted', 'relations.fields', [['if (!include.includes(`${prefix}${m}`)) throw bad(', 'if (false) throw bad(']]],
  ['_actions with another method', 'actions.listed', [["{ method: a.method ?? 'POST', href:", "{ method: 'GET', href:"]]],
  ['action that answers 202', 'actions.response', [['row.stock = (row.stock ?? 0) + body.quantity; return [200, row];', 'row.stock = (row.stock ?? 0) + body.quantity; return [202, row];']]],
  ['undeclared action that answers 200', 'actions.undeclared',
    [["  if (!decl || decl.on !== (id === undefined ? 'collection' : 'item')", "  if (!decl) return send(res, 200, { ok: true });\n  if (!decl || decl.on !== (id === undefined ? 'collection' : 'item')"]]],
  ['action that rejects the empty body', 'actions.empty-body', [["const [body, sent] = await readJson(req, ['application/json'], true);", "const [body, sent] = await readJson(req, ['application/json'], false);"]]],
  ['401 without no-store', 'cache-private.auth', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]], OAUTH],
  ['401 without WWW-Authenticate', 'error.401', [["{ 'WWW-Authenticate': challenge }", '{}']], OAUTH],
  ['public cache with credentials', 'cache-private',
    [["if (TOKEN && cc && !cc.includes('no-store')) headers =", 'if (false) headers =']], OAUTH],
];

// ── Utilidades ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmd, args, env, ready) { // starts a process and waits for it to write the `ready` line
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.output = () => out;
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${args.join(' ')} did not start:\n${out}`)), 5000);
    const on = (b) => { out += b; if (out.includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', () => { clearTimeout(timer); if (!out.includes(ready)) reject(new Error(`${args.join(' ')} exited on startup:\n${out}`)); });
  });
}
async function stop(child) { if (child.exitCode === null) child.kill('SIGINT'); return child.exited; }

// Varied traffic against base; never throws: a mutation may answer anything.
async function traffic(base, token) {
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  async function call(method, path, { headers = {}, body, raw } = {}) {
    const h = { accept: 'application/json', ...auth, ...headers };
    if ((body !== undefined || raw !== undefined) && !h['content-type']) h['content-type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
    try {
      const r = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch {}
      return { status: r.status, headers: r.headers, data };
    } catch { return { status: 0, headers: new Headers(), data: undefined }; }
  }
  const get = (p, o) => call('GET', p, o);
  // Descubrimiento, idioma y status.
  await get('/'); await call('HEAD', '/'); await get('/', { headers: { 'accept-language': 'es' } }); await get('/?filter=1');
  await get('/health'); await call('HEAD', '/health');
  // Collections: filters, sort, fields, count, pagination and parameter errors.
  for (const q of ['', '?sort=-rating', '?sort=title', '?sort=price,id', '?filter[price][le]=15', '?filter[rating][ge]=4',
    '?filter[rating][null]=true', '?filter[category][in]=poesia,ensayo', '?filter[category]=novela-negra&count=true',
    '?filter[year][ge]=2024&sort=-year', '?fields=title,price', '?count=true&limit=3', '?limit=0', '?limit=500', '?filter[title]=x', '?filter[nope]=x',
    '?sort=nope', '?cursor=abc', '?$expand=1', '?sort[title]=asc', '?filter[price][le]=caro',
    '?filter[featured]', '?filter[search]=niebla&filter[price][le]=20', '?filter[featured][eq]=true', '?filter[featured]=1'])
    await get(`/books${q}`);
  await call('HEAD', '/books');
  let next = '/books?limit=2&sort=price&filter[price][ge]=10';
  for (let i = 0; next && i < 10; i++) { const r = await get(next); next = typeof r.data?.next === 'string' ? r.data.next : null; }
  for (const q of ['?sort=name.es-mx', '?filter[name.es-mx]=Goma', '?fields=tax_rate', '?filter[tax_rate_own][null]=true&sort=-tax_rate'])
    await get(`/products${q}`);
  await get('/categories?sort=tax_rate'); await get('/products/1'); await get('/categories/4');
  // Elementos.
  const seven = await get('/books/7');
  await get('/books/7?fields=title'); await get('/books/7?sort=id'); await get('/books/999'); await get('/books/999?sort=id');
  await call('HEAD', '/books/7'); await call('POST', '/books/7', { body: {} }); await call('PUT', '/books', { body: {} });
  if (seven.headers.get('etag')) await get('/books/7', { headers: { 'if-none-match': seven.headers.get('etag') } });
  await get('/books', { headers: { 'accept-language': 'es-ES, es;q=0.9' } });
  // Escrituras.
  await call('POST', '/books', { body: { id: '1', title: 'Con id', price: '1.00' } });
  await call('POST', '/books', { body: { price: '1.00' } });
  await call('POST', '/books', { raw: '<libro/>', headers: { 'content-type': 'application/xml' } });
  await call('POST', '/books', { body: { title: 'Sin clave', price: '3.00' }, headers: { 'idempotency-key': 'sin-comillas' } });
  const key = { 'idempotency-key': '"restep-proxy-1"' };
  const created = await call('POST', '/books', { body: { title: 'Nuevo', price: '9.99', year: 2026 }, headers: key });
  await call('POST', '/books', { body: { year: 2026, price: '9.99', title: 'Nuevo' }, headers: key }); // the same request
  await call('POST', '/books', { body: { title: 'Otro', price: '9.99' }, headers: key }); // another request, same key
  await call('POST', '/books', { body: { title: 'Mínimo', price: '2.00' }, headers: { prefer: 'return=minimal' } });
  const loc = created.headers.get('location');
  const path = loc ? new URL(loc, base).pathname : '/books/7';
  const a = (await get(path)).headers.get('etag');
  await call('PATCH', path, { body: { rating: 4.2 } }); // sin If-Match
  const b = (await call('PATCH', path, { body: { rating: 4.3 }, headers: a ? { 'if-match': a } : {} })).headers.get('etag');
  const c = (await call('PATCH', path, { body: { rating: 4.4 }, headers: { ...(a ? { 'if-match': a } : {}) } })).headers.get('etag'); // ETag antigua
  const cur = (await get(path)).headers.get('etag');
  await call('PATCH', path, { body: { rating: 4.5 }, headers: { ...(cur ? { 'if-match': cur } : {}), prefer: 'return=minimal' } });
  const now = (await get(path, { headers: { 'accept-encoding': 'identity' } })).headers.get('etag');
  if (now) await call('PATCH', path, { body: { rating: 4.6 }, headers: { 'if-none-match': now } });
  await call('PATCH', path, { raw: '[]' });
  await call('PATCH', path, { body: { id: 'otro' } });
  await call('PATCH', path, { body: { price: 'gratis' } });
  await get(`${path}?fields=title,price`);
  await call('DELETE', path); await get(path); await call('DELETE', path);
  void b; void c;
  // Draft 6: media types (3), id_from (5.1), reasons (5.4), singletons (5.9) and the query in Idempotency-Key (7.1).
  await call('POST', '/books', { raw: JSON.stringify({ title: 'Texto', price: '1.00' }), headers: { 'content-type': 'text/plain' } });
  await call('POST', '/books', { raw: '', headers: { 'content-type': 'application/json' } });
  await call('PATCH', '/books/12', { raw: JSON.stringify({ rating: 4.6 }), headers: { 'content-type': 'text/plain' } });
  if (cur) await call('PATCH', path, { body: { rating: 1 }, headers: { 'if-match': cur } }); // borrado: 404
  await call('POST', '/categories', { body: { name: 'Prueba proxy' } });
  await call('POST', '/categories', { body: { id: 'cat-proxy', name: 'Con id propio' } });
  await call('POST', '/categories', { body: { id: '1', name: 'Repetida' } });
  await get('/shop'); await get('/shop?fields=name'); await get('/shop?include=x'); await call('HEAD', '/shop');
  await call('POST', '/shop', { body: {} }); await call('DELETE', '/shop');
  const k2 = { 'idempotency-key': '"restep-proxy-q"' };
  await call('POST', '/books?origen=a', { body: { title: 'Con query', price: '1.00' }, headers: k2 });
  await call('POST', '/books?origen=b', { body: { title: 'Con query', price: '1.00' }, headers: k2 });
  // relations (9): include declared, deeper than allowed, polymorphic; dotted fields with and without include.
  for (const q of ['?include=author', '?include=related.author', '?include=nope', '?fields=title,author.name', '?include=author&fields=title,author.name'])
    await get(`/books${q}`);
  await get('/books/7?include=highlight'); await get('/categories?include=showcase'); await get('/books/7/reviews'); await get('/books/7/reviews/1');
  // actions (11.1): item with input, with an empty body, GET collection, undeclared, of another kind, another method.
  await call('POST', '/products/1:restock', { body: { quantity: 2 } });
  await call('POST', '/products/1:restock');
  await get('/products:low_stock'); await call('POST', '/books/7:nope', { body: {} }); await call('POST', '/products:restock', { body: { quantity: 1 } });
  await get('/products/1:restock'); await call('POST', '/authors:find_or_create', { body: { name: 'Autora del proxy' } });
  // 11.1: the second time the author exists: 204, never 200 (an unsafe collection action).
  await call('POST', '/authors:find_or_create', { body: { name: 'Autora del proxy' } });
  // Draft 7 in the reference: upload, localized fields, default filters, new, a collection without GET,
  // reusable ids, a singleton under an item and upsert.
  await get('/files'); await call('POST', '/files', { raw: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: { 'content-type': 'image/png' } });
  await call('POST', '/files', { raw: 'x', headers: { 'content-type': 'text/plain' } });
  await get('/genres', { headers: { 'accept-language': 'es' } }); await get('/genres?filter[name][prefix]=N&sort=name');
  await get('/orders'); await get('/orders?filter[active]=false'); await get('/orders:new'); await get('/payments');
  await get('/readers/1/subscriptions'); await get('/readers/1/settings'); await call('PATCH', '/readers/1/settings', { body: { newsletter: true } });
  await get('/readers/999/settings'); await call('PATCH', '/books/7/drafts/proxy-draft', { body: {}, headers: { 'if-none-match': '*' } });
  await get('/books?filter[title][nin]=x&filter[reviews][null]=false');
  // Products: language maps and inheritance.
  const p = await call('POST', '/products', { body: { name: { es: 'Lápiz', en: 'Pencil' }, price: '0.80', category: { id: '3' } } });
  const pl = p.headers.get('location');
  if (pl) { await call('PATCH', pl, { body: { tax_rate_own: '4' } }); await call('PATCH', pl, { body: { name: { en: null } } }); await call('DELETE', pl); }
  // Sin credenciales (con oauth, 401).
  if (token) { await fetch(`${base}/`).catch(() => {}); await fetch(`${base}/books`, { headers: { authorization: 'Bearer otro' } }).catch(() => {}); }
}

// Starts the server (mutated or not), the proxy in front, sends the traffic and returns the report.
async function run(source, mode, dir) {
  const file = join(dir, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source);
  const env = { PORT: String(SERVER_PORT), ...(mode === OAUTH ? { RESTEP_TOKEN: TOKEN } : {}) };
  const server = await start(process.execPath, [file], env, 'on http://');
  const reportFile = join(dir, 'report.json');
  rmSync(reportFile, { force: true });
  let proxy;
  try {
    proxy = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${SERVER_PORT}`, '--port', String(PROXY_PORT), '--report', reportFile],
      mode === OAUTH ? { RESTEP_TOKEN: TOKEN } : {}, 'Summary at');
    await traffic(`http://127.0.0.1:${PROXY_PORT}`, mode === OAUTH ? TOKEN : null);
    const code = await stop(proxy);
    return { code, report: JSON.parse(readFileSync(reportFile, 'utf8')), output: proxy.output() };
  } finally {
    if (proxy) await stop(proxy);
    await stop(server);
  }
}
function apply(source, edits) {
  let s = source;
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`the mutation text appears ${n} times in the server: ${from}`);
    s = s.replace(from, () => to);
  }
  return s;
}

// ── Pruebas ───────────────────────────────────────────────────────────────────
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const dir = mkdtempSync(join(tmpdir(), 'restep-proxy-'));
try {
  if (!only) {
    const published = JSON.parse(readFileSync(join(here, 'schema/problem.json'), 'utf8'));
    ok(isDeepStrictEqual(published, PROBLEM_SCHEMA), 'the embedded problem.json schema matches schema/problem.json');
    const publishedDiscovery = JSON.parse(readFileSync(join(here, 'schema/discovery.json'), 'utf8'));
    ok(isDeepStrictEqual(publishedDiscovery, DISCOVERY_SCHEMA), 'the embedded discovery.json schema matches schema/discovery.json');
    // The validator: the keywords of both schemas (allOf, if/then/else, const, not, oneOf, contains, $ref…).
    const S = { $defs: { n: { type: 'integer', minimum: 1 } }, type: 'object', properties: { a: { $ref: '#/$defs/n' }, k: { enum: ['x', 'y'] } },
      allOf: [{ if: { properties: { k: { const: 'x' } }, required: ['k'] }, then: { required: ['a'] }, else: { not: { required: ['a'] } } }],
      patternProperties: { '^x-': true }, additionalProperties: false };
    const v = (x) => schemaErrors(S, x).length;
    ok(v({ k: 'x', a: 2 }) === 0 && v({ k: 'x' }) === 1 && v({ k: 'y', a: 2 }) === 1 && v({ k: 'y' }) === 0 && v({ a: 0, k: 'x' }) === 1 && v({ 'x-a': 1, k: 'y' }) === 0 && v({ b: 1 }) === 1,
      'the validator handles $ref, allOf, if/then/else, const, not, patternProperties and additionalProperties');
    ok(schemaErrors({ oneOf: [{ type: 'string' }, { minLength: 2 }] }, 'ab').length === 1 && schemaErrors({ items: { type: 'string' }, contains: { const: 'p' }, uniqueItems: true }, ['p', 'q']).length === 0
      && schemaErrors({ contains: { const: 'p' } }, ['q']).length === 1 && schemaErrors({ uniqueItems: true }, [1, 1]).length === 1, 'and oneOf, contains and uniqueItems');
    ok(schemaErrors(PROBLEM_SCHEMA, { type: 'about:blank', title: 'x', status: 404, code: 'invalid', detail: 'x' }).length > 0
      && schemaErrors(PROBLEM_SCHEMA, { type: 'about:blank', title: 'x', status: 418, code: 'http_418', detail: 'x' }).length === 0, 'with problem.json: a code goes with its status (if/then)');
    // The specification is only in the website's repository; the mirror does not copy it.
    const specPath = join(here, '../../public/1/index.html');
    if (existsSync(specPath)) {
      const spec = readFileSync(specPath, 'utf8');
      const anchors = Object.keys(CHECKS).map((id) => sectionUrl(CHECKS[id][0], id).split('#')[1]);
      ok(anchors.every((a) => spec.includes(`id="${a}"`)), 'every check links to an anchor that exists in the specification');
    }
    ok(sectionUrl('5.1', 'cache-private').endsWith('#private-responses') && sectionUrl('5.1', 'cache-private.auth').endsWith('#private-responses'),
      'cache-private links to the private responses of 5.1, not to #resources');

    for (const mode of [null, OAUTH]) {
      const { code, report } = await run(SERVER, mode, dir);
      const list = report.groups.map((g) => `\n      ${g.level} ${g.check} ${g.method} ${g.route}: ${g.first.message}`).join('');
      ok(report.violations === 0 && report.warnings === 0 && code === 0,
        `reference server${mode ? ' with oauth' : ''}: ${report.exchanges} exchanges, ${report.violations} violations, ${report.warnings} warnings${list}`);
    }
  }

  let caught = 0, tried = 0;
  for (const [name, check, edits, mode] of MUTATIONS) {
    if (only && !name.includes(only)) continue;
    tried++;
    const { code, report } = await run(apply(SERVER, edits), mode, dir);
    const hit = report.groups.find((g) => g.check === check);
    const must = hit?.level === 'MUST';
    const good = hit && (must ? code === 1 : true);
    if (good) caught++;
    ok(good, `mutation "${name}" → ${check}${hit ? ` (${hit.count}×, ${hit.method} ${hit.route}: ${hit.first.message})` : `: not detected; triggered ${report.groups.map((g) => g.check).join(', ') || 'none'}`}`);
  }
  console.log(`${caught} of ${tried} mutations detected`);

  if (!only) {
    // --strict: the server that gives errors as application/json.
    const mutated = join(dir, 'strict-server.mjs');
    writeFileSync(mutated, apply(SERVER, MUTATIONS.find((m) => m[1] === 'error.media-type')[2]));
    const server = await start(process.execPath, [mutated], { PORT: String(SERVER_PORT) }, 'on http://');
    const proxy = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${SERVER_PORT}`, '--port', String(STRICT_PORT), '--strict', '--quiet'], {}, 'Summary at');
    try {
      const direct = await fetch(`http://127.0.0.1:${SERVER_PORT}/books?sort=-rating`);
      const via = await fetch(`http://127.0.0.1:${STRICT_PORT}/books?sort=-rating`);
      const [d1, d2] = [await direct.text(), await via.text()];
      ok(via.status === 200 && d1 === d2 && via.headers.get('etag') === direct.headers.get('etag') && via.headers.get('link') === direct.headers.get('link'),
        '--strict lets a correct response through unchanged');
      const bad = await fetch(`http://127.0.0.1:${STRICT_PORT}/books/999`);
      const body = await bad.json();
      ok(bad.status === 502 && bad.headers.get('content-type') === 'application/problem+json' && body.code === 'bad_gateway'
        && body.status === 502 && body.upstream_status === 404 && body.violations.some((v) => v.check === 'error.media-type'),
      `--strict replaces a breaking response with a 502 problem+json (${body.violations?.map((v) => v.check).join(', ')})`);
      const page = await fetch(`http://127.0.0.1:${STRICT_PORT}/_restep-proxy`);
      const html = await page.text();
      ok(page.status === 200 && html.includes('error.media-type') && html.includes('responses replaced'), 'GET /_restep-proxy gives the summary as HTML');
    } finally {
      const code = await stop(proxy);
      ok(code === 1, `on exit with violations, the proxy exits with 1 (exited with ${code})`);
      await stop(server);
    }

    // Forwarding: hop-by-hop, stream and gzip, with an auxiliary server.
    const aux = http.createServer((req, res) => {
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Hop-Res': '1', Connection: 'X-Hop-Res', 'X-Kept': '1', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ headers: req.headers }));
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.write('primero\n');
        return setTimeout(() => res.end('segundo\n'), 400);
      }
      if (req.url === '/en-curso') {
        res.writeHead(409, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ type: 'about:blank', title: 'Conflict', status: 409, code: 'request_in_progress', detail: 'Sigue en curso.' }));
      }
      // Draft 7 (5.4, 5.1): a closed table of codes, about:blank, no-store and fields for shared caches.
      const problem = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify({ title: 'x', status, detail: 'x', ...body })); };
      if (req.url === '/iana') return problem(431, { type: 'about:blank', code: 'request_header_fields_too_large' });
      if (req.url === '/blank') return problem(400, { type: 'about:blank', code: 'invalid_parameter', parameter: 'x' });
      if (req.url === '/no-store') return problem(429, { type: 'https://w3id.org/restep/1/errors#rate_limited', code: 'rate_limited' }, { 'Cache-Control': 'max-age=0', 'Retry-After': '1' });
      if (req.url === '/http-ok') return problem(418, { type: 'about:blank', code: 'http_418' });
      if (req.url === '/cdn') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private', 'CDN-Cache-Control': 'max-age=60' });
        return res.end('{}');
      }
      if (req.url === '/gz') {
        const body = zlib.gzipSync(JSON.stringify({ error: 'no existe' }));
        res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('no');
    }).listen(AUX_PORT, '127.0.0.1');
    await new Promise((r) => aux.once('listening', r));
    const reportFile = join(dir, 'aux.json');
    const fwd = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${AUX_PORT}`, '--port', String(PROXY_PORT), '--report', reportFile, '--quiet'], {}, 'Summary at');
    try {
      const echoed = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PROXY_PORT, path: '/echo', headers: { Connection: 'X-Hop-Req', 'X-Hop-Req': '1', 'X-Normal': '1', 'Keep-Alive': 'timeout=5' } }, (res) => {
          let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(t) }));
        });
        r.on('error', reject);
        r.end();
      });
      const h = echoed.body.headers;
      ok(!h['x-hop-req'] && !h['keep-alive'] && h['x-normal'] === '1' && h.host === `127.0.0.1:${AUX_PORT}`,
        'the request\'s hop-by-hop headers (also those named in Connection) do not get through; the others do');
      ok(!echoed.headers['x-hop-res'] && echoed.headers['x-kept'] === '1', 'the response\'s hop-by-hop headers do not reach the client; the others do');
      const t0 = Date.now();
      const s = await fetch(`http://127.0.0.1:${PROXY_PORT}/stream`);
      const reader = s.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const t1 = Date.now() - t0;
      let rest = '';
      for (let x; !(x = await reader.read()).done;) rest += new TextDecoder().decode(x.value);
      ok(first.startsWith('primero') && t1 < 300 && (first + rest).includes('segundo'), `the response is streamed (first chunk after ${t1} ms)`);
      const gz = await fetch(`http://127.0.0.1:${PROXY_PORT}/gz`);
      ok(gz.status === 404 && (await gz.json()).error === 'no existe', 'a gzip body is forwarded intact');
      await (await fetch(`http://127.0.0.1:${PROXY_PORT}/en-curso`, { method: 'POST' })).text();
      for (const path of ['/iana', '/blank', '/no-store', '/http-ok', '/cdn']) await (await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`)).text();
    } finally {
      await stop(fwd);
      aux.close();
    }
    const rep = JSON.parse(readFileSync(reportFile, 'utf8'));
    ok(rep.groups.some((g) => g.check === 'error.media-type' && g.route === '(other route)'), 'the gzip body is decompressed for analysis (error.media-type on /gz)');
    ok(rep.groups.some((g) => g.check === 'error.retry-after' && g.level === 'SHOULD' && /request_in_progress/.test(g.first.message)),
      'a 409 request_in_progress without Retry-After gives a warning (error.retry-after)');
    ok(!rep.groups.some((g) => g.check === 'error.code' && /request_in_progress/.test(g.first.message)), 'request_in_progress is a valid code for 409');
    // Groups go by check, method and route: every path of this server is "(other route)".
    const cases = (check, method) => rep.groups.filter((g) => g.check === check && g.first.request.startsWith(`${method} `)).reduce((n, g) => n + g.count, 0);
    ok(cases('error.code', 'GET') === 1, 'a name from the IANA registry for 431 is a violation; http_418 is not (error.code, 5.4)');
    ok(cases('error.about-blank', 'GET') === 2 && cases('error.about-blank', 'POST') === 1,
      'about:blank only for a problem with nothing beyond its status: not with request_in_progress, a parameter or an IANA name; yes with http_418 (5.4)');
    ok(cases('error.no-store', 'GET') === 1, 'a 429 without no-store is a violation (error.no-store, 5.4)');
    ok(cases('cache-private.shared', 'GET') === 1, 'a private response with CDN-Cache-Control is a violation (cache-private.shared, 5.1)');

    // Draft 7, with a discovery document of its own: partial notices, action responses, next and discovery.schema.
    const bumped = {}, memos = {};
    let notes = 0;
    const things = http.createServer((req, res) => {
      const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', Link: '<https://w3id.org/restep/1/>; rel="profile"', ...headers }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
      if (req.url === '/') return json(200, { restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions'], shared_cache: {},
        collections: { things: { path: '/things', sort: ['x'], deprecations: [{ kind: 'sort', name: 'x', announced: '2026-01-01T00:00:00Z' }], item_methods: ['GET', 'PATCH'],
          actions: { go: { on: 'collection', safe: false, idempotent: false }, peek: { on: 'item', safe: true, idempotent: true, method: 'GET', output: { type: 'object' } },
            look: { on: 'collection', safe: true, idempotent: true, method: 'GET' }, find: { on: 'collection', safe: true, idempotent: true, method: 'GET', params: { q: { type: 'string' } } },
            bump: { on: 'item', safe: false, idempotent: false }, sum: { on: 'collection', safe: true, idempotent: true, method: 'GET', params: { k: { type: 'integer', list: true } } } } },
        needs: { path: '/needs', filter: { isbn: { type: 'string', ops: ['eq'], required: true } } },
        // Council decisions of draft 7: an upload-only collection (2), instants (4), integer operands (3), null on lists (1).
        files: { path: '/files', methods: ['POST'], upload: { media_types: ['image/png'] } },
        notes: { path: '/notes', methods: ['POST'] },
        events: { path: '/events', methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH'], local_times: { meets_at: {} },
          filter: { at: { type: 'datetime', ops: ['eq'] }, n: { type: 'integer', ops: ['eq', 'in'] }, r: { type: 'number', ops: ['eq', 'lt', 'gt'] } } },
        lists: { path: '/lists', relations: { reviews: { to: 'things', many: true } }, filter: { formats: { type: 'string', ops: ['null'] }, reviews: { type: 'string', ops: ['null'] },
          'reviews.id': { type: 'string', ops: ['null'], quantifier: 'some' }, tags: { type: 'string', ops: ['in', 'null'], quantifier: 'some' } } },
        tagged: { path: '/tagged', filter: { tags: { type: 'string', ops: ['in', 'null'], quantifier: 'some' } } },
        // Council, round 3: upload without create (1), upload with create whose media_types admit JSON (2), a JSON file without create.
        photos: { path: '/photos', methods: ['POST'], upload: { media_types: ['image/png'] } },
        mixed: { path: '/mixed', methods: ['POST'], upload: { media_types: ['application/json'], multipart: true }, schemas: { create: { type: 'object' } } },
        jsonfiles: { path: '/jsonfiles', methods: ['POST'], upload: { media_types: ['application/*'] } },
        // Council, round 4: JSON through */* (1a), +json files (1b), multipart without "multipart": true (2), a file
        // part without filename (4b), several filters with null on a list (5b).
        anyfiles: { path: '/anyfiles', methods: ['POST'], upload: { media_types: ['*/*'] } },
        ld: { path: '/ld', methods: ['POST'], upload: { media_types: ['application/ld+json'] }, schemas: { create: { type: 'object' } } },
        multi: { path: '/multi', methods: ['POST'], upload: { media_types: ['image/*'], multipart: true } },
        labels: { path: '/labels', filter: { tags: { type: 'string', ops: ['in', 'prefix', 'null'], quantifier: 'some' } } },
        memos: { path: '/memos', methods: ['POST'] } } });
      const ev = (extra) => ({ id: 'e1', at: '2026-12-31T23:59:59Z', n: 21, formats: ['pdf'], reviews: [{ id: '1' }], _etag: '"e"', ...extra });
      if (req.url === '/events' && req.method === 'POST') {
        let body = ''; req.on('data', (b) => (body += b));
        const invalid = (errors) => res.writeHead(422, { 'Content-Type': 'application/problem+json' }).end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#invalid', title: 'x', status: 422, code: 'invalid', detail: 'x', errors }));
        return req.on('end', () => {
          const b = JSON.parse(body);
          if (b.n === 1) return json(201, { ...ev(), at: '2026-12-31T23:59:59Z' }, { Location: '/events/e1' });
          // 3 (council, decision 10): a surrogate in a member name is reported at "", not at the member.
          if (b.n === 3) return invalid([{ pointer: `/${Object.keys(b).find((k) => k !== 'n')}`, code: 'format' }]);
          if (b.n === 4) return invalid([{ pointer: '', code: 'format' }]);
          if (b.n === 5) return invalid([{ pointer: '/text', code: 'format' }]);
          invalid([{ pointer: '/at', code: 'range' }]);
        });
      }
      // 3 (council, decision 3): a PATCH with :60 in a datetime (accepted) and in a localdatetime (422 without format).
      if (req.url === '/events/e1' && req.method === 'PATCH') {
        let body = ''; req.on('data', (b) => (body += b));
        return req.on('end', () => (JSON.parse(body).at ? json(200, ev(), { ETag: '"e"' })
          : res.writeHead(422, { 'Content-Type': 'application/problem+json' }).end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#invalid', title: 'x', status: 422, code: 'invalid', detail: 'x', errors: [{ pointer: '/meets_at', code: 'range' }] }))));
      }
      if (req.url === '/events/e1') return json(200, ev({ meets_at: '2027-03-30T19:00:60' }), { ETag: '"e"' });
      // 6.1 and 11.1 (council, decision 7): integer and number operands follow the number grammar of RFC 8259.
      const invalidParameter = (parameter) => { res.writeHead(400, { 'Content-Type': 'application/problem+json' }); res.end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#invalid_parameter', title: 'x', status: 400, code: 'invalid_parameter', detail: 'x', parameter })); };
      if (req.url === '/events?filter[n]=2e1') return invalidParameter('filter[n]');
      // 6.1 (council, round 4, decision 6): operands outside the range of a double.
      if (req.url === '/events?filter[n]=1e400') return invalidParameter('filter[n]');
      if (req.url === '/events?filter[r]=1e999') { res.writeHead(500, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#internal', title: 'x', status: 500, code: 'internal', detail: 'x' })); }
      if (req.url === '/events?filter[r]=1e-400') return json(200, { items: [ev({ r: 0 })], next: null });
      if (req.url === '/events?filter[r][lt]=-1e400') return json(200, { items: [ev({ r: -5 })], next: null });
      if (req.url === '/events?filter[r][lt]=1e400') return json(200, { items: [ev({ id: 'e9', r: -5 })], next: null });
      if (req.url === '/events?filter[r][gt]=1e400') return json(200, { items: [], next: null });
      // 6.1 (council, round 4, decision 5a): two null filters on the same group.
      if (req.url === '/lists?filter[reviews][null]=true&filter[reviews.id][null]=true') return json(200, { items: [], next: null });
      if (req.url === '/lists?filter[reviews][null]=false&filter[reviews.id][null]=false') return invalidParameter('filter[reviews.id][null]');
      if (req.url === '/lists?filter[reviews][null]=true&filter[tags][null]=true') return json(200, { items: [], next: null });
      // 6.1 (council, round 4, decision 5b): no element matches all the other filters at once.
      if (req.url === '/labels?filter[tags][null]=true&filter[tags][in]=a,b&filter[tags][prefix]=b')
        return json(200, { items: [ev({ id: 'h1', tags: ['a', 'bx'] }), ev({ id: 'h2', tags: ['b'] })], next: null });
      // 5.1 (council, round 4).
      if (req.url === '/anyfiles' || req.url === '/ld' || req.url === '/multi') {
        let body = ''; req.on('data', (b) => (body += b));
        const ct = String(req.headers['content-type']);
        return req.on('end', () => {
          if (req.url === '/multi' && !/filename=/.test(body) && !body.includes('keep')) { res.writeHead(400, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#bad_request', title: 'x', status: 400, code: 'bad_request', detail: 'filename' })); }
          const file = req.url !== '/ld' || body.includes('file');
          json(201, { id: 'a1', _etag: '"a"', ...(file && { _content: { href: '/f/a1', media_type: ct.split(';')[0], size: body.length } }) }, { Location: `${req.url}/a1` });
        });
      }
      if (req.url === '/events?filter[n]=0x14') return invalidParameter('filter[n]');
      if ((req.url.startsWith('/events?filter[n]=') && !req.url.endsWith('=20.0')) || req.url.startsWith('/events?filter[n][in]=') || req.url.startsWith('/events?filter[r]=')) return json(200, { items: [], next: null });
      if (req.url.startsWith('/things:sum')) return json(200, {});
      // 6.1 (council, decision 9): null with quantifier tests the whole list.
      if (req.url === '/tagged?filter[tags][null]=true&filter[tags][in]=a') return json(200, { items: [ev({ id: 'g1', tags: ['b'] }), ev({ id: 'g2', tags: ['a', 'b'] })], next: null });
      if (req.url === '/tagged?filter[tags][null]=false&filter[tags][in]=a') return json(200, { items: [ev({ id: 'g3', tags: ['a'] }), ev({ id: 'g4', tags: ['b'] })], next: null });
      if (req.url === '/lists?filter[tags][null]=true') return json(200, { items: [ev({ id: 'g5', tags: [] }), ev({ id: 'g6' }), ev({ id: 'g7', tags: ['c'] })], next: null });
      // 5.1 (council, decisions 1 and 2).
      if (req.url === '/photos') return json(201, { id: 'p1', _etag: '"p"' }, { Location: '/photos/p1' });
      if (req.url === '/mixed' || req.url === '/jsonfiles') {
        let body = ''; req.on('data', (b) => (body += b));
        return req.on('end', () => json(201, { id: 'm1', _etag: '"m"', ...(JSON.parse(body).file && { _content: { href: '/f/m1', media_type: 'application/json', size: 2 } }) }, { Location: `${req.url}/m1` }));
      }
      // 7.3 (council, decision 5): a replayed 201 without a body carries no ETag.
      if (req.url === '/memos') {
        const key = req.headers['idempotency-key'], again = (memos[key] = (memos[key] ?? 0) + 1) > 1;
        res.writeHead(201, { Link: '<https://w3id.org/restep/1/>; rel="profile"', Location: `/memos/${key.replace(/"/g, '')}`, 'Preference-Applied': 'return=minimal',
          ...(again ? { 'Idempotent-Replayed': 'true' } : {}), ...(!again || key === '"m-1"' ? { ETag: '"memo"' } : {}) });
        return res.end();
      }
      // 7.2 (council, decision 6): /things/6 requires If-Match; If-None-Match with a list of tags does not meet it.
      if (req.url === '/things/6' && req.method === 'PATCH') {
        if (!req.headers['if-match'] && !req.headers['if-none-match']) { res.writeHead(428, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#precondition_required', title: 'x', status: 428, code: 'precondition_required', detail: 'x' })); }
        return json(200, { id: '6', _etag: '"6b"' }, { ETag: '"6b"' });
      }
      if (req.url === '/events') return json(200, { items: [ev()], next: null });
      if (req.url === '/events?filter[n]=20.0') return json(200, { items: [ev()], next: null });
      if (req.url === '/lists?filter[formats][null]=true') return json(200, { items: [ev({ id: 'e2', formats: [], reviews: [] }), ev({ id: 'e3' })], next: null });
      if (req.url === '/lists?filter[reviews][null]=false') return json(200, { items: [ev()], next: null });
      if (req.url === '/events?filter[at]=2026-12-31T23:59:59Z') return json(200, { items: [ev({ at: '2026-12-31T23:59:60Z' })], next: null });
      if (req.url === '/files') { res.writeHead(415, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ type: 'https://w3id.org/restep/1/errors#unsupported_media_type', title: 'x', status: 415, code: 'unsupported_media_type', detail: 'x' })); }
      if (req.url.startsWith('/things:look') || req.url.startsWith('/things:find')) return json(200, {});
      // 7.1 and 7.2: an item action changes the item (ETag "<n>b"); a PATCH may follow ("<n>c"); then the replay.
      // 2: the stored body with its old validators. 3: the stored body, nothing written in between.
      // 4: the current representation. 5: a body that is neither.
      const thing = /^\/things\/([2-5])(:bump)?$/.exec(req.url);
      if (thing) {
        const [, n, bump] = thing, tag = (x) => `"${n}${x}"`;
        if (!bump && req.method === 'GET') return json(200, { id: n, _etag: tag('a') }, { ETag: tag('a') });
        if (!bump && req.method === 'PATCH') return json(200, { id: n, _etag: tag('c') }, { ETag: tag('c') });
        const replay = (bumped[n] = (bumped[n] ?? 0) + 1) > 1, again = replay ? { 'Idempotent-Replayed': 'true' } : {};
        if (replay && n === '4') return json(200, { id: n, title: 'now', _etag: tag('c') }, { 'Content-Location': `/things/${n}`, ETag: tag('c'), ...again });
        if (replay && n === '5') return json(200, { id: n, other: 1 }, again);
        return json(200, { id: n, _etag: tag('b') }, { 'Content-Location': `/things/${n}`, ETag: tag('b'), ...again });
      }
      // 7.1: a replay of a 201 keeps its Location.
      if (req.url === '/notes') return json(201, { id: 'n1', _etag: '"n"' }, { Location: `/notes/${notes++ ? 'n2' : 'n1'}`, ...(notes > 1 && { 'Idempotent-Replayed': 'true' }) });
      if (req.url === '/needs') return json(200, { items: [], next: null });
      if (req.url === '/things?sort=x') return json(200, { items: [], next: null }, { Deprecation: '@1767225600', Link: '<https://w3id.org/restep/1/>; rel="profile", </why>; rel="deprecation"' });
      if (req.url === '/things:go') return json(200, {});
      if (req.url === '/things/1:peek') return json(200, { _etag: '"a"' });
      if (req.url === '/things?limit=1') return json(200, { items: [{ id: '1' }], next: '/things?limit=1&filter[x]=1&cursor=a' });
      json(404, undefined);
    }).listen(THINGS_PORT, '127.0.0.1');
    await new Promise((r) => things.once('listening', r));
    const thingsReport = join(dir, 'things.json');
    const watch = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${THINGS_PORT}`, '--port', String(PROXY_PORT), '--report', thingsReport, '--quiet'], {}, 'Summary at');
    try {
      const T = `http://127.0.0.1:${PROXY_PORT}`;
      await (await fetch(`${T}/`)).text();
      await (await fetch(`${T}/things?sort=x`)).text();
      await (await fetch(`${T}/things:go`, { method: 'POST' })).text();
      await (await fetch(`${T}/things/1:peek`)).text();
      await (await fetch(`${T}/things?limit=1`)).text();
      await (await fetch(`${T}/needs`)).text();
      const send = async (path, init) => (await fetch(`${T}${path}`, init)).text();
      await send('/things:look?verbose=1'); await send('/things:find?q=a&z=2'); await send('/things:find?q=a');
      await send('/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      for (const q of ['', '?filter[n]=20.0', '?filter[at]=2026-12-31T23:59:59Z']) await send(`/events${q}`);
      for (const q of ['?filter[formats][null]=true', '?filter[reviews][null]=false']) await send(`/lists${q}`);
      const json = { 'content-type': 'application/json' };
      await send('/events', { method: 'POST', headers: json, body: JSON.stringify({ n: 1, at: '2026-12-31T23:59:60Z' }) });
      await send('/events', { method: 'POST', headers: json, body: JSON.stringify({ n: 2, at: '2026-12-31T23:59:60Z' }) });
      for (const n of ['2', '3', '4', '5']) {
        const key = { ...json, 'idempotency-key': `"bump-${n}"` };
        await send(`/things/${n}`);
        await send(`/things/${n}:bump`, { method: 'POST', headers: key, body: '{}' });
        if (n !== '3') await send(`/things/${n}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': `"${n}b"` }, body: '{}' });
        await send(`/things/${n}:bump`, { method: 'POST', headers: key, body: '{}' });
      }
      for (let i = 0; i < 2; i++) await send('/notes', { method: 'POST', headers: { ...json, 'idempotency-key': '"note-1"' }, body: '{}' });
      // Council, round 3.
      const patch = { 'content-type': 'application/merge-patch+json' };
      await send('/events/e1');
      await send('/events/e1', { method: 'PATCH', headers: { ...patch, 'if-match': '"e"' }, body: JSON.stringify({ at: '2026-12-31T23:59:60Z' }) });
      await send('/events/e1', { method: 'PATCH', headers: { ...patch, 'if-match': '"e"' }, body: JSON.stringify({ meets_at: '2027-03-30T19:00:60' }) });
      for (const q of ['?filter[n]=020', '?filter[n]=+20', '?filter[n]=2e1', '?filter[n]=0x14', '?filter[n]=20', '?filter[n][in]=20,.5', '?filter[n][in]=2e1,20.0', '?filter[r]=.5', '?filter[r]=2.5e-1'])
        await send(`/events${q.replace('+', '%2B')}`);
      for (const q of ['?k=1,020', '?k=2e1,3']) await send(`/things:sum${q}`);
      for (const q of ['?filter[tags][null]=true&filter[tags][in]=a', '?filter[tags][null]=false&filter[tags][in]=a']) await send(`/tagged${q}`);
      await send('/lists?filter[tags][null]=true');
      await send('/photos', { method: 'POST', headers: json, body: '{}' });
      await send('/mixed', { method: 'POST', headers: json, body: JSON.stringify({ file: 1 }) });
      await send('/mixed', { method: 'POST', headers: json, body: '{}' });
      await send('/jsonfiles', { method: 'POST', headers: json, body: JSON.stringify({ file: 1 }) });
      // Council, round 4.
      await send('/anyfiles', { method: 'POST', headers: json, body: '{"a":1}' });
      await send('/ld', { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: '{"@id":"x"}' });
      await send('/ld', { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: '{"file":1}' });
      const form = (part) => ({ method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=XyZ' },
        body: `--XyZ\r\nContent-Disposition: form-data; ${part}\r\nContent-Type: image/png\r\n\r\nPNG\r\n--XyZ--\r\n` });
      await send('/anyfiles', form('name="file"; filename="a.png"'));
      await send('/multi', form('name="file"'));
      await send('/multi', form('name="file"; filename="a.png"'));
      await send('/multi', form('name="keep"'));
      for (const q of ['?filter[n]=1e400', '?filter[r]=1e999', '?filter[r]=1e-400', '?filter[r][lt]=-1e400', '?filter[r][lt]=1e400', '?filter[r][gt]=1e400']) await send(`/events${q}`);
      for (const q of ['?filter[reviews][null]=true&filter[reviews.id][null]=true', '?filter[reviews][null]=false&filter[reviews.id][null]=false', '?filter[reviews][null]=true&filter[tags][null]=true'])
        await send(`/lists${q}`);
      await send('/labels?filter[tags][null]=true&filter[tags][in]=a,b&filter[tags][prefix]=b');
      for (const k of ['"m-1"', '"m-2"']) for (let i = 0; i < 2; i++) await send('/memos', { method: 'POST', headers: { ...json, prefer: 'return=minimal', 'idempotency-key': k }, body: '{}' });
      await send('/things/6', { method: 'PATCH', headers: patch, body: '{}' });
      await send('/things/6', { method: 'PATCH', headers: { ...patch, 'if-none-match': '"x", "y"' }, body: '{}' });
      await send('/things/6', { method: 'PATCH', headers: { ...patch, 'if-match': '"6b"' }, body: '{}' });
      for (const n of [3, 4]) await send('/events', { method: 'POST', headers: json, body: JSON.stringify({ n, 'a\ud800': 'x' }) });
      await send('/events', { method: 'POST', headers: json, body: JSON.stringify({ n: 5, text: 'a\ud800' }) });
    } finally {
      await stop(watch);
      things.close();
    }
    const tr = JSON.parse(readFileSync(thingsReport, 'utf8'));
    const said = (check, re) => tr.groups.some((g) => g.check === check && (re.test(g.first.message) || re.test(g.last.message)));
    ok(said('discovery.schema', /shared_cache/), 'a draft 7 discovery document that does not fit discovery.json is a violation (discovery.schema, 4.2)');
    ok(said('deprecation', /part of a resource/), 'Deprecation on a response that only uses a partial notice (sort) is a violation (5.5)');
    ok(said('actions.response', /unsafe collection action, got 200/), 'an unsafe collection action that answers 200 is a violation (11.1)');
    ok(said('actions.response', /declares output and its result carries _etag/), 'a result with output that carries _etag is a violation (11.1)');
    ok(said('links', /\[ or \] unencoded/), 'a next with [ and ] unencoded in its query is a violation (5.2)');
    ok(said('query.required', /filter\[isbn\]/), 'a list request without a required filter that succeeds is a violation (6.1)');
    // Council decisions of draft 7.
    const count = (check) => tr.groups.filter((g) => g.check === check).reduce((n, g) => n + g.count, 0);
    ok(said('actions.params', /look declares no params .* verbose/) && said('actions.params', /does not declare z in params/) && count('actions.params') === 2,
      'a GET action that accepts a parameter it does not declare, also one without params, is a violation; a declared one is not (decision 6, 11.1)');
    ok(tr.groups.some((g) => g.check === 'media-type.accept-post' && g.level === 'SHOULD'), 'a 415 to a JSON body from an upload-only collection without Accept-Post is a warning (decision 2, 5.1)');
    ok(said('filter.match', /filter\[n\]=20\.0 and the item e1 has n = 21/), 'filter[n]=20.0 on an integer field is a valid operand, the same as 20 (decision 3, 6.1)');
    ok(said('filter.match', /filter\[formats\]\[null\]=true and the item e3/) && !said('filter.match', /e2|reviews/),
      'null on a list field or a to-many relationship: an empty list is null (decision 1, 6.1)');
    ok(!tr.groups.some((g) => g.check === 'item.discovery'), 'a list field and a to-many relationship declared with type string and only null fit their items (decision 1, 6.1)');
    ok(said('leap-second', /writes at = "2026-12-31T23:59:60Z"/) && !tr.groups.some((g) => g.check === 'leap-second' && g.method === 'POST'),
      'a response with :60 is a violation; a POST with :60, accepted or rejected, is not judged: the field may be one only the server sets, which it ignores (council 3/4, 3 and 5.1)');
    const leapPatch = tr.groups.find((g) => g.check === 'leap-second' && g.method === 'PATCH');
    ok(leapPatch?.count === 2 && said('leap-second', /writes meets_at = "2027-03-30T19:00:60"/),
      'a PATCH with :60 in a datetime accepted, or in a localdatetime rejected without a format entry, and a localdatetime written with :60, are violations (council 3/3, 3)');
    const operands = tr.groups.filter((g) => g.check === 'query.operand').flatMap((g) => [g.first.message]);
    ok(count('query.operand') === 7 && said('query.operand', /filter\[n\]=020 is not a valid integer operand/)
      && said('query.operand', /k=1,020 is not a valid integer parameter/),
      `020, +20, .5 (also inside in) accepted and 2e1 rejected are violations; 0x14 rejected, 20, 2e1,20.0 and 2.5e-1 accepted, and k=2e1,3 are not (council 3/7, 6.1, 11.1): ${count('query.operand')} ${JSON.stringify(operands)}`);
    ok(said('filter.match', /filter\[tags\]\[null\]=true with filter\[tags\]\[in\]=a and the item g2/) && said('filter.match', /filter\[tags\]\[null\]=false with filter\[tags\]\[in\]=a and the item g4/)
      && said('filter.match', /filter\[tags\]\[null\]=true and the item g7/) && !said('filter.match', /item g[13568]/),
      'null with quantifier tests the whole list: alone, empty or absent; with in, true when no element matches and false when some does (council 3/9, 6.1)');
    ok(said('upload.json', /photos|without schemas.create.*got 201; expected 415/) && said('upload.json', /stored a file/) && tr.groups.filter((g) => g.check === 'upload.json' && !/ld\+json/.test(g.first.message)).reduce((n, g) => n + g.count, 0) === 2,
      'a JSON POST accepted by an upload-only collection, or stored as a file by one that creates from JSON, is a violation; a JSON file without create is not (council 3/1 and 3/2, 5.1)');
    // Council, round 4.
    ok(!said('upload.json', /anyfiles/) && said('upload.json', /application\/ld\+json, which media_types admits, created an item without _content/) && count('upload.json') === 3,
      'a JSON file to an upload-only collection with */* is not a violation (1a); a +json body that creates an item without _content is (1b, 5.1)');
    ok(said('upload.multipart', /does not declare "multipart": true got 201; expected 415, even though media_types admits it/) && count('upload.multipart') === 1,
      'a multipart/form-data POST accepted by a collection without "multipart": true is a violation, even when media_types admits it (council 4/2, 5.1)');
    ok(said('upload.filename', /image\/png without filename got 400 bad_request/) && count('upload.filename') === 1,
      'a 400 to a file part without filename is a violation; a part named otherwise is not (council 4/4b, 5.1)');
    ok(said('query.operand', /filter\[r\]=1e999 is a valid number operand outside the range of a double and got 500/) && !said('query.operand', /1e400/),
      'a 500 to a valid operand outside the range of a double is a violation; invalid_parameter to one is not (council 4/6, 5.3, 6.1)');
    // Groups keep the first and the last message: on /events, 20.0 and the leap second (above), then 1e-400 and -1e400, and nothing more.
    const eventsMatch = tr.groups.find((g) => g.check === 'filter.match' && /filter\[n\]=20\.0/.test(g.first.message));
    ok(eventsMatch?.count === 4 && /filter\[r\]\[lt\]=-1e400 and the item e1 has r = -5: an operand outside the range/.test(eventsMatch.last.message) && !said('filter.match', /item e9/),
      `an operand outside the range of a double that matches as zero (1e-400) or an infinity (-1e400) is a violation; compared exactly (lt 1e400, gt 1e400), it is not (council 4/6, 6.1)`);
    ok(said('query.null-once', /filter\[reviews\]\[null\]=true and filter\[reviews\.id\]\[null\]=true: two null filters on the group reviews got 200/) && count('query.null-once') === 1,
      'two null filters on the same group accepted is a violation; rejected with invalid_parameter, or on two groups, is not (council 4/5a, 6.1)');
    ok(said('filter.match', /filter\[tags\]\[null\]=true with filter\[tags\]\[in\]=a,b and filter\[tags\]\[prefix\]=b and the item h2.*all the other filters at once/) && !said('filter.match', /item h1/),
      'null=true with several filters of the group: no element matches all of them at once (council 4/5b, 6.1)');
    ok(said('idempotency.replay-validators', /replay of a 201 without a body carries ETag "memo"/) && !tr.groups.some((g) => g.check === 'minimal.etag'),
      'a replayed 201 without a body that carries ETag is a violation; one without ETag is not a minimal.etag violation (council 3/5, 7.3)');
    ok(said('precondition', /If-None-Match: "x", "y" and no If-Match; expected 428/) && count('precondition') === 1,
      'If-None-Match with a list of tags accepted where If-Match is required is a violation (council 3/6, 7.2)');
    ok(said('i-json', /points at "\/a\\ud800"/) && count('i-json') === 1,
      'a format entry that points at a member whose name holds a surrogate is a violation; one at "" or at the string is not (council 3/10, 3)');
    ok(said('idempotency.replay-validators', /carries Content-Location, ETag, _etag with "2b", and the item's current ETag is "2c"/)
      && tr.groups.filter((g) => g.check === 'idempotency.replay-validators' && g.first.request.includes('/things/')).reduce((n, g) => n + g.count, 0) === 1,
      'a replayed 200 to an action, after another write, with Content-Location, ETag and _etag is a violation; the original is not (decision 12, 7.1)');
    // 7.1: a replay returns the stored body or the item's current representation, with the same status and Location.
    const replays = (route) => tr.groups.filter((g) => g.check === 'idempotency.replay' && g.first.request.startsWith(`POST ${route}`));
    const bumps = replays('/things/');
    ok(bumps.length === 1 && bumps[0].count === 1 && /neither the first one nor the item's current representation/.test(bumps[0].first.message) && bumps[0].first.request.includes('/things/5:bump'),
      'a replay with the stored body (with or without a write in between) or with the current representation passes; a body that is neither is a violation (7.1)',
      JSON.stringify(bumps.map((g) => [g.count, g.first.request, g.first.message])));
    ok(replays('/notes').some((g) => /Location: \/notes\/n2; the first one, \/notes\/n1/.test(g.first.message)), 'a replay with another Location is a violation (7.1)');
    // Discovery documents with the decisions of the council (1 and 8) fit discovery.json.
    const base = { restep: '1.0-draft.7', profiles: ['core', 'query'] };
    const withFilter = { ...base, collections: { books: { path: '/books', relations: { reviews: { to: 'reviews', many: true } }, filter: { reviews: { type: 'string', ops: ['null'] }, formats: { type: 'string', ops: ['null'] } } },
      reviews: { path: '/reviews' } } };
    ok(schemaErrors(DISCOVERY_SCHEMA, withFilter).length === 0, `null as the only operator, without quantifier, fits discovery.json (decision 1): ${schemaErrors(DISCOVERY_SCHEMA, withFilter).slice(0, 2).join('; ')}`);
    const shop = (effects) => ({ ...base, profiles: ['core', 'writes'], singletons: { shop: { path: '/shop', methods: ['GET', 'PATCH'], method_effects: effects } } });
    ok(schemaErrors(DISCOVERY_SCHEMA, shop({ PATCH: [] })).length === 0 && schemaErrors(DISCOVERY_SCHEMA, shop({ DELETE: [] })).length > 0,
      'a singleton declares method_effects with PATCH as its only key (decision 8, 5.9)');
    const mixed = (upload) => ({ ...base, profiles: ['core', 'writes'], collections: { files: { path: '/files', upload, schemas: { create: { type: 'object' } } } } });
    ok(schemaErrors(DISCOVERY_SCHEMA, mixed({ media_types: ['application/*'] })).length > 0 && schemaErrors(DISCOVERY_SCHEMA, mixed({ media_types: ['application/*'], multipart: true })).length === 0
      && schemaErrors(DISCOVERY_SCHEMA, mixed({ media_types: ['image/*'] })).length === 0,
      'a collection with upload and create whose media_types admit JSON declares "multipart": true, or discovery.schema fails (council 3/2, 5.1)');
    const media = (m) => ({ ...base, profiles: ['core', 'writes'], collections: { files: { path: '/files', methods: ['POST'], upload: { media_types: [m] } } } });
    ok(schemaErrors(DISCOVERY_SCHEMA, media('*/*')).length === 0 && schemaErrors(DISCOVERY_SCHEMA, media('*/png')).length > 0
      && schemaErrors(DISCOVERY_SCHEMA, mixed({ media_types: ['*/*'] })).length > 0,
      '*/* is a media range; */png is not; with create, */* admits JSON and asks for "multipart": true (council 4/2 and 4/1a, 5.1)');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests pass');
process.exit(failures ? 1 : 0);
