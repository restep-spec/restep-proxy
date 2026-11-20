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
import { PROBLEM_SCHEMA } from './restep-proxy.mjs';

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
    [['items: page.map((r) => pick(r, fields)), next,', 'items: page.map((r) => pick(r, fields)), ...(next && { next }),']]],
  ['errores como application/json', 'error.media-type',
    [["status >= 400 ? 'application/problem+json' : 'application/json'", "'application/json'"]]],
  ['status distinto en el cuerpo', 'error.status',
    [["title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,", "title: text(TITLES[p.status] ?? 'Error', lang), status: 400,"]]],
  ['404 con otro código', 'error.code',
    [['code: p.code, detail: text(p.detail, lang),', "code: p.status === 404 ? 'missing' : p.code, detail: text(p.detail, lang),"]]],
  ['entrada de errors sin code', 'error.schema',
    [["errors.push({ pointer: ptr(f), code: 'required', detail:", 'errors.push({ pointer: ptr(f), detail:']]],
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
  ['201 sin Location', 'location', [['{ Location: location(row), ETag: etag(row), ...applied }', '{ ETag: etag(row), ...applied }']]],
  ['POST con id aceptado', 'id.assigned', [["if ('id' in body) throw invalid(", 'if (false) throw invalid(']]],
  ['PATCH con otro id aceptado', 'id.assigned', [["if ('id' in patch && patch.id !== id) throw invalid(", 'if (false) throw invalid(']]],
  ['parche que es una lista aceptado', 'patch.object',
    [['if (isObject(v)) { // members', 'if (isObject(v) || Array.isArray(v)) { // members']]],
  ['precio como número', 'item.discovery', [["price: '18.50', rating: 4.6", 'price: 18.5, rating: 4.6']]],
  ['retirada sin Deprecation', 'deprecation',
    [['schemas: schemas(c, lang), max_limit: c.max_limit,',
      "schemas: schemas(c, lang), ...(n === 'books' && { deprecations: [{ kind: 'filter', name: 'year' }] }), max_limit: c.max_limit,"]]],
  ['limit recortado en silencio', 'limit',
    [['if (!/^\\d+$/.test(params.get(\'limit\') ?? \'1\') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)',
      "if (!/^\\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1)"]]],
  ['next pierde los parámetros', 'next', [['const q = new URLSearchParams(params);', 'const q = new URLSearchParams();']]],
  ['next relativo', 'links', [['next = `${path}?${q}`;', 'next = `${path.slice(1)}?${q}`;']]],
  ['ge devuelve ausentes', 'filter.match',
    [['items = items.filter((r) => at(r, field) != null && OPS[op](compare(type, at(r, field), v)));',
      "items = items.filter((r) => (at(r, field) == null && op === 'ge') || (at(r, field) != null && OPS[op](compare(type, at(r, field), v))));"]]],
  ['eq no filtra', 'filter.match', [['eq: (c) => c === 0,', 'eq: () => true,']]],
  ['ausentes primero al ordenar', 'sort.order',
    [['return x == null ? 1 : -1; } // missing values last', 'return x == null ? -1 : 1; }']]],
  ['fields ignorado', 'fields', [['  if (!fields) return row;', '  return row;']]],
  ['count sin total', 'count', [["...(count === 'true' && { total: items.length }),", '']]],
  ['filtro declarado rechazado', 'query.declared-rejected',
    [['if (!Object.hasOwn(coll.filter, field)) throw unsupported(key);', "if (!Object.hasOwn(coll.filter, field) || field === 'year') throw unsupported(key);"]]],
  ['filtro no declarado aceptado', 'query.undeclared',
    [['if (!Object.hasOwn(coll.filter, field)) throw unsupported(key);', 'if (!Object.hasOwn(coll.filter, field)) continue;']]],
  ['ETag débil', 'etag', [['const etag = (value) => `"${hash(JSON.stringify(value))}"`;', 'const etag = (value) => `W/"${hash(JSON.stringify(value))}"`;']]],
  ['fields sin _etag', 'etag', [['data = fields ? { ...pick(row, fields), _etag: etag(row) } : row;', 'data = fields ? pick(row, fields) : row;']]],
  ['If-Match ignorado', 'if-match', [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (false)']]],
  ['412 sin cabecera condicional', 'precondition',
    [['if (ifMatch !== undefined && !strongMatch(ifMatch, etag(current)))', 'if (ifMatch === undefined || !strongMatch(ifMatch, etag(current)))']]],
  ['If-None-Match ignorado en GET', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);", '']]],
  ['If-None-Match ignorado en escritura', 'if-none-match',
    [["if (weakMatch(req.headers['if-none-match'], etag(current)))", 'if (false)']]],
  ['Idempotency-Key mal formada aceptada', 'idempotency.key',
    [["if (!m) throw new Problem(400, 'bad_request', t('Idempotency-Key must", "if (!m) return null; if (false) throw new Problem(400, 'bad_request', t('Idempotency-Key must"]]],
  ['repetición que no devuelve lo mismo', 'idempotency.replay', [['if (live && live.print === print)', 'if (false)']]],
  ['otra petición con la misma clave aceptada', 'idempotency.mismatch',
    [["if (live) throw new Problem(422, 'idempotency_mismatch'", "if (false) throw new Problem(422, 'idempotency_mismatch'"]]],
  ['respuesta mínima sin Preference-Applied', 'minimal',
    [["const applied = prefer ? { 'Preference-Applied': 'return=minimal' } : {};", 'const applied = {};']]],
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
    '?sort=nope', '?cursor=abc', '?$expand=1', '?sort[title]=asc', '?filter[price][le]=caro'])
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
    } finally {
      await stop(fwd);
      aux.close();
    }
    const rep = JSON.parse(readFileSync(reportFile, 'utf8'));
    ok(rep.groups.some((g) => g.check === 'error.media-type' && g.route === '(otra ruta)'), 'el cuerpo gzip se descomprime para analizarlo (error.media-type en /gz)');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} prueba(s) fallida(s)` : '\nTodas las pruebas pasan');
process.exit(failures ? 1 : 0);
