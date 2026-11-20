#!/usr/bin/env node
// restep-proxy · Proxy HTTP inverso que vigila el contrato Restep 1 en tráfico real.
// Node 18 o posterior, sin dependencias.  Especificación: https://restep.wubytes.com/1/  (borrador 4)
//
//   node restep-proxy.mjs --target http://api:8080 --port 8871 [--report report.json] [--strict]
//
// Reenvía cada petición al objetivo sin alterarla (en flujo, quitando solo las cabeceras hop-by-hop)
// y, en paralelo, comprueba cada par petición/respuesta contra la especificación y contra el documento
// de descubrimiento del objetivo. Las violaciones salen agrupadas en el log, el resumen al terminar
// (Ctrl+C) y, con --report, en un JSON. Con --strict, una respuesta que incumple un DEBE se sustituye
// por un 502 problem+json (para CI). GET /_restep-proxy da el resumen en HTML (y /_restep-proxy.json, en JSON).
// No genera tráfico propio salvo un GET a la raíz al arrancar, para leer el descubrimiento.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const VERSION = '0.1.0';
const SPEC = 'https://restep.wubytes.com/1/';
const ANCHORS = {
  3: 'data', 4.1: 'profile-header', 4.2: 'discovery', 4.3: 'describing', 4.4: 'health', 5.1: 'resources', 5.2: 'collections',
  5.3: 'reserved', 5.4: 'errors', 5.5: 'versions', 5.7: 'inheritance', 6.1: 'filters', 6.2: 'sorting', 6.3: 'fields',
  6.4: 'pagination', 6.5: 'counts', 7.1: 'idempotency', 7.2: 'concurrency', 7.3: 'caching', 7.4: 'minimal',
};
const sectionUrl = (s) => `${SPEC}#${ANCHORS[s] ?? 'conformance'}`;

// ── Catálogo: cada comprobación, su apartado, su nivel y qué verifica ─────────
// Un DEBE incumplido es una violación; un DEBERÍA, un aviso. --strict solo actúa con las violaciones.
export const CHECKS = {
  json: ['3', 'DEBE', 'Un cuerpo JSON es JSON válido en UTF-8'],
  links: ['3', 'DEBE', 'next y href son URI absolutas o rutas absolutas bajo la raíz de la API'],
  'profile-link': ['4.1', 'DEBERÍA', 'Cada respuesta lleva un enlace rel="profile" por perfil y extensión anunciados'],
  health: ['4.4', 'DEBE', 'El recurso de status responde 200 o 503 con Cache-Control: no-store (o 401, 403, 429)'],
  allow: ['4.3', 'DEBE', 'Un 405 nombra en Allow los métodos declarados y ninguno más; un método declarado nunca da 405'],
  'status.success': ['5.1', 'DEBE', 'Éxitos con el estado de la tabla: GET 200, POST 201, PATCH 200 (204 con return=minimal), DELETE 204'],
  location: ['5.1', 'DEBE', 'Un 201 lleva Location con la ruta del elemento: la de su colección, / y su id'],
  'id.assigned': ['5.1', 'DEBE', 'Un POST con id o un PATCH con otro id dan 422, no éxito'],
  'patch.object': ['5.1', 'DEBE', 'Un parche que no es un objeto JSON da 400, no éxito'],
  'collection.shape': ['5.2', 'DEBE', 'Una colección responde {items, next}, con next presente (cadena o null)'],
  reserved: ['5.3', 'DEBE', 'Un parámetro reservado que el recurso no implementa da 400 unsupported_parameter; no se ignora'],
  'error.media-type': ['5.4', 'DEBE', 'Los 4xx y 5xx con cuerpo van en application/problem+json'],
  'error.schema': ['5.4', 'DEBE', 'El cuerpo de error cumple el esquema problem.json'],
  'error.status': ['5.4', 'DEBE', 'El status del cuerpo es el de la respuesta'],
  'error.code': ['5.4', 'DEBE', 'code sale de la tabla para ese estado, del registro de la IANA o es http_NNN'],
  'error.type': ['5.4', 'DEBERÍA', 'type es la URI de error de Restep para ese code, otra URI o about:blank'],
  'error.detail': ['5.4', 'DEBERÍA', 'Los errores llevan detail'],
  'error.401': ['5.4', 'DEBE', 'Un 401 lleva WWW-Authenticate'],
  'error.405': ['5.1', 'DEBE', 'Un 405 lleva Allow'],
  'error.retry-after': ['5.4', 'DEBERÍA', 'Un 429 o un 503 llevan Retry-After'],
  'error.parameter': ['5.3', 'DEBE', 'invalid_parameter y unsupported_parameter nombran en parameter el parámetro tal como llegó'],
  'no-error-in-200': ['5.4', 'DEBE', 'Ningún objeto problem dentro de un 2xx'],
  deprecation: ['5.5', 'DEBE', 'Lo que el descubrimiento retira lleva Deprecation (y Sunset); pasada la fecha, ya no funciona'],
  'item.discovery': ['4.2', 'DEBE', 'Los elementos encajan con el descubrimiento: tipos declarados, mapas de idioma, relaciones y herencia'],
  'query.declared-rejected': ['5.3', 'DEBE', 'Un filtro, orden o recuento declarados no se rechazan con unsupported_parameter'],
  'query.undeclared': ['5.3', 'DEBE', 'Un campo u operador de filtro o un campo de orden no declarados dan unsupported_parameter'],
  'filter.match': ['6.1', 'DEBE', 'Cada elemento devuelto cumple los filtros, comparando según el tipo declarado'],
  'sort.order': ['6.2', 'DEBE', 'Los elementos vienen en el orden pedido, con los que no tienen valor al final'],
  fields: ['6.3', 'DEBE', 'Con fields solo vienen esos campos, id y los miembros que empiezan por _'],
  limit: ['6.4', 'DEBE', 'Una página no pasa de limit, y un limit fuera de 1..max_limit da invalid_parameter'],
  next: ['6.4', 'DEBE', 'next lleva cursor y conserva sin cambios los demás parámetros'],
  count: ['6.5', 'DEBE', 'count=true añade total, un entero; con count exact, sin total_estimated'],
  'idempotency.key': ['7.1', 'DEBE', 'Una Idempotency-Key mal formada da 400 bad_request'],
  'idempotency.replay': ['7.1', 'DEBE', 'La misma petición con la misma Idempotency-Key devuelve el mismo estado y el mismo cuerpo'],
  'idempotency.replayed-header': ['7.1', 'DEBERÍA', 'Una repetición lleva Idempotent-Replayed: true'],
  'idempotency.mismatch': ['7.1', 'DEBE', 'La misma Idempotency-Key con otra petición no tiene éxito (422 idempotency_mismatch)'],
  etag: ['7.2', 'DEBE', 'El GET de un elemento lleva su ETag fuerte o, con fields o codificación, _etag'],
  'if-match': ['7.2', 'DEBE', 'If-Match con una ETag antigua da 412; con la vigente, no'],
  precondition: ['7.2', 'DEBE', 'Un 412 responde a una cabecera condicional y un 428 a una escritura sin If-Match'],
  'if-none-match': ['7.3', 'DEBE', 'If-None-Match que coincide da 304 a GET y HEAD y 412 a una escritura'],
  'cache-control': ['7.3', 'DEBE', 'Toda respuesta a GET o HEAD, también de error, lleva Cache-Control'],
  'cache-private': ['7.3', 'DEBE', 'Una respuesta a una petición con credenciales es private o no-store'],
  minimal: ['7.4', 'DEBERÍA', 'Una respuesta mínima lleva ETag (y Location si es 201) y Preference-Applied'],
};

// ── Esquema de errores (schema/problem.json, copiado tal cual; test.mjs comprueba que coincide) ──
export const PROBLEM_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://restep.wubytes.com/1/schema/problem.json',
  title: 'Restep 1 error',
  description: 'Body of every 4xx or 5xx response: application/problem+json (RFC 9457) with a code (section 5.4). Whether code fits the status is checked by restep-check, not by this schema.',
  type: 'object',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string', format: 'uri-reference', examples: ['https://restep.wubytes.com/1/errors#invalid', 'about:blank'] },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    code: {
      type: 'string', pattern: '^[a-z][a-z0-9_]*$',
      examples: ['bad_request', 'invalid_parameter', 'unsupported_parameter', 'idempotency_key_required', 'unauthenticated',
        'forbidden', 'not_found', 'method_not_allowed', 'not_acceptable', 'conflict', 'state_expired', 'retired',
        'precondition_failed', 'content_too_large', 'uri_too_long', 'unsupported_media_type', 'invalid',
        'idempotency_mismatch', 'not_executed', 'precondition_required', 'rate_limited', 'internal', 'not_implemented',
        'unavailable'],
    },
    detail: { type: 'string' },
    instance: { type: 'string', format: 'uri-reference' },
    reason: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Domain reason defined by the API (5.4).' },
    parameter: { type: 'string', description: 'The parameter name as received, after percent-decoding (5.3).' },
    errors: {
      type: 'array',
      items: {
        type: 'object', required: ['code'],
        properties: {
          pointer: { type: 'string', pattern: '^(/.*)?$', description: 'JSON Pointer into the request body (RFC 6901).' },
          parameter: { type: 'string' },
          header: { type: 'string' },
          code: { type: 'string', examples: ['required', 'type', 'format', 'range', 'too_long', 'unknown', 'read_only'] },
          detail: { type: 'string' },
        },
        anyOf: [{ required: ['pointer'] }, { required: ['parameter'] }, { required: ['header'] }],
      },
    },
  },
};

// Validador mínimo de JSON Schema: solo lo que usa problem.json (type, required, properties, pattern,
// minimum, maximum, items, anyOf, enum). format y las anotaciones se ignoran.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TYPE_IS = {
  object: isObject, array: Array.isArray, string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v), integer: (v) => Number.isInteger(v), null: (v) => v === null,
};
export function schemaErrors(schema, v, at = '') {
  const where = at || '/';
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => TYPE_IS[t]?.(v))) return [`${where} no es de tipo ${types.join(' ni ')}`];
  }
  const out = [];
  if (schema.enum && !schema.enum.some((e) => canonical(e) === canonical(v))) out.push(`${where} no es ninguno de los valores admitidos`);
  if (typeof v === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) out.push(`${where} (${JSON.stringify(v)}) no cumple ${schema.pattern}`);
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) out.push(`${where} es menor que ${schema.minimum}`);
  if (typeof v === 'number' && schema.maximum !== undefined && v > schema.maximum) out.push(`${where} es mayor que ${schema.maximum}`);
  if (isObject(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`falta ${at}/${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) out.push(...schemaErrors(s, v[k], `${at}/${k}`));
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => out.push(...schemaErrors(schema.items, x, `${at}/${i}`)));
  if (schema.anyOf && !schema.anyOf.some((s) => schemaErrors(s, v, at).length === 0))
    out.push(`${where} no cumple ninguna de las alternativas (${schema.anyOf.map((s) => (s.required ? s.required.join('+') : '?')).join(', ')})`);
  return out;
}

// ── Utilidades compartidas con restep-check (copiadas: restep-check no exporta nada) ──
const TABLE = {
  400: ['bad_request', 'invalid_parameter', 'unsupported_parameter', 'idempotency_key_required'], 401: ['unauthenticated'],
  403: ['forbidden'], 404: ['not_found'], 405: ['method_not_allowed'], 406: ['not_acceptable'], 409: ['conflict'],
  410: ['state_expired', 'retired'], 412: ['precondition_failed'], 413: ['content_too_large'], 414: ['uri_too_long'],
  415: ['unsupported_media_type'], 422: ['invalid', 'idempotency_mismatch'], 424: ['not_executed'],
  428: ['precondition_required'], 429: ['rate_limited'], 500: ['internal'], 501: ['not_implemented'], 503: ['unavailable'],
};
const IANA = {
  402: 'payment_required', 407: 'proxy_authentication_required', 408: 'request_timeout', 411: 'length_required',
  416: 'range_not_satisfiable', 417: 'expectation_failed', 421: 'misdirected_request', 423: 'locked', 425: 'too_early',
  426: 'upgrade_required', 431: 'request_header_fields_too_large', 451: 'unavailable_for_legal_reasons',
  502: 'bad_gateway', 504: 'gateway_timeout', 505: 'http_version_not_supported', 506: 'variant_also_negotiates',
  507: 'insufficient_storage', 508: 'loop_detected', 510: 'not_extended', 511: 'network_authentication_required',
};
const expectedCodes = (status) => TABLE[status] ?? [IANA[status] ?? `http_${status}`];
const mediaType = (v) => String(v ?? '').split(';')[0].trim().toLowerCase();
const isJsonType = (t) => t === 'application/json' || t.endsWith('+json');
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const blank = (v) => v === undefined || v === null;
const get = (item, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), item);
const RESERVED = ['filter', 'sort', 'fields', 'include', 'count', 'limit', 'cursor', 'since', 'languages'];
const FOUR = ['GET', 'POST', 'PATCH', 'DELETE'];
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const TAG = new RegExp('^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?' +
  '(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?' +
  '|x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)' +
  '|sgn-(?:be-fr|be-nl|ch-de)|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang))$');

function linkTargets(value, rel) { // URI de los enlaces de una cabecera Link con esa rel
  const out = [];
  for (const m of String(value ?? '').matchAll(/<([^>]*)>([^,<]*)/g)) {
    const rels = m[2].match(/rel\s*=\s*("([^"]*)"|[^;\s]+)/i);
    if (rels && (rels[2] ?? rels[1]).split(/\s+/).includes(rel)) out.push(m[1]);
  }
  return out;
}
function cmpDecimal(a, b) { // exacta: compara cifras, nunca pasa por Number
  const neg = (s) => s.startsWith('-') && /[1-9]/.test(s);
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.'), [bi, bf = ''] = b.replace('-', '').split('.');
  const i1 = ai.replace(/^0+(?=\d)/, ''), i2 = bi.replace(/^0+(?=\d)/, '');
  if (i1.length !== i2.length) return sign * (i1.length - i2.length);
  if (i1 !== i2) return sign * (i1 < i2 ? -1 : 1);
  const n = Math.max(af.length, bf.length), f1 = af.padEnd(n, '0'), f2 = bf.padEnd(n, '0');
  return f1 === f2 ? 0 : sign * (f1 < f2 ? -1 : 1);
}
function cmpText(a, b) { // por puntos de código Unicode
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function durationSeconds(s) {
  const m = String(s).match(DURATION);
  if (!m || m[1] || m[2]) return NaN; // años y meses no tienen longitud fija
  const n = (x) => (x ? parseFloat(x) : 0);
  return n(m[3]) * 604800 + n(m[4]) * 86400 + n(m[6]) * 3600 + n(m[7]) * 60 + n(m[8]);
}
// Forma comparable de un valor de ese tipo; undefined si no encaja con el tipo.
function norm(type, v) {
  switch (type) {
    case 'decimal': return typeof v === 'string' && DECIMAL.test(v) ? v : undefined;
    case 'integer': { const n = typeof v === 'number' ? v : /^-?\d+$/.test(v) ? Number(v) : NaN; return Number.isInteger(n) ? n : undefined; }
    case 'number': { const n = typeof v === 'number' ? v : /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; }
    case 'boolean': return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
    case 'date': return DATE.test(v) ? Date.parse(`${v}T00:00:00Z`) : undefined;
    case 'datetime': return DATETIME.test(v) ? Date.parse(v) : undefined;
    case 'duration': { const s = durationSeconds(v); return Number.isNaN(s) ? undefined : s; }
    default: return typeof v === 'string' ? v : undefined;
  }
}
function cmp(type, a, b) {
  if (type === 'decimal') return cmpDecimal(a, b);
  if (type === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return cmpText(String(a), String(b));
}
// Si un elemento cumple filter[campo][op]=raw, según 6.1.
function matches(type, op, value, raw) {
  if (op === 'null') return blank(value) === (raw === 'true');
  if (blank(value)) return false;
  const x = norm(type, value);
  if (x === undefined) return false;
  if (op === 'in') return raw.split(',').some((r) => cmp(type, x, norm(type, r)) === 0);
  const c = cmp(type, x, norm(type, raw));
  return { eq: c === 0, ne: c !== 0, lt: c < 0, le: c <= 0, gt: c > 0, ge: c >= 0 }[op];
}
// Si un valor encaja con el tipo con que se declara un campo (4.2): un valor del elemento, no de la URL.
function fitsType(d, v) {
  switch (d?.type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'decimal': return typeof v === 'string' && DECIMAL.test(v);
    case 'boolean': return typeof v === 'boolean';
    case 'date': return typeof v === 'string' && DATE.test(v);
    case 'datetime': return typeof v === 'string' && DATETIME.test(v);
    case 'duration': return typeof v === 'string' && DURATION.test(v);
    case 'enum': return Array.isArray(d.values) ? d.values.includes(v) : typeof v === 'string';
    default: return true;
  }
}
// Listas de If-Match / If-None-Match (RFC 9110, 13.1).
const etagList = (h) => String(h ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const weakEq = (a, b) => a.replace(/^W\//, '') === b.replace(/^W\//, '');

// ── Opciones ──────────────────────────────────────────────────────────────────
const HELP = `restep-proxy ${VERSION} · proxy inverso que vigila el contrato Restep 1

Uso:
  restep-proxy --target <url> [opciones]

Opciones:
  --target <url>      API Restep a la que se reenvía (obligatoria), p. ej. http://api:8080 o
                      http://api:8080/v1/ si la raíz de la API no es la del host. Las rutas se
                      reenvían tal cual.
  --port <n>          Puerto en el que escucha el proxy (por omisión, 8871)
  --host <host>       Interfaz en la que escucha (por omisión, 127.0.0.1)
  --report <archivo>  Al terminar, escribe el informe en JSON
  --strict            Sustituye por un 502 problem+json toda respuesta que incumpla un DEBE
  --max-body <bytes>  Tamaño máximo de cuerpo que se analiza (por omisión, 2097152)
  --preserve-host     Reenvía la cabecera Host del cliente en vez de la del objetivo
  --quiet             No escribe el log en vivo, solo el resumen final
  -h, --help          Esta ayuda

Con RESTEP_TOKEN, el GET inicial al descubrimiento lleva Authorization: Bearer (el tráfico
de los clientes pasa con sus propias credenciales).

GET /_restep-proxy da el resumen en HTML; GET /_restep-proxy.json, el informe en JSON.
Código de salida al terminar (SIGINT o SIGTERM): 0 sin violaciones, 1 con alguna, 2 si no puede arrancar.`;

function parseArgs(argv) {
  const o = { target: null, port: 8871, host: '127.0.0.1', report: null, strict: false, maxBody: 2 * 1024 * 1024, preserveHost: false, quiet: false };
  const value = (i) => { if (argv[i + 1] === undefined) usage(`${argv[i]} necesita un valor.`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--target') o.target = value(i++);
    else if (a === '--port') o.port = Number(value(i++));
    else if (a === '--host') o.host = value(i++);
    else if (a === '--report') o.report = value(i++);
    else if (a === '--strict') o.strict = true;
    else if (a === '--max-body') o.maxBody = Number(value(i++));
    else if (a === '--preserve-host') o.preserveHost = true;
    else if (a === '--quiet') o.quiet = true;
    else usage(`Opción desconocida: ${a}`);
  }
  if (!o.target) usage('Falta --target.');
  try { o.target = new URL(o.target); } catch { usage(`--target no es una URL: ${o.target}`); }
  if (!['http:', 'https:'].includes(o.target.protocol)) usage('--target tiene que ser http o https.');
  if (!o.target.pathname.endsWith('/')) o.target.pathname += '/';
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) usage('--port tiene que ser un número de puerto.');
  if (!Number.isInteger(o.maxBody) || o.maxBody < 0) usage('--max-body tiene que ser un número de bytes.');
  return o;
}
function usage(msg) { console.error(`${msg}\n\n${HELP}`); process.exit(2); }

// ── Estado ────────────────────────────────────────────────────────────────────
let opts, target, rootPath;
let disc = null; // documento de descubrimiento vigente
let announced = ['core'];
let routes = []; // colecciones del descubrimiento, con sus expresiones regulares
const stats = { started: new Date(), exchanges: 0, analysed: 0, byClass: {}, upstreamErrors: 0, replaced: 0 };
const groups = new Map(); // comprobación + método + ruta → grupo
const etags = new Map(); // ruta de elemento → { current, old: Set }
const writeSeq = new Map(); // ruta → escrituras empezadas
const inflight = new Map(); // ruta → escrituras en curso
const idem = new Map(); // ámbito de Idempotency-Key → { print, status, body, replay, expires, pending }

const has = (p) => announced.includes(p);
const joinRoot = (p) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) { try { return new URL(p).pathname; } catch { return p; } }
  return rootPath.replace(/\/$/, '') + (p.startsWith('/') ? p : `/${p}`);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setDiscovery(doc) {
  disc = doc;
  announced = ['core', ...(Array.isArray(doc.profiles) ? doc.profiles : []), ...(Array.isArray(doc.extensions) ? doc.extensions : [])]
    .filter((p, i, a) => typeof p === 'string' && a.indexOf(p) === i);
  routes = [];
  for (const [name, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string') continue;
    const full = joinRoot(c.path);
    const src = full.replace(/\/$/, '').split(/(\{[^}]*\})/).map((p) => (p.startsWith('{') ? '[^/]+' : escapeRe(p))).join('');
    routes.push({ name, c, label: c.path, coll: new RegExp(`^${src}$`), item: new RegExp(`^${src}/([^/]+)$`),
      action: new RegExp(`^${src}(?:/([^/]+))?(?::|%3[aA])([^/:]+)$`) });
  }
  // Las más largas primero, para que una subcolección gane a un elemento de su padre.
  routes.sort((a, b) => b.coll.source.length - a.coll.source.length);
}
function statusPath() {
  if (typeof disc?.status !== 'string') return null;
  try { const u = new URL(disc.status, target); return u.origin === target.origin ? u.pathname : null; } catch { return null; }
}
const metadataPath = () => `/.well-known/oauth-protected-resource${rootPath === '/' ? '' : rootPath}`;

// Qué es una ruta: discovery, status, metadata (fuera de la API), collection, item, action u other.
function classify(pathname) {
  if (pathname === rootPath || pathname === rootPath.replace(/\/$/, '')) return { kind: 'discovery', label: '/' };
  if (pathname === statusPath()) return { kind: 'status', label: pathname };
  if (pathname === metadataPath() || pathname.startsWith('/.well-known/')) return { kind: 'metadata', label: pathname };
  for (const r of routes) {
    let m;
    if ((m = r.action.exec(pathname))) return { kind: 'action', r, id: m[1], action: m[2], label: `${r.label}${m[1] ? '/{id}' : ''}:${m[2]}` };
    if (r.coll.test(pathname)) return { kind: 'collection', r, label: r.label };
    if ((m = r.item.exec(pathname))) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch {}
      return { kind: 'item', r, id, label: `${r.label.replace(/\/$/, '')}/{id}` };
    }
  }
  return { kind: 'other', label: '(otra ruta)' };
}

// ── Registro de violaciones ───────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
const log = (s) => { if (!opts.quiet) console.log(s); };
const REMIND = new Set([10, 100, 1000, 10000, 100000]);

function record(ex, f) {
  const [section, level] = CHECKS[f.id];
  const key = `${f.id}\u0000${ex.method} ${ex.route.label}`;
  const when = new Date().toISOString();
  const sample = { time: when, request: `${ex.method} ${ex.url}`, status: ex.status, message: f.msg };
  let g = groups.get(key);
  if (!g) {
    g = { check: f.id, section, level, description: CHECKS[f.id][2], spec: sectionUrl(section), method: ex.method,
      route: ex.route.label, count: 0, first: sample, last: sample };
    groups.set(key, g);
  }
  g.count++;
  g.last = sample;
  const tag = level === 'DEBE' ? paint('1;31', 'VIOLACIÓN') : paint(33, 'AVISO    ');
  if (g.count === 1) {
    log(`${paint(90, clock())} ${tag} ${f.id} (${section}, ${level})  ${ex.method} ${ex.route.label}`);
    log(`${' '.repeat(19)}${ex.method} ${ex.url} → ${ex.status}: ${f.msg}`);
  } else if (REMIND.has(g.count)) {
    log(`${paint(90, clock())} ${paint(90, `… ${f.id}  ${ex.method} ${ex.route.label}: ya van ${g.count}`)}`);
  }
}
const totals = () => {
  let violations = 0, warnings = 0;
  for (const g of groups.values()) if (g.level === 'DEBE') violations += g.count; else warnings += g.count;
  return { violations, warnings };
};
const sortedGroups = () => [...groups.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'DEBE' ? -1 : 1));

export function report() {
  const t = totals();
  return {
    tool: 'restep-proxy', version: VERSION, spec: SPEC, target: target.href, strict: opts.strict,
    started: stats.started.toISOString(), finished: new Date().toISOString(),
    discovery: disc ? { restep: disc.restep, profiles: disc.profiles ?? [], extensions: disc.extensions ?? [], collections: routes.map((r) => r.name) } : null,
    exchanges: stats.exchanges, analysed: stats.analysed, by_status: stats.byClass, upstream_errors: stats.upstreamErrors,
    replaced: stats.replaced, violations: t.violations, warnings: t.warnings,
    groups: sortedGroups(),
  };
}

// ── Análisis de un intercambio ────────────────────────────────────────────────
// ex: { method, url, pathname, params, reqHeaders, reqBody, reqJson, status, resHeaders, data, size, bodyError, route, pre }
function analyze(ex) {
  const out = [];
  const bad = (id, msg) => out.push({ id, msg });
  const r = ex.route, rh = ex.resHeaders, q = ex.reqHeaders;
  const s = ex.status, ok = s >= 200 && s < 300;
  const read = ex.method === 'GET' || ex.method === 'HEAD';
  const api = r.kind !== 'status' && r.kind !== 'metadata';
  const hasBody = ex.size > 0 && ex.method !== 'HEAD' && s !== 204 && s !== 304;
  const d = ex.data;

  // 3: JSON válido.
  if (hasBody && isJsonType(mediaType(rh['content-type'])) && ex.bodyError) bad('json', ex.bodyError);

  // 4.4: el recurso de status, fuera de la API.
  if (r.kind === 'status') {
    if (read && ![200, 503, 401, 403, 429].includes(s)) bad('health', `${s}; se esperaba 200 o 503 (o 401, 403, 429)`);
    if (read && (s === 200 || s === 503) && !/\bno-store\b/i.test(rh['cache-control'] ?? ''))
      bad('health', `Cache-Control: ${rh['cache-control'] ?? '(ninguno)'}; se esperaba no-store`);
    return out;
  }
  if (r.kind === 'metadata') return out;

  // 4.1: cabecera de perfil.
  if (s !== 304 && disc) {
    const links = linkTargets(rh.link, 'profile');
    const missing = announced.filter((p) => !links.includes(`${SPEC}${p}`));
    if (missing.length) bad('profile-link', `faltan enlaces de perfil: ${missing.join(', ')}`);
  }
  // 7.3: Cache-Control en toda respuesta a GET o HEAD; private o no-store con credenciales.
  if (read && has('writes') && !rh['cache-control']) bad('cache-control', 'sin Cache-Control');
  if (read && q.authorization && rh['cache-control'] && !/\b(private|no-store)\b/i.test(rh['cache-control']))
    bad('cache-private', `petición con Authorization y Cache-Control: ${rh['cache-control']}`);

  if (s >= 400) errorChecks(ex, bad);
  else if (ok && isObject(d) && typeof d.code === 'string' && typeof d.type === 'string' && Number.isInteger(d.status) && d.status >= 400)
    bad('no-error-in-200', `un objeto problem (code ${d.code}) dentro de un ${s}`);

  if (r.kind === 'collection' || r.kind === 'item') {
    resourceChecks(ex, bad);
    reservedChecks(ex, bad);
    if (has('writes')) writesChecks(ex, bad);
  } else if (r.kind === 'discovery' && ok && [...ex.params].length) {
    for (const k of new Set(ex.params.keys())) if (isReservedName(k)) bad('reserved', `${k} en la raíz se ha ignorado; se esperaba 400 unsupported_parameter`);
  }
  if (has('writes') && ex.method === 'POST' && r.kind !== 'discovery') idempotencyChecks(ex, bad);
  deprecationChecks(ex, bad);
  return out;
}

const baseName = (k) => k.replace(/\[.*$/, '');
const isReservedName = (k) => RESERVED.includes(baseName(k)) || k.startsWith('$');

function errorChecks(ex, bad) {
  const rh = ex.resHeaders, s = ex.status;
  if (s === 401 && !rh['www-authenticate']) bad('error.401', 'sin WWW-Authenticate');
  if (s === 405 && !rh.allow) bad('error.405', 'sin Allow');
  if ((s === 429 || s === 503) && !rh['retry-after']) bad('error.retry-after', 'sin Retry-After');
  if (ex.method === 'HEAD' || !ex.size) return;
  const t = mediaType(rh['content-type']);
  if (t !== 'application/problem+json') bad('error.media-type', `Content-Type: ${t || '(ninguno)'}`);
  const d = ex.data;
  if (!isObject(d)) { if (!ex.bodyError) bad('error.schema', 'el cuerpo no es un objeto JSON'); return; }
  const problems = schemaErrors(PROBLEM_SCHEMA, d);
  if (problems.length) bad('error.schema', problems.slice(0, 4).join('; '));
  if (d.status !== undefined && d.status !== s) bad('error.status', `status ${JSON.stringify(d.status)} en una respuesta ${s}`);
  if (typeof d.code === 'string') {
    const codes = expectedCodes(s);
    if (!codes.includes(d.code)) bad('error.code', `code "${d.code}" para ${s}; se esperaba ${codes.join(' o ')}`);
    if (typeof d.type === 'string' && !(d.type === 'about:blank' || (/^[a-z][a-z0-9+.-]*:/i.test(d.type)
      && (!d.type.startsWith(`${SPEC}errors#`) || d.type === `${SPEC}errors#${d.code}`))))
      bad('error.type', `type ${d.type} para code ${d.code}`);
  }
  if (!(typeof d.detail === 'string' && d.detail)) bad('error.detail', 'sin detail');
  if (d.code === 'invalid_parameter' || d.code === 'unsupported_parameter') {
    if (!(typeof d.parameter === 'string' && d.parameter)) bad('error.parameter', `${d.code} sin parameter`);
    else if (d.code === 'unsupported_parameter' && ex.method !== 'QUERY' && !ex.params.has(d.parameter))
      bad('error.parameter', `parameter "${d.parameter}" no es ninguno de los que llegaron (${[...new Set(ex.params.keys())].join(', ') || 'ninguno'})`);
  }
}

// La declaración de filtro de un campo, o undefined.
const filterDecl = (c, f) => (isObject(c.filter) && isObject(c.filter[f]) ? c.filter[f] : undefined);
const opsOf = (d) => (Array.isArray(d?.ops) ? d.ops : []);
const parseFilterKey = (k) => { const m = k.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/); return m ? { field: m[1], op: m[2] ?? 'eq' } : null; };
// Si el valor de un filtro encaja con su tipo (6.1), para saber si un rechazo es legítimo.
function filterValueOk(decl, op, raw) {
  if (op === 'null') return raw === 'true' || raw === 'false';
  if (op === 'in') return raw !== '' && raw.split(',').every((v) => v !== '' && norm(decl.type, v) !== undefined && enumOk(decl, v));
  return norm(decl.type, raw) !== undefined && enumOk(decl, raw);
}
const enumOk = (decl, v) => decl.type !== 'enum' || !Array.isArray(decl.values) || decl.values.includes(v);
const once = (params, k) => params.getAll(k).length === 1;

// 5.3: qué parámetros reservados implementa este recurso con este método.
function implemented(r, method) {
  const out = new Set();
  if (method !== 'GET' && method !== 'HEAD') return out;
  const c = r.r.c;
  if (has('query')) {
    out.add('fields');
    if (r.kind === 'collection') {
      out.add('limit'); out.add('cursor');
      if (isObject(c.filter) && Object.keys(c.filter).length) out.add('filter');
      if (Array.isArray(c.sort) && c.sort.length) out.add('sort');
      if (c.count) out.add('count');
    }
  }
  if (has('relations') && isObject(c.relations) && Object.values(c.relations).some((x) => x?.include)) out.add('include');
  return out;
}

function reservedChecks(ex, bad) {
  const r = ex.route, c = r.r.c, p = ex.params, s = ex.status, ok = s >= 200 && s < 300;
  if (ex.method === 'QUERY') return;
  const impl = implemented(r, ex.method);
  const keys = [...new Set(p.keys())];
  // Éxito con algo que debía fallar en voz alta.
  if (ok) {
    for (const k of keys) {
      if (!isReservedName(k)) continue;
      const base = baseName(k);
      const formOk = k.startsWith('$') ? false : base === 'filter' ? (k !== 'filter' || has('filter-expr')) : k === base;
      if (!impl.has(base) || !formOk) { bad('reserved', `${k} se ha ignorado; se esperaba 400 unsupported_parameter`); continue; }
      if (base === 'filter' && k !== 'filter') {
        const f = parseFilterKey(k);
        const decl = f && filterDecl(c, f.field);
        if (!f) bad('query.undeclared', `${k} no es filter[campo] ni filter[campo][op] y se ha aceptado`);
        else if (!decl) bad('query.undeclared', `el campo ${f.field} no está declarado en filter y se ha aceptado`);
        else if (!opsOf(decl).includes(f.op)) bad('query.undeclared', `${f.field} no declara el operador ${f.op} y se ha aceptado`);
      }
    }
    if (impl.has('sort') && once(p, 'sort')) {
      const undeclared = p.get('sort').split(',').map((x) => x.replace(/^-/, '')).filter((f) => f && !c.sort.includes(f));
      if (undeclared.length) bad('query.undeclared', `sort por ${undeclared.join(', ')}, que no está declarado, se ha aceptado`);
    }
    return;
  }
  // Rechazo, como no admitido, de algo declarado.
  if (s !== 400 || ex.data?.code !== 'unsupported_parameter' || typeof ex.data.parameter !== 'string') return;
  const k = ex.data.parameter, base = baseName(k);
  if (!impl.has(base) || !p.has(k) || !once(p, k)) return;
  const retired = retiredNames(c);
  if (base === 'filter' && k !== 'filter') {
    const f = parseFilterKey(k), decl = f && filterDecl(c, f.field);
    if (!decl || !opsOf(decl).includes(f.op) || retired.filter.has(f.field)) return;
    const dupe = keys.filter((x) => { const g = parseFilterKey(x); return g && g.field === f.field && g.op === f.op; }).length > 1;
    if (!dupe && filterValueOk(decl, f.op, p.get(k))) bad('query.declared-rejected', `${k}=${p.get(k)} está declarado y se ha rechazado con unsupported_parameter`);
  } else if (base === 'sort' && k === 'sort') {
    const fs = p.get('sort').split(',').map((x) => x.replace(/^-/, ''));
    if (fs.every((f) => f && c.sort.includes(f) && !retired.sort.has(f))) bad('query.declared-rejected', `sort=${p.get('sort')} está declarado y se ha rechazado con unsupported_parameter`);
  } else if (k === 'count') {
    if (p.get('count') === 'true' || p.get('count') === 'false') bad('query.declared-rejected', `count=${p.get('count')} con count declarado (${c.count}) se ha rechazado con unsupported_parameter`);
  } else if (k === 'limit' || k === 'cursor' || (k === 'fields' && !p.get('fields').includes('.'))) {
    bad('query.declared-rejected', `${k} es de query, que el servidor anuncia, y se ha rechazado con unsupported_parameter`);
  }
}

function resourceChecks(ex, bad) {
  const r = ex.route, c = r.r.c, p = ex.params, s = ex.status, ok = s >= 200 && s < 300, d = ex.data, m = ex.method;
  const minimal = /(^|[\s,;])return=minimal\b/i.test(ex.reqHeaders.prefer ?? '');
  const declared = r.kind === 'collection' ? c.methods : c.item_methods;

  // 4.3: Allow coincide con los métodos declarados.
  if (Array.isArray(declared)) {
    if (s === 405 && ex.resHeaders.allow) {
      const allow = ex.resHeaders.allow.split(',').map((x) => x.trim().toUpperCase()).filter((x) => FOUR.includes(x));
      const missing = declared.filter((x) => !allow.includes(x)), extra = allow.filter((x) => !declared.includes(x));
      if (missing.length || extra.length) bad('allow', `Allow: ${ex.resHeaders.allow}; declarados ${declared.join(', ')}`);
    }
    if (s === 405 && declared.includes(m === 'HEAD' ? 'GET' : m)) bad('allow', `${m} está declarado y ha dado 405`);
  }

  // 5.1: estados de éxito.
  if (ok) {
    const want = m === 'GET' || m === 'HEAD' ? [200] : m === 'POST' && r.kind === 'collection' ? [201]
      : m === 'PATCH' && r.kind === 'item' ? (minimal ? [200, 204] : [200]) : m === 'DELETE' && r.kind === 'item' ? [204] : null;
    if (want && !want.includes(s)) bad('status.success', `${m} ha dado ${s}; se esperaba ${want.join(' o ')}`);
  }
  // 5.1: Location de un 201 y el id lo asigna el servidor.
  if (m === 'POST' && r.kind === 'collection') {
    if (s === 201) {
      const loc = ex.resHeaders.location;
      if (!loc) bad('location', '201 sin Location');
      else if (isObject(d) && typeof d.id === 'string') {
        let path = loc;
        try { path = decodeURIComponent(new URL(loc, target).pathname); } catch {}
        const want = `${decodeURIComponent(ex.pathname).replace(/\/$/, '')}/${d.id}`;
        if (path !== want) bad('location', `Location: ${loc}; se esperaba ${want}`);
      }
    }
    if (ok && isObject(ex.reqJson) && 'id' in ex.reqJson) bad('id.assigned', `un POST con "id": ${JSON.stringify(ex.reqJson.id)} ha dado ${s}; se esperaba 422 invalid`);
  }
  if (m === 'PATCH' && r.kind === 'item' && ok) {
    if (ex.reqJsonParsed && !isObject(ex.reqJson)) bad('patch.object', `un parche ${Array.isArray(ex.reqJson) ? 'que es una lista' : 'que no es un objeto'} ha dado ${s}; se esperaba 400 bad_request`);
    else if (ex.reqJsonInvalid) bad('patch.object', `un parche que no es JSON ha dado ${s}; se esperaba 400 bad_request`);
    if (isObject(ex.reqJson) && 'id' in ex.reqJson && ex.reqJson.id !== r.id) bad('id.assigned', `un PATCH con "id": ${JSON.stringify(ex.reqJson.id)} a ${r.id} ha dado ${s}; se esperaba 422 invalid`);
  }

  if (!ok || !isObject(d)) return;
  const fields = once(p, 'fields') && has('query') && (m === 'GET' || m === 'HEAD') ? p.get('fields').split(',') : null;
  let items = [];
  if (r.kind === 'collection' && (m === 'GET')) {
    // 5.2: forma de colección.
    if (!Array.isArray(d.items) || !('next' in d)) { bad('collection.shape', `el cuerpo no es {items, next}${Array.isArray(d.items) ? ': falta next' : ''}`); return; }
    if (!(d.next === null || typeof d.next === 'string')) { bad('collection.shape', `next es ${JSON.stringify(d.next)}, no una cadena ni null`); return; }
    items = d.items.filter(isObject);
    if (typeof d.next === 'string') nextChecks(ex, d.next, bad);
    if (has('query')) queryChecks(ex, items, fields, bad);
  } else if (r.kind === 'item' && m !== 'DELETE') items = [d];
  else return;

  // 6.3: fields.
  if (fields) {
    const allowed = new Set(['id', ...fields.map((f) => f.split('.')[0])]);
    for (const it of items) {
      const extra = Object.keys(it).filter((k) => !allowed.has(k) && !k.startsWith('_'));
      if (extra.length) { bad('fields', `fields=${p.get('fields')} y el elemento ${it.id} trae además ${extra.slice(0, 5).join(', ')}`); break; }
    }
  }
  // 3, 4.2, 5.7: coherencia con el descubrimiento.
  for (const it of items) {
    const problems = itemProblems(c, it, !!fields || p.has('include'));
    if (problems.length) { bad('item.discovery', problems.slice(0, 3).join('; ')); break; }
  }
}

// 6.4: next conserva los parámetros y lleva cursor.
function nextChecks(ex, next, bad) {
  if (!(/^[a-z][a-z0-9+.-]*:/i.test(next) || (next.startsWith('/') && !next.startsWith('//')))) {
    bad('links', `next ${next} no es ni una URI absoluta ni una ruta absoluta`);
    return;
  }
  if (next.startsWith('/') && rootPath !== '/' && !next.startsWith(rootPath)) bad('links', `next ${next} no incluye la ruta de la raíz ${rootPath}`);
  if (!has('query') || ex.method === 'QUERY') return;
  let u;
  try { u = new URL(next, target); } catch { return bad('links', `next ${next} no es una URL`); }
  if (!u.searchParams.has('cursor')) bad('next', `next ${next} no lleva cursor`);
  const pairs = (sp) => [...sp].filter(([k]) => k !== 'cursor').map(([k, v]) => `${k}=${v}`).sort().join('&');
  const want = pairs(ex.params), got = pairs(u.searchParams);
  if (want !== got) bad('next', `next cambia los parámetros: «${got || '(ninguno)'}» en vez de «${want || '(ninguno)'}»`);
  else if (u.pathname !== ex.pathname) bad('next', `next apunta a ${u.pathname}, no a ${ex.pathname}`);
}

function queryChecks(ex, items, fields, bad) {
  const c = ex.route.r.c, p = ex.params, d = ex.data;
  const shown = (f) => !fields || fields.some((x) => x.split('.')[0] === f.split('.')[0]);
  // 6.1: cada elemento cumple cada filtro.
  for (const [k, raw] of p) {
    const f = parseFilterKey(k);
    const decl = f && filterDecl(c, f.field);
    if (!decl || !opsOf(decl).includes(f.op) || !shown(f.field) || !filterValueOk(decl, f.op, raw)) continue;
    const miss = items.find((it) => !matches(decl.type, f.op, get(it, f.field), raw));
    if (miss) bad('filter.match', `${k}=${raw} y el elemento ${miss.id} tiene ${f.field} = ${JSON.stringify(get(miss, f.field)) ?? '(ausente)'}`);
  }
  // 6.2: orden dentro de la página.
  if (once(p, 'sort') && Array.isArray(c.sort)) {
    const keys = p.get('sort').split(',').map((x) => ({ desc: x.startsWith('-'), f: x.replace(/^-/, '') }));
    if (keys.every((k) => k.f && c.sort.includes(k.f) && shown(k.f))) {
      const types = keys.map((k) => filterDecl(c, k.f)?.type ?? inferType(items, k.f));
      const order = (a, b) => {
        for (let i = 0; i < keys.length; i++) {
          if (!types[i]) return 0; // sin tipo conocido no se puede juzgar
          const x = get(a, keys[i].f), y = get(b, keys[i].f);
          if (blank(x) && blank(y)) continue;
          if (blank(x) || blank(y)) return blank(x) ? 1 : -1; // sin valor, al final en los dos sentidos
          const nx = norm(types[i], x), ny = norm(types[i], y);
          if (nx === undefined || ny === undefined) return 0;
          const v = cmp(types[i], nx, ny) * (keys[i].desc ? -1 : 1);
          if (v) return v;
        }
        return 0;
      };
      for (let i = 1; i < items.length; i++) {
        if (order(items[i - 1], items[i]) > 0) { bad('sort.order', `sort=${p.get('sort')}: ${items[i - 1].id} va antes que ${items[i].id}`); break; }
      }
    }
  }
  // 6.4: limit.
  if (p.has('limit')) {
    const raw = p.get('limit'), n = Number(raw), max = Number.isInteger(c.max_limit) ? c.max_limit : Infinity;
    if (!once(p, 'limit')) bad('limit', 'limit repetido y aceptado; se esperaba invalid_parameter');
    else if (!/^\d+$/.test(raw) || n < 1 || n > max) bad('limit', `limit=${raw} fuera de 1..${c.max_limit ?? '∞'} y aceptado; se esperaba invalid_parameter`);
    else if (items.length > n) bad('limit', `limit=${n} y la página trae ${items.length} elementos`);
  }
  // 6.5: count.
  if (p.get('count') === 'true') {
    if (!c.count) { /* lo señala reserved */ } else if (!(Number.isInteger(d.total) && d.total >= 0)) bad('count', `count=true y total es ${JSON.stringify(d.total) ?? '(ausente)'}`);
    else if (c.count === 'exact' && d.total_estimated === true) bad('count', 'count declarado exact y la respuesta dice total_estimated: true');
  }
}
// El tipo de un campo de orden no declarado en filter, si los valores lo dejan claro.
function inferType(items, f) {
  const vals = items.map((it) => get(it, f)).filter((v) => !blank(v));
  if (vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.every((v) => typeof v === 'string') && !vals.every((v) => DECIMAL.test(v))) return 'string';
  return null;
}

// 3, 4.2 y 5.7: lo que el descubrimiento dice de un elemento.
function itemProblems(c, it, partial) {
  const out = [];
  const id = it.id ?? '?';
  for (const [f, decl] of Object.entries(isObject(c.filter) ? c.filter : {})) {
    if (!isObject(decl) || !decl.type) continue;
    const v = get(it, f);
    if (!blank(v) && !fitsType(decl, v)) out.push(`${id}.${f} = ${JSON.stringify(v)} no es de tipo ${decl.type}${decl.type === 'enum' && Array.isArray(decl.values) ? ` (${decl.values.join(', ')})` : ''}`);
  }
  for (const f of Object.keys(isObject(c.language_maps) ? c.language_maps : {})) {
    if (!(f in it)) continue;
    const v = it[f];
    if (!isObject(v)) out.push(`${id}.${f} es un mapa de idioma y vale ${JSON.stringify(v)}`);
    else for (const [k, s] of Object.entries(v)) if (!TAG.test(k) || typeof s !== 'string') { out.push(`${id}.${f}.${k} no es una traducción válida (etiqueta en minúsculas y cadena)`); break; }
  }
  for (const [rel, decl] of Object.entries(isObject(c.relations) ? c.relations : {})) {
    if (!(rel in it) || it[rel] === null) continue;
    const v = it[rel], isLink = (x) => isObject(x) && typeof x.id === 'string';
    if (decl?.many ? !(Array.isArray(v) && v.every(isLink)) && !isLink(v) : !isLink(v)) out.push(`${id}.${rel} es una relación y vale ${JSON.stringify(v).slice(0, 60)}`);
  }
  if (!partial) for (const [f, rule] of Object.entries(isObject(c.inherit) ? c.inherit : {})) {
    if (!isObject(rule) || typeof rule.own !== 'string' || (!(f in it) && !(rule.own in it))) continue;
    if (!(rule.own in it)) { out.push(`${id} trae ${f} pero no su campo propio ${rule.own}`); continue; }
    const own = it[rule.own], eff = it[f];
    const same = typeof own === 'string' && typeof eff === 'string' && DECIMAL.test(own) && DECIMAL.test(eff) ? cmpDecimal(own, eff) === 0 : canonical(own) === canonical(eff);
    if (!blank(own) && !same) out.push(`${id}.${f} vale ${JSON.stringify(eff)} pero su valor propio es ${JSON.stringify(own)}`);
    const why = it._inherited;
    if (isObject(why) && !blank(own) && f in why) out.push(`${id}._inherited nombra ${f}, que tiene valor propio`);
    if (isObject(why) && blank(own) && f in it && !(f in why)) out.push(`${id}._inherited no nombra ${f}, que es heredado`);
  }
  return out;
}

function writesChecks(ex, bad) {
  const r = ex.route, p = ex.params, s = ex.status, ok = s >= 200 && s < 300, m = ex.method, rh = ex.resHeaders, q = ex.reqHeaders, d = ex.data;
  const write = !['GET', 'HEAD', 'QUERY', 'OPTIONS'].includes(m);
  // 7.2: ETag de elemento.
  if (r.kind === 'item' && m === 'GET' && s === 200) {
    const partial = p.has('fields') || p.has('include');
    const encoded = rh['content-encoding'] && rh['content-encoding'].toLowerCase() !== 'identity';
    if (!partial && !encoded) {
      if (!rh.etag) bad('etag', 'el GET del elemento completo no lleva ETag');
      else if (rh.etag.startsWith('W/')) bad('etag', `la ETag de elemento es débil: ${rh.etag}`);
    } else if (isObject(d) && typeof d._etag !== 'string') bad('etag', `${partial ? 'con fields o include' : `con Content-Encoding: ${rh['content-encoding']}`} el elemento no lleva _etag`);
  }
  // 7.3: If-None-Match que coincide con la representación da 304.
  if ((m === 'GET' || m === 'HEAD') && s === 200 && q['if-none-match'] && rh.etag) {
    const list = etagList(q['if-none-match']);
    if (list.some((t) => t === '*' || weakEq(t, rh.etag))) bad('if-none-match', `If-None-Match: ${q['if-none-match']} coincide con la ETag ${rh.etag} y la respuesta es 200, no 304`);
  }
  // 7.2: 412 y 428 con sentido.
  if (s === 412 && !q['if-match'] && !q['if-none-match'] && !q['if-unmodified-since']) bad('precondition', '412 sin ninguna cabecera condicional en la petición');
  if (s === 428 && q['if-match']) bad('precondition', `428 a una petición que lleva If-Match: ${q['if-match']}`);
  if (s === 428 && !write) bad('precondition', `428 a un ${m}, que no es una escritura`);
  // 7.2: If-Match y If-None-Match contra la ETag de elemento que el proxy ha visto.
  const pre = ex.pre;
  if (r.kind === 'item' && (m === 'PATCH' || m === 'DELETE') && pre.etag && !pre.concurrent && writeSeq.get(ex.pathname) === pre.seq) {
    const { current, old } = pre.etag;
    if (q['if-match'] && !etagList(q['if-match']).includes('*')) {
      const list = etagList(q['if-match']);
      if (list.includes(current) && s === 412) bad('if-match', `If-Match: ${q['if-match']} contiene la ETag vigente ${current} y ha dado 412`);
      if (!list.includes(current) && list.some((t) => old.has(t)) && ok) bad('if-match', `If-Match: ${q['if-match']} es una ETag antigua (la vigente es ${current}) y ha dado ${s}; se esperaba 412`);
    }
    if (q['if-none-match'] && ok && etagList(q['if-none-match']).some((t) => t === '*' || weakEq(t, current)))
      bad('if-none-match', `If-None-Match: ${q['if-none-match']} coincide con la ETag vigente ${current} y la escritura ha dado ${s}; se esperaba 412`);
  }
  // 7.4: respuesta mínima.
  if (/(^|[\s,;])return=minimal\b/i.test(q.prefer ?? '') && write && ok && !ex.size) {
    const missing = [];
    if (s !== 204 || m !== 'DELETE') { if (!rh.etag) missing.push('ETag'); }
    if (s === 201 && !rh.location) missing.push('Location');
    if (!rh['preference-applied']) missing.push('Preference-Applied');
    if (missing.length) bad('minimal', `respuesta mínima ${s} sin ${missing.join(', ')}`);
  }
}

// 7.1: Idempotency-Key.
const SF_STRING = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/;
function idempotencyChecks(ex, bad) {
  const raw = ex.reqHeaders['idempotency-key'];
  if (raw === undefined) return;
  const s = ex.status, ok = s >= 200 && s < 300;
  if (!SF_STRING.test(raw.trim())) {
    if (ok) bad('idempotency.key', `Idempotency-Key: ${raw} no es una cadena de Structured Fields y ha dado ${s}; se esperaba 400 bad_request`);
    return;
  }
  const prev = ex.pre.idem;
  if (!prev || prev.pending || prev.status === undefined || !(prev.status >= 200 && prev.status < 300)) return;
  if (ex.pre.idemPrint === prev.print) {
    const body = ex.data !== undefined ? canonical(ex.data) : ex.size ? `bytes:${ex.size}` : '';
    if (s !== prev.status) bad('idempotency.replay', `la repetición ha dado ${s}; la primera, ${prev.status}`);
    else if (body !== prev.body) bad('idempotency.replay', 'la repetición devuelve otro cuerpo que la primera');
    else if (ex.resHeaders['idempotent-replayed'] !== 'true') bad('idempotency.replayed-header', 'la repetición no lleva Idempotent-Replayed: true');
  } else if (ok) bad('idempotency.mismatch', `la misma Idempotency-Key con otro cuerpo ha dado ${s}; se esperaba 422 idempotency_mismatch`);
}

// 5.5: retiradas declaradas en el descubrimiento.
function deprecationsFor(c) {
  const out = [];
  for (const x of Array.isArray(disc?.deprecations) ? disc.deprecations : []) if (isObject(x)) out.push({ ...x, scope: 'root' });
  for (const x of Array.isArray(c?.deprecations) ? c.deprecations : []) if (isObject(x)) out.push({ ...x, scope: 'collection' });
  return out;
}
const passed = (x) => typeof x.sunset === 'string' && Date.parse(x.sunset) <= Date.now();
function retiredNames(c) {
  const out = { filter: new Set(), sort: new Set() };
  for (const x of deprecationsFor(c)) if (passed(x) && (x.kind === 'filter' || x.kind === 'sort')) out[x.kind].add(x.name);
  return out;
}
function deprecationChecks(ex, bad) {
  const r = ex.route;
  if (!disc || r.kind === 'other') return;
  const c = r.r?.c, p = ex.params, s = ex.status, ok = s >= 200 && s < 300;
  const filterFields = [...p.keys()].map(parseFilterKey).filter(Boolean).map((f) => f.field);
  const sortFields = once(p, 'sort') ? p.get('sort').split(',').map((x) => x.replace(/^-/, '')) : [];
  const includes = once(p, 'include') ? p.get('include').split(',').map((x) => x.split('.')[0]) : [];
  for (const x of deprecationsFor(c)) {
    const used = x.kind === 'version' ? true
      : x.kind === 'collection' ? x.scope === 'root' && r.r?.name === x.name
      : !c || x.scope !== 'collection' ? false
      : x.kind === 'method' ? r.kind === 'collection' && ex.method === x.name
      : x.kind === 'item_method' ? r.kind === 'item' && ex.method === x.name
      : x.kind === 'filter' ? filterFields.includes(x.name)
      : x.kind === 'sort' ? sortFields.includes(x.name)
      : x.kind === 'relation' ? includes.includes(x.name)
      : x.kind === 'action' ? r.kind === 'action' && r.action === x.name : false;
    if (!used) continue;
    const what = `${x.kind}${x.name ? ` ${x.name}` : ''}`;
    if (!passed(x)) {
      if (!ok) continue;
      if (!ex.resHeaders.deprecation) bad('deprecation', `usa ${what}, retirado en el descubrimiento, y la respuesta no lleva Deprecation`);
      else if (['version', 'collection', 'action'].includes(x.kind) && x.sunset && !ex.resHeaders.sunset) bad('deprecation', `usa ${what}, con fecha de retirada ${x.sunset}, y la respuesta no lleva Sunset`);
    } else if (ok) {
      const want = ['version', 'collection', 'action'].includes(x.kind) ? '410 retired' : x.kind.endsWith('method') ? '405' : '400 unsupported_parameter';
      bad('deprecation', `usa ${what}, retirado el ${x.sunset}, y ha dado ${s}; se esperaba ${want}`);
    }
  }
}

// ── Estado que se aprende del tráfico ─────────────────────────────────────────
function prepare(ex) {
  const write = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(ex.method);
  const e = etags.get(ex.pathname);
  ex.pre = { etag: e ? { current: e.current, old: new Set(e.old) } : null, concurrent: (inflight.get(ex.pathname) ?? 0) > 0 };
  if (write) {
    ex.pre.seq = (writeSeq.get(ex.pathname) ?? 0) + 1;
    writeSeq.set(ex.pathname, ex.pre.seq);
    inflight.set(ex.pathname, (inflight.get(ex.pathname) ?? 0) + 1);
    ex.isWrite = true;
  }
}
// Se llama cuando ha llegado el cuerpo entero de la petición.
function prepareBody(ex) {
  if (ex.reqBody && ex.reqBody.length) {
    try { ex.reqJson = JSON.parse(ex.reqBody.toString('utf8')); ex.reqJsonParsed = true; } catch { ex.reqJsonInvalid = isJsonType(mediaType(ex.reqHeaders['content-type'])); }
  }
  const raw = ex.reqHeaders['idempotency-key'];
  if (ex.method !== 'POST' || raw === undefined || !SF_STRING.test(raw.trim())) return;
  const scope = `${hash(ex.reqHeaders.authorization ?? '')} ${ex.method} ${ex.pathname}${[...ex.params].length ? `?${ex.params}` : ''} ${raw.trim()}`;
  ex.idemScope = scope;
  ex.pre.idemPrint = hash(ex.reqJsonParsed ? canonical(ex.reqJson) : (ex.reqBody ?? Buffer.alloc(0)).toString('base64'));
  const saved = idem.get(scope);
  const live = saved && (saved.pending || saved.expires > Date.now()) ? saved : null;
  ex.pre.idem = live ? { ...live } : null;
  if (!live) idem.set(scope, { pending: true, print: ex.pre.idemPrint, owner: ex });
}
function learn(ex) {
  const r = ex.route, s = ex.status, ok = s >= 200 && s < 300, d = ex.data, rh = ex.resHeaders;
  if (ex.isWrite) inflight.set(ex.pathname, Math.max(0, (inflight.get(ex.pathname) ?? 1) - 1));
  // Descubrimiento que pasa por el proxy.
  if (r.kind === 'discovery' && ex.method === 'GET' && s === 200 && isObject(d) && typeof d.restep === 'string') setDiscovery(d);
  // ETags de elemento (7.2).
  const setTag = (path, tag) => {
    if (typeof tag !== 'string' || tag.startsWith('W/')) return;
    const e = etags.get(path) ?? { current: null, old: new Set() };
    if (e.current && e.current !== tag) e.old.add(e.current);
    e.old.delete(tag);
    e.current = tag;
    etags.set(path, e);
  };
  if (r.kind === 'item' && ok) {
    const partial = ex.params.has('fields') || ex.params.has('include');
    const encoded = rh['content-encoding'] && rh['content-encoding'].toLowerCase() !== 'identity';
    if (ex.method === 'DELETE') etags.delete(ex.pathname);
    else if (isObject(d) && typeof d._etag === 'string') setTag(ex.pathname, d._etag);
    else if ((ex.method === 'GET' && !partial && !encoded) || ex.method === 'PATCH') setTag(ex.pathname, rh.etag);
  }
  if (r.kind === 'collection' && ex.method === 'POST' && s === 201 && rh.location) {
    const tag = isObject(d) && typeof d._etag === 'string' ? d._etag : rh.etag;
    try { if (tag) setTag(new URL(rh.location, target).pathname, tag); } catch {}
  }
  if (r.kind === 'collection' && ex.method === 'GET' && ok && Array.isArray(d?.items))
    for (const it of d.items) if (isObject(it) && typeof it._etag === 'string' && typeof it.id === 'string') setTag(`${ex.pathname.replace(/\/$/, '')}/${encodeURIComponent(it.id)}`, it._etag);
  // Idempotency-Key (7.1): se guarda solo lo que tuvo efecto.
  if (ex.idemScope) {
    const saved = idem.get(ex.idemScope);
    if (saved?.owner === ex) {
      if (ok) {
        const ttl = Number.isFinite(disc?.idempotency?.ttl) ? disc.idempotency.ttl : 86400;
        idem.set(ex.idemScope, { print: saved.print, status: s, body: d !== undefined ? canonical(d) : ex.size ? `bytes:${ex.size}` : '', expires: Date.now() + ttl * 1000 });
      } else idem.delete(ex.idemScope); // un rechazo PUEDE no guardarse: no gasta la clave
    }
  }
}

// ── El proxy ──────────────────────────────────────────────────────────────────
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function hopByHop(connection) { // RFC 9110, 7.6.1: también las que nombra Connection
  const s = new Set(HOP);
  for (const t of String(connection ?? '').split(',')) if (t.trim()) s.add(t.trim().toLowerCase());
  return s;
}
function requestHeaders(req) {
  const drop = hopByHop(req.headers.connection);
  const out = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i], lk = k.toLowerCase(), v = req.rawHeaders[i + 1];
    if (drop.has(lk) || (lk === 'host' && !opts.preserveHost)) continue;
    out[k] = out[k] === undefined ? v : [].concat(out[k], v);
  }
  if (!opts.preserveHost) out.Host = target.host;
  return out;
}
function responseHeaders(upres) {
  const drop = hopByHop(upres.headers.connection);
  const out = [];
  for (let i = 0; i < upres.rawHeaders.length; i += 2) if (!drop.has(upres.rawHeaders[i].toLowerCase())) out.push(upres.rawHeaders[i], upres.rawHeaders[i + 1]);
  return out;
}
function sendProblem(res, status, code, title, detail, extra = {}) {
  const body = JSON.stringify({ type: 'about:blank', title, status, code, detail, ...extra });
  res.writeHead(status, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function decodeBody(ex, raw) {
  const enc = String(ex.resHeaders['content-encoding'] ?? '').trim().toLowerCase();
  let buf = raw;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(raw);
    else if (enc === 'deflate') buf = zlib.inflateSync(raw);
    else if (enc === 'br') buf = zlib.brotliDecompressSync(raw);
    else if (enc && enc !== 'identity') return; // codificación desconocida: no se analiza el cuerpo
  } catch { ex.bodyError = `el cuerpo no se puede descomprimir (Content-Encoding: ${enc})`; return; }
  ex.size = buf.length;
  const t = mediaType(ex.resHeaders['content-type']);
  if (!buf.length || !isJsonType(t)) return;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    try { ex.data = JSON.parse(text); } catch { ex.bodyError = 'el cuerpo no es JSON'; }
  } catch { ex.bodyError = 'el cuerpo no es UTF-8'; }
}

async function finish(ex) {
  await ex.reqReady;
  const cls = `${String(ex.status)[0]}xx`;
  stats.byClass[cls] = (stats.byClass[cls] ?? 0) + 1;
  let findings = [];
  try {
    if (ex.resRaw) decodeBody(ex, ex.resRaw);
    else ex.size = Number(ex.resHeaders['content-length'] ?? 0) || (ex.bodySkipped ? 1 : 0);
    if (!ex.bodySkipped) {
      stats.analysed++;
      findings = analyze(ex);
      for (const f of findings) record(ex, f);
    }
  } catch (e) {
    console.error(`restep-proxy: fallo interno al analizar ${ex.method} ${ex.url}: ${e.stack ?? e}`);
  } finally {
    try { learn(ex); } catch (e) { console.error(`restep-proxy: fallo interno: ${e.stack ?? e}`); }
  }
  return findings;
}

function onRequest(req, res) {
  const u = new URL(req.url, 'http://proxy');
  if (u.pathname === '/_restep-proxy' || u.pathname === '/_restep-proxy.json') return servePage(req, res, u.pathname.endsWith('.json'));
  stats.exchanges++;
  const ex = { method: req.method, url: req.url, pathname: u.pathname, params: u.searchParams, reqHeaders: req.headers };
  ex.route = classify(u.pathname);
  prepare(ex);

  const chunks = [];
  let size = 0, tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > opts.maxBody) { tooBig = true; chunks.length = 0; } else chunks.push(c);
  });
  ex.reqReady = new Promise((done) => { req.once('end', done); req.once('close', done); }).then(() => {
    ex.reqBody = tooBig ? null : Buffer.concat(chunks);
    try { prepareBody(ex); } catch (e) { console.error(`restep-proxy: fallo interno: ${e.stack ?? e}`); }
  });

  const client = target.protocol === 'https:' ? https : http;
  const up = client.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
    method: req.method, path: req.url, headers: requestHeaders(req), agent: target.protocol === 'https:' ? httpsAgent : httpAgent });
  req.pipe(up);
  up.on('response', (upres) => onResponse(ex, req, res, upres));
  up.on('error', (e) => {
    stats.upstreamErrors++;
    if (ex.isWrite) inflight.set(ex.pathname, Math.max(0, (inflight.get(ex.pathname) ?? 1) - 1));
    if (ex.idemScope && idem.get(ex.idemScope)?.owner === ex) idem.delete(ex.idemScope);
    if (res.headersSent) { res.destroy(); return; }
    if (!opts.quiet) console.error(`${clock()} restep-proxy: no se pudo hablar con ${target.origin} (${req.method} ${req.url}): ${e.code ?? e.message}`);
    sendProblem(res, 502, 'bad_gateway', 'El proxy no ha podido llegar a la API', `${target.origin}: ${e.code ?? e.message}`);
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
}

function onResponse(ex, req, res, upres) {
  ex.status = upres.statusCode;
  ex.resHeaders = upres.headers;
  const raw = responseHeaders(upres);
  // Un flujo (SSE) no se guarda ni se analiza por dentro: se reenvía según llega.
  const streaming = mediaType(upres.headers['content-type']) === 'text/event-stream';
  if (!opts.strict || streaming) {
    res.writeHead(upres.statusCode, upres.statusMessage, raw);
    const chunks = [];
    let size = 0, big = false;
    if (!streaming) upres.on('data', (c) => { if (big) return; size += c.length; if (size > opts.maxBody) { big = true; chunks.length = 0; } else chunks.push(c); });
    // La respuesta se termina después de analizarla, para que lo aprendido (ETag, Idempotency-Key)
    // esté al día antes de que el cliente pueda mandar la petición siguiente.
    upres.pipe(res, { end: false });
    upres.on('end', async () => {
      ex.resRaw = streaming || big ? null : Buffer.concat(chunks);
      ex.bodySkipped = streaming || big;
      await finish(ex);
      res.end();
    });
    upres.on('error', () => res.destroy());
    return;
  }
  // --strict: se guarda la respuesta entera antes de decidir si se entrega.
  const chunks = [];
  let size = 0, flushed = false;
  upres.on('data', (c) => {
    if (flushed) return;
    chunks.push(c);
    size += c.length;
    if (size > opts.maxBody) { // demasiado grande para guardarla: se entrega sin analizar el cuerpo
      flushed = true;
      res.writeHead(upres.statusCode, upres.statusMessage, raw);
      for (const x of chunks) res.write(x);
      chunks.length = 0;
      upres.pipe(res);
    }
  });
  upres.on('error', () => res.destroy());
  upres.on('end', async () => {
    if (flushed) { ex.bodySkipped = true; finish(ex); return; }
    ex.resRaw = Buffer.concat(chunks);
    const findings = await finish(ex);
    const must = findings.filter((f) => CHECKS[f.id][1] === 'DEBE');
    if (res.destroyed) return;
    if (!must.length) { res.writeHead(upres.statusCode, upres.statusMessage, raw); res.end(ex.resRaw); return; }
    stats.replaced++;
    sendProblem(res, 502, 'bad_gateway', 'La respuesta de la API incumple Restep',
      `restep-proxy --strict: ${must.length} violación(es) en la respuesta ${ex.status} a ${ex.method} ${ex.url}: ${must.map((f) => `${f.id}: ${f.msg}`).join(' | ')}`,
      { upstream_status: ex.status, violations: must.map((f) => ({ check: f.id, section: CHECKS[f.id][0], spec: sectionUrl(CHECKS[f.id][0]), message: f.msg })) });
  });
}

// ── Página de resumen ─────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
function servePage(req, res, json) {
  req.resume();
  if (json) {
    const body = JSON.stringify(report(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  const t = totals(), rep = report();
  const rows = rep.groups.map((g) => `<tr class="${g.level === 'DEBE' ? 'must' : 'should'}"><td>${g.level === 'DEBE' ? 'Violación' : 'Aviso'}</td>` +
    `<td><code>${esc(g.check)}</code><br><a href="${esc(g.spec)}">§${esc(g.section)}</a></td><td><code>${esc(g.method)} ${esc(g.route)}</code></td>` +
    `<td class="n">${g.count}</td><td>${esc(g.description)}<br><span class="ex"><code>${esc(g.first.request)}</code> → ${esc(g.first.status)}: ${esc(g.first.message)}</span></td></tr>`).join('\n');
  const body = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10"><title>restep-proxy</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1b1b1b; --muted: #666; --line: #ddd; --must: #b00020; --should: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #e8e8e8; --muted: #9a9a9a; --line: #333; --must: #ff6b7f; --should: #e0b050; } }
body { margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; } p.meta { color: var(--muted); margin: 0 0 1.25rem; }
.totals { display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 1.25rem; } .totals b { font-size: 1.6rem; display: block; }
.wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: .5rem; border-bottom: 1px solid var(--line); }
th { font-weight: 600; } td.n { text-align: right; font-variant-numeric: tabular-nums; } tr.must td:first-child { color: var(--must); font-weight: 600; }
tr.should td:first-child { color: var(--should); } .ex { color: var(--muted); font-size: .9em; } a { color: inherit; }
</style></head><body>
<h1>restep-proxy</h1>
<p class="meta">Vigilando <code>${esc(target.href)}</code> desde ${esc(rep.started)}${opts.strict ? ' · modo estricto' : ''} · ${disc ? `perfiles: ${esc(announced.join(', '))}` : 'sin documento de descubrimiento (solo core)'} · <a href="/_restep-proxy.json">JSON</a></p>
<div class="totals"><div><b>${rep.exchanges}</b>intercambios</div><div><b>${t.violations}</b>violaciones</div><div><b>${t.warnings}</b>avisos</div><div><b>${groups.size}</b>grupos</div>${opts.strict ? `<div><b>${stats.replaced}</b>respuestas sustituidas</div>` : ''}</div>
${rows ? `<div class="wrap"><table><thead><tr><th>Nivel</th><th>Comprobación</th><th>Ruta</th><th>Veces</th><th>Qué pide la especificación · primer caso</th></tr></thead><tbody>
${rows}
</tbody></table></div>` : '<p>Sin violaciones ni avisos por ahora.</p>'}
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ── Resumen y salida ──────────────────────────────────────────────────────────
function printSummary() {
  const t = totals();
  console.log(`\nrestep-proxy · resumen (${target.href})`);
  console.log(`${stats.exchanges} intercambios, ${stats.analysed} analizados${stats.upstreamErrors ? `, ${stats.upstreamErrors} errores al llegar a la API` : ''}${opts.strict ? `, ${stats.replaced} respuestas sustituidas` : ''}`);
  for (const g of sortedGroups()) {
    const label = g.level === 'DEBE' ? paint('1;31', 'VIOLACIÓN') : paint(33, 'AVISO    ');
    console.log(`  ${label} ${String(g.count).padStart(5)}×  ${g.check} (${g.section})  ${g.method} ${g.route}`);
    console.log(`  ${' '.repeat(17)}${g.first.request} → ${g.first.status}: ${g.first.message}`);
  }
  console.log(`${t.violations} violaciones en ${[...groups.values()].filter((g) => g.level === 'DEBE').length} grupos, ${t.warnings} avisos`);
}
function writeReport() {
  if (!opts.report) return;
  const file = resolve(opts.report), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report(), null, 2)}\n`);
  renameSync(tmp, file);
}

let httpAgent, httpsAgent;
async function loadDiscovery() {
  const headers = { accept: 'application/json' };
  if (process.env.RESTEP_TOKEN) headers.authorization = `Bearer ${process.env.RESTEP_TOKEN}`;
  try {
    const r = await fetch(target, { headers, signal: AbortSignal.timeout(5000) });
    const d = await r.json().catch(() => null);
    if (r.ok && isObject(d) && typeof d.restep === 'string') { setDiscovery(d); return `descubrimiento leído: ${announced.join(', ')}; ${routes.length} colecciones`; }
    return `la raíz respondió ${r.status} sin documento de descubrimiento: solo core hasta que pase uno por el proxy`;
  } catch (e) {
    return `no se pudo leer el descubrimiento (${e.cause?.code ?? e.message}): solo core hasta que pase uno por el proxy`;
  }
}

export async function main(argv = process.argv.slice(2)) {
  opts = parseArgs(argv);
  target = opts.target;
  rootPath = target.pathname;
  httpAgent = new http.Agent({ keepAlive: true });
  httpsAgent = new https.Agent({ keepAlive: true });
  const note = await loadDiscovery();
  const server = http.createServer(onRequest);
  server.on('clientError', (e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('error', (e) => { console.error(`restep-proxy: no puede escuchar en ${opts.host}:${opts.port}: ${e.code ?? e.message}`); process.exit(2); });
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`restep-proxy ${VERSION} en http://${opts.host}:${port}/ → ${target.href}${opts.strict ? ' (estricto)' : ''}`);
    console.log(`${note}. Resumen en http://${opts.host}:${port}/_restep-proxy`);
  });
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    server.close();
    server.closeAllConnections?.();
    printSummary();
    try { writeReport(); } catch (e) { console.error(`restep-proxy: no se pudo escribir ${opts.report}: ${e.message}`); }
    process.exit(totals().violations ? 1 : 0);
  };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
