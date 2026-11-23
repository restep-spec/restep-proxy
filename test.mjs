// Pruebas de restep-proxy:
//  1. El esquema de errores incrustado coincide con schema/problem.json.
//  2. Delante del servidor de referencia, con tráfico variado: 0 violaciones y 0 avisos.
//  3. Delante de copias mutadas del servidor (en un directorio temporal): cada mutación hace saltar
//     la comprobación que la cubre.
//  4. --strict sustituye por un 502 problem+json la respuesta que incumple y deja pasar las demás
//     byte a byte.
//  5. Reenvío: cabeceras hop-by-hop, respuesta en flujo y cuerpo comprimido.
//   node tools/restep-proxy/test.mjs            (desde projects/restep)
//   node tools/restep-proxy/test.mjs cursor     (solo las mutaciones cuyo nombre contiene «cursor»)
// Puertos: 8870 (proxy), 8871 (servidor), 8872 (servidor auxiliar), 8873 (proxy estricto).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { PROBLEM_SCHEMA, CHECKS, sectionUrl } from './restep-proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, 'vendor/restep-server.mjs'), 'utf8');
const PROXY = join(here, 'restep-proxy.mjs');
const PROXY_PORT = 8870, SERVER_PORT = 8871, AUX_PORT = 8872, STRICT_PORT = 8873;
const TOKEN = 'restep-proxy-test';
const OAUTH = 'oauth';
const only = process.argv[2];

// [nombre, comprobación que debe saltar, [[texto del servidor, reemplazo], ...], modo]
const MUTATIONS = [
  ['next ausente al final', 'collection.shape',
    [[' next,\n    ...(count', ' ...(next && { next }),\n    ...(count']]],
  ['colección sin _etag', 'etag.collection', [['_etag: etag(r) })), next,', '})), next,']]],
  ['errores como application/json', 'error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['status distinto en el cuerpo', 'error.status',
    [["title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,", "title: text(TITLES[p.status] ?? 'Error', lang), status: 400,"]]],
  ['404 con otro código', 'error.code',
    [['code: p.code, detail: text(p.detail, lang),', "code: p.status === 404 ? 'missing' : p.code, detail: text(p.detail, lang),"]]],
  ['entrada de errors sin code', 'error.schema',
    [["if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), code: 'required', detail:", 'if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), detail:']]],
  ['405 sin Allow', 'error.405',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, {}"]]],
  ['Allow distinto de lo declarado', 'allow',
    [["`Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') }", "`Admite ${methods.join(', ')}.`), {}, { Allow: 'GET, HEAD' }"]]],
  ['unsupported_parameter sin parameter', 'error.parameter',
    [["new Problem(400, 'unsupported_parameter', detail, { parameter });", "new Problem(400, 'unsupported_parameter', detail, {});"]]],
  ['cuerpo que no es JSON', 'json',
    [["const body = data === undefined ? '' : JSON.stringify(data);", "const body = data === undefined ? '' : JSON.stringify(data) + (status === 404 ? '}' : '');"]]],
  ['parámetro reservado ignorado', 'reserved',
    [['if (!allowed.includes(base)) throw unsupported(key);', 'if (!allowed.includes(base)) continue;']]],
  ['sin cabecera de perfil', 'profile-link',
    [['res.writeHead(status, { Link: link,', 'res.writeHead(status, {']]],
  ['errores sin Cache-Control', 'cache-control',
    [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]]],
  ['status sin no-store', 'health',
    [["res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });",
      "res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'max-age=60' });"]]],
  ['POST da 200', 'status.success', [['const response = [201,', 'const response = [200,']]],
  ['201 sin Location', 'location', [['{ Location: location(row), ETag: etag(row),', '{ ETag: etag(row),']]],
  ['POST con id aceptado', 'id.assigned', [["if (from === 'server') return [{ pointer: '/id', code: 'read_only'", "if (false) return [{ pointer: '/id', code: 'read_only'"]]],
  ['PATCH con otro id aceptado', 'id.assigned', [["if ('id' in patch && patch.id !== id) throw invalid(", 'if (false) throw invalid(']]],
  ['parche que es una lista aceptado', 'patch.object',
    [['if (isObject(v)) { // members', 'if (isObject(v) || Array.isArray(v)) { // members']]],
  ['precio como número', 'item.discovery', [["price: '18.50', rating: 4.6", 'price: 18.5, rating: 4.6']]],
  // La referencia retira el orden por year (5.5) y manda Deprecation al usarlo: la mutación deja de mandarlo.
  ['retirada sin Deprecation', 'deprecation',
    [['return used.length ? { Deprecation: epoch(used[0].announced),', 'return false ? { Deprecation: epoch(used[0].announced),']]],
  ['retirada sin Link rel="deprecation"', 'deprecation',
    [['Link: `${link}, <${SPEC}#versions>; rel="deprecation"` } : {};', 'Link: link } : {};']]],
  ['limit recortado en silencio', 'limit',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['next pierde los parámetros', 'next', [['const q = new URLSearchParams(params);', 'const q = new URLSearchParams();']]],
  ['next relativo', 'links', [['next = `${path}?${q}`;', 'next = `${path.slice(1)}?${q}`;']]],
  ['ge devuelve ausentes', 'filter.match',
    [['items = items.filter((r) => at(r, field, coll) != null && OPS[op](compare(type, at(r, field, coll), v, collation)));',
      "items = items.filter((r) => (at(r, field, coll) == null && op === 'ge') || (at(r, field, coll) != null && OPS[op](compare(type, at(r, field, coll), v, collation))));"]]],
  ['eq no filtra', 'filter.match', [['eq: (c) => c === 0,', 'eq: () => true,']]],
  ['ausentes primero al ordenar', 'sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['fields ignorado', 'fields', [['  if (!fields) return row;', '  return row;']]],
  ['count sin total', 'count', [["...(count === 'true' && { total: items.length }),", '']]],
  ['filtro declarado rechazado', 'query.declared-rejected',
    [['if (!Object.hasOwn(coll.filter, field)) throw unsupported(key);', "if (!Object.hasOwn(coll.filter, field) || field === 'year') throw unsupported(key);"]]],
  ['filtro no declarado aceptado', 'query.undeclared',
    [['if (!Object.hasOwn(coll.filter, field)) throw unsupported(key);', 'if (!Object.hasOwn(coll.filter, field)) continue;']]],
  ['filtro con nombre rechazado', 'query.declared-rejected',
    [["if (named) { // 6.1", "if (named && field === 'featured') throw unsupported(key);\n    if (named) { // 6.1"]]],
  ['operador en filtro con nombre aceptado', 'query.undeclared',
    [["if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));",
      'if (m[2] !== undefined) { items = items.filter((r) => named.apply(r)); continue; }']]],
  ['interruptor con valor aceptado', 'query.named-value',
    [["if (!named.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));", '']]],
  ['ETag débil', 'etag', [['const etag = (value) => `"${hash(JSON.stringify(value))}"`;', 'const etag = (value) => `W/"${hash(JSON.stringify(value))}"`;']]],
  ['fields sin _etag', 'etag', [['data = fields || included.length ? { ...pick(expand(row, coll, included), fields), _etag: etag(row) } : withEtag(row);',
    'data = fields || included.length ? pick(expand(row, coll, included), fields) : withEtag(row);']]],
  ['If-Match ignorado', 'if-match', [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (false)']]],
  ['412 sin cabecera condicional', 'precondition',
    [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (ifMatch === undefined || !strongMatch(ifMatch, etag(current)))']]],
  ['If-None-Match ignorado en GET', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);", '']]],
  ['If-None-Match ignorado en escritura', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], etag(current)))\n    throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.'",
      "if (false)\n    throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.'"]]],
  ['Idempotency-Key mal formada aceptada', 'idempotency.key',
    [["if (!m) throw new Problem(400, 'bad_request', t('Idempotency-Key must", "if (!m) return null; if (false) throw new Problem(400, 'bad_request', t('Idempotency-Key must"]]],
  ['repetición que no devuelve lo mismo', 'idempotency.replay', [['if (live && live.print === print)\n      return send', 'if (false)\n      return send']]],
  ['otra petición con la misma clave aceptada', 'idempotency.mismatch',
    [["coincide con la colección actual.'));\n    if (live) throw new Problem(422, 'idempotency_mismatch'", "coincide con la colección actual.'));\n    if (false) throw new Problem(422, 'idempotency_mismatch'"]]],
  ['respuesta mínima sin Preference-Applied', 'minimal',
    [["const applied = prefer ? { 'Preference-Applied': 'return=minimal' } : {};", 'const applied = {};']]],
  // Borrador 6
  ['POST como text/plain aceptado', 'media-type', [["if (!mediaTypeOk(req.headers['content-type'], types))", 'if (false)']]],
  ['415 a un PATCH sin Accept-Patch', 'media-type.accept-patch',
    [["types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {}", '{}']]],
  ['2xx con otro tipo de medio', 'json-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "status >= 400 ? 'application/problem+json' : 'application/vnd.restep+json'"]]],
  ['id_from client y alta sin id aceptada', 'id.assigned',
    [['...(c.id_from && { id_from: c.id_from }), // 5.1', "...(c.id_from && { id_from: n === 'categories' ? 'client' : c.id_from }), // 5.1"]]],
  ['reason que no está en reasons', 'error.reason',
    [["return new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { errors:",
      "return new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { reason: 'id_taken', errors:"]]],
  ['Location con otro esquema', 'links', [['{ Location: location(row), ETag: etag(row),', "{ Location: `ftp://example.com${location(row)}`, ETag: etag(row),"]]],
  ['restep mal formado', 'discovery.version', [["const RESTEP = '1.0-draft.6';", "const RESTEP = '1.0.6';"]]],
  ['singleton que acepta POST', 'singleton',
    [["  if (!allow.split(', ').includes(method))\n    throw", "  if (method === 'POST') return send(res, 200, withEtag(shop.row));\n  if (!allow.split(', ').includes(method))\n    throw"]]],
  ['singleton sin _etag', 'etag', [['const data = fields ? { ...pick(shop.row, fields), _etag: etag(shop.row) } : withEtag(shop.row);',
    'const data = fields ? { ...pick(shop.row, fields), _etag: etag(shop.row) } : { ...shop.row };']]],
  ['include en un singleton ignorado', 'reserved', [["if (!read || base !== 'fields' || key !== base) throw unsupported(key);", 'if (false) throw unsupported(key);']]],
  ['escritura a un elemento borrado da 412', 'if-match',
    [['if (id !== undefined && !coll.rows.has(id)) throw missing(url);',
      "if (id !== undefined && !coll.rows.has(id)) { if (req.headers['if-match']) throw new Problem(412, 'precondition_failed', 'x'); throw missing(url); }"]]],
  ['respuesta mínima sin ETag', 'minimal.etag',
    [['prefer ? undefined : withEtag(row), { ETag: etag(row), ...invalidation, ...applied });', 'prefer ? undefined : withEtag(row), { ...invalidation, ...applied });']]],
  ['misma clave con otra query aceptada', 'idempotency.mismatch', [['const query = [...params].map(([k, v]) => `${k}=${v}`).sort();', 'const query = [];']]],
  ['claves sin credenciales con anonymous false', 'idempotency.key',
    [['idempotency: { ttl: TTL / 1000 },', 'idempotency: { ttl: TTL / 1000, anonymous: false },']]],
  // relations (9) y actions (11.1), que la referencia anuncia desde el borrador 6 final
  ['enlace a una subcolección sin href', 'relations.link', [["highlight: { id: '1', href: '/books/7/reviews/1' } },", "highlight: { id: '1' } },"]]],
  ['enlace polimórfico sin type', 'relations.link', [["showcase: { type: 'products', id: '2' }, tax_rate_own: null },", "showcase: { id: '2' }, tax_rate_own: null },"]]],
  ['include más hondo que include_depth aceptado', 'relations.include', [['if (segs.length > (coll.include_depth ?? 1))', 'if (false)']]],
  ['fields con punto sin include aceptado', 'relations.fields', [['if (!include.includes(`${prefix}${m}`)) throw bad(', 'if (false) throw bad(']]],
  ['_actions con otro método', 'actions.listed', [["{ method: a.method ?? 'POST', href:", "{ method: 'GET', href:"]]],
  ['acción que responde 202', 'actions.response', [['row.stock = (row.stock ?? 0) + body.quantity; return [200, row];', 'row.stock = (row.stock ?? 0) + body.quantity; return [202, row];']]],
  ['acción no declarada que responde 200', 'actions.undeclared',
    [["  if (!decl || decl.on !== (id === undefined ? 'collection' : 'item')", "  if (!decl) return send(res, 200, { ok: true });\n  if (!decl || decl.on !== (id === undefined ? 'collection' : 'item')"]]],
  ['acción que rechaza el cuerpo vacío', 'actions.empty-body', [["const [body, sent] = await readJson(req, ['application/json'], true);", "const [body, sent] = await readJson(req, ['application/json'], false);"]]],
  ['401 sin no-store', 'cache-private.auth', [["{ 'Cache-Control': 'no-store', Vary: 'Accept-Language',", "{ Vary: 'Accept-Language',"]], OAUTH],
  ['401 sin WWW-Authenticate', 'error.401', [["{ 'WWW-Authenticate': challenge }", '{}']], OAUTH],
  ['caché pública con credenciales', 'cache-private',
    [["if (TOKEN && cc && !cc.includes('no-store')) headers =", 'if (false) headers =']], OAUTH],
];

// ── Utilidades ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmd, args, env, ready) { // arranca un proceso y espera a que escriba la línea `ready`
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.output = () => out;
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${args.join(' ')} no arrancó:\n${out}`)), 5000);
    const on = (b) => { out += b; if (out.includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', () => { clearTimeout(timer); if (!out.includes(ready)) reject(new Error(`${args.join(' ')} terminó al arrancar:\n${out}`)); });
  });
}
async function stop(child) { if (child.exitCode === null) child.kill('SIGINT'); return child.exited; }

// Tráfico variado contra base; nunca lanza: una mutación puede responder cualquier cosa.
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
  // Colecciones: filtros, orden, campos, recuento, paginación y errores de parámetros.
  for (const q of ['', '?sort=-rating', '?sort=title', '?sort=price,id', '?filter[price][le]=15', '?filter[rating][ge]=4',
    '?filter[rating][null]=true', '?filter[category][in]=poesia,ensayo', '?filter[category]=novela-negra&count=true',
    '?filter[year][ge]=2024&sort=-year', '?fields=title,price', '?count=true&limit=3', '?limit=0', '?limit=500', '?filter[title]=x',
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
  await call('POST', '/books', { body: { year: 2026, price: '9.99', title: 'Nuevo' }, headers: key }); // la misma petición
  await call('POST', '/books', { body: { title: 'Otro', price: '9.99' }, headers: key }); // otra petición, misma clave
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
  // Borrador 6: tipos de medio (3), id_from (5.1), razones (5.4), singletons (5.9) y la query en Idempotency-Key (7.1).
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
  // relations (9): include declarado, más hondo de la cuenta, polimórfico; fields con punto con y sin include.
  for (const q of ['?include=author', '?include=related.author', '?include=nope', '?fields=title,author.name', '?include=author&fields=title,author.name'])
    await get(`/books${q}`);
  await get('/books/7?include=highlight'); await get('/categories?include=showcase'); await get('/books/7/reviews'); await get('/books/7/reviews/1');
  // actions (11.1): de elemento con input, con el cuerpo vacío, de colección GET, no declarada, de otro tipo, otro método.
  await call('POST', '/products/1:restock', { body: { quantity: 2 } });
  await call('POST', '/products/1:restock');
  await get('/products:low_stock'); await call('POST', '/books/7:nope', { body: {} }); await call('POST', '/products:restock', { body: { quantity: 1 } });
  await get('/products/1:restock'); await call('POST', '/authors:find_or_create', { body: { name: 'Autora del proxy' } });
  // Productos: mapas de idioma y herencia.
  const p = await call('POST', '/products', { body: { name: { es: 'Lápiz', en: 'Pencil' }, price: '0.80', category: { id: '3' } } });
  const pl = p.headers.get('location');
  if (pl) { await call('PATCH', pl, { body: { tax_rate_own: '4' } }); await call('PATCH', pl, { body: { name: { en: null } } }); await call('DELETE', pl); }
  // Sin credenciales (con oauth, 401).
  if (token) { await fetch(`${base}/`).catch(() => {}); await fetch(`${base}/books`, { headers: { authorization: 'Bearer otro' } }).catch(() => {}); }
}

// Arranca el servidor (mutado o no), el proxy delante, manda el tráfico y devuelve el informe.
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
      mode === OAUTH ? { RESTEP_TOKEN: TOKEN } : {}, 'Resumen en');
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
    if (n !== 1) throw new Error(`el texto de la mutación aparece ${n} veces en el servidor: ${from}`);
    s = s.replace(from, () => to);
  }
  return s;
}

// ── Pruebas ───────────────────────────────────────────────────────────────────
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FALLO'} ${msg}`); if (!cond) failures++; };
const dir = mkdtempSync(join(tmpdir(), 'restep-proxy-'));
try {
  if (!only) {
    const published = JSON.parse(readFileSync(join(here, 'schema/problem.json'), 'utf8'));
    ok(isDeepStrictEqual(published, PROBLEM_SCHEMA), 'el esquema problem.json incrustado coincide con schema/problem.json');
    // La especificación solo está en el repositorio de la web; el espejo no la copia.
    const specPath = join(here, '../../public/1/index.html');
    if (existsSync(specPath)) {
      const spec = readFileSync(specPath, 'utf8');
      const anchors = Object.keys(CHECKS).map((id) => sectionUrl(CHECKS[id][0], id).split('#')[1]);
      ok(anchors.every((a) => spec.includes(`id="${a}"`)), 'cada comprobación enlaza a un ancla que existe en la especificación');
    }
    ok(sectionUrl('5.1', 'cache-private').endsWith('#private-responses') && sectionUrl('5.1', 'cache-private.auth').endsWith('#private-responses'),
      'cache-private enlaza a las respuestas privadas de 5.1, no a #resources');

    for (const mode of [null, OAUTH]) {
      const { code, report } = await run(SERVER, mode, dir);
      const list = report.groups.map((g) => `\n      ${g.level} ${g.check} ${g.method} ${g.route}: ${g.first.message}`).join('');
      ok(report.violations === 0 && report.warnings === 0 && code === 0,
        `servidor de referencia${mode ? ' con oauth' : ''}: ${report.exchanges} intercambios, ${report.violations} violaciones, ${report.warnings} avisos${list}`);
    }
  }

  let caught = 0, tried = 0;
  for (const [name, check, edits, mode] of MUTATIONS) {
    if (only && !name.includes(only)) continue;
    tried++;
    const { code, report } = await run(apply(SERVER, edits), mode, dir);
    const hit = report.groups.find((g) => g.check === check);
    const must = hit?.level === 'DEBE';
    const good = hit && (must ? code === 1 : true);
    if (good) caught++;
    ok(good, `mutación «${name}» → ${check}${hit ? ` (${hit.count}×, ${hit.method} ${hit.route}: ${hit.first.message})` : `: no detectada; saltaron ${report.groups.map((g) => g.check).join(', ') || 'ninguna'}`}`);
  }
  console.log(`${caught} de ${tried} mutaciones detectadas`);

  if (!only) {
    // --strict: el servidor que da errores como application/json.
    const mutated = join(dir, 'strict-server.mjs');
    writeFileSync(mutated, apply(SERVER, MUTATIONS.find((m) => m[1] === 'error.media-type')[2]));
    const server = await start(process.execPath, [mutated], { PORT: String(SERVER_PORT) }, 'on http://');
    const proxy = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${SERVER_PORT}`, '--port', String(STRICT_PORT), '--strict', '--quiet'], {}, 'Resumen en');
    try {
      const direct = await fetch(`http://127.0.0.1:${SERVER_PORT}/books?sort=-rating`);
      const via = await fetch(`http://127.0.0.1:${STRICT_PORT}/books?sort=-rating`);
      const [d1, d2] = [await direct.text(), await via.text()];
      ok(via.status === 200 && d1 === d2 && via.headers.get('etag') === direct.headers.get('etag') && via.headers.get('link') === direct.headers.get('link'),
        '--strict deja pasar sin cambios una respuesta correcta');
      const bad = await fetch(`http://127.0.0.1:${STRICT_PORT}/books/999`);
      const body = await bad.json();
      ok(bad.status === 502 && bad.headers.get('content-type') === 'application/problem+json' && body.code === 'bad_gateway'
        && body.status === 502 && body.upstream_status === 404 && body.violations.some((v) => v.check === 'error.media-type'),
      `--strict sustituye una respuesta que incumple por un 502 problem+json (${body.violations?.map((v) => v.check).join(', ')})`);
      const page = await fetch(`http://127.0.0.1:${STRICT_PORT}/_restep-proxy`);
      const html = await page.text();
      ok(page.status === 200 && html.includes('error.media-type') && html.includes('respuestas sustituidas'), 'GET /_restep-proxy da el resumen en HTML');
    } finally {
      const code = await stop(proxy);
      ok(code === 1, `al terminar con violaciones, el proxy sale con 1 (salió con ${code})`);
      await stop(server);
    }

    // Reenvío: hop-by-hop, flujo y gzip, con un servidor auxiliar.
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
    const fwd = await start(process.execPath, [PROXY, '--target', `http://127.0.0.1:${AUX_PORT}`, '--port', String(PROXY_PORT), '--report', reportFile, '--quiet'], {}, 'Resumen en');
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
        'las cabeceras hop-by-hop de la petición (también las que nombra Connection) no llegan; las demás sí');
      ok(!echoed.headers['x-hop-res'] && echoed.headers['x-kept'] === '1', 'las cabeceras hop-by-hop de la respuesta no llegan al cliente; las demás sí');
      const t0 = Date.now();
      const s = await fetch(`http://127.0.0.1:${PROXY_PORT}/stream`);
      const reader = s.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const t1 = Date.now() - t0;
      let rest = '';
      for (let x; !(x = await reader.read()).done;) rest += new TextDecoder().decode(x.value);
      ok(first.startsWith('primero') && t1 < 300 && (first + rest).includes('segundo'), `la respuesta llega en flujo (primer trozo a los ${t1} ms)`);
      const gz = await fetch(`http://127.0.0.1:${PROXY_PORT}/gz`);
      ok(gz.status === 404 && (await gz.json()).error === 'no existe', 'un cuerpo gzip se reenvía intacto');
      await (await fetch(`http://127.0.0.1:${PROXY_PORT}/en-curso`, { method: 'POST' })).text();
    } finally {
      await stop(fwd);
      aux.close();
    }
    const rep = JSON.parse(readFileSync(reportFile, 'utf8'));
    ok(rep.groups.some((g) => g.check === 'error.media-type' && g.route === '(otra ruta)'), 'el cuerpo gzip se descomprime para analizarlo (error.media-type en /gz)');
    ok(rep.groups.some((g) => g.check === 'error.retry-after' && g.level === 'DEBERÍA' && /request_in_progress/.test(g.first.message)),
      'un 409 request_in_progress sin Retry-After da un aviso (error.retry-after)');
    ok(!rep.groups.some((g) => g.check === 'error.code'), 'request_in_progress es un code válido para 409');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} prueba(s) fallida(s)` : '\nTodas las pruebas pasan');
process.exit(failures ? 1 : 0);
