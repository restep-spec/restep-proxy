#!/usr/bin/env node
// restep-proxy · Reverse HTTP proxy that watches the Restep 1 contract on real traffic.
// Node 18 or later, no dependencies.  Specification: https://restep.wubytes.com/1/  (draft 6)
//
//   node restep-proxy.mjs --target http://api:8080 --port 8871 [--report report.json] [--strict]
//
// Forwards each request to the target unaltered (streaming, dropping only the hop-by-hop headers)
// and, in parallel, checks each request/response pair against the specification and against the target's
// discovery document. Violations come out grouped in the log, in the summary at exit
// (Ctrl+C) and, with --report, in a JSON file. With --strict, a response that breaks a MUST is replaced
// by a 502 problem+json (for CI). GET /_restep-proxy gives the summary as HTML (and /_restep-proxy.json, as JSON).
// It generates no traffic of its own except a GET to the root at startup, to read the discovery document.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const VERSION = '0.3.0';
const PROFILE = 'https://w3id.org/restep/1/'; // identifier: profile link and error types
const SPEC = 'https://restep.wubytes.com/1/'; // the page to read
// §1.2: the versions whose text of the experimental parts (sync, inherit…) this proxy implements.
export const KNOWN_TEXTS = ['1.0-draft.7'];
// §1.1: the grammar of restep, with no leading zeros.
const RESTEP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(draft|rc)\.(0|[1-9]\d*))?$/;
// §3: the grammar of names (reason, among others).
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ANCHORS = {
  1.1: 'restep-versions', 3: 'data', 4.1: 'profile-header', 4.2: 'discovery', 4.3: 'describing', 4.4: 'health', 5.1: 'resources',
  5.2: 'collections', 5.3: 'reserved', 5.4: 'errors', 5.5: 'versions', 5.9: 'singletons', 6.1: 'filters', 6.2: 'sorting',
  6.3: 'fields', 6.4: 'pagination', 6.5: 'counts', 7.1: 'idempotency', 7.2: 'concurrency', 7.3: 'minimal', 8: 'cache',
  9: 'relations', 10: 'sync', 11.1: 'actions', 11.6: 'inheritance',
};
// Checks whose requirement has its own anchor within its section.
const CHECK_ANCHORS = { 'cache-private': 'private-responses', 'cache-private.auth': 'private-responses' };
export const sectionUrl = (s, id) => `${SPEC}#${CHECK_ANCHORS[id] ?? ANCHORS[s] ?? 'conformance'}`;

// ── Catalog: each check, its section, its level and what it verifies ─────────
// An unmet MUST is a violation; a SHOULD, a warning. --strict only acts on violations.
export const CHECKS = {
  json: ['3', 'MUST', 'A JSON body is valid JSON in UTF-8'],
  'json-type': ['3', 'MUST', 'A 2xx with a body carries Content-Type: application/json (a schema may be application/schema+json)'],
  'media-type': ['3', 'MUST', 'A POST or QUERY with a body and no Content-Type, another type or a charset other than UTF-8, or a PATCH of another type, gets 415; an empty body with application/json gets 400'],
  'media-type.accept-patch': ['5.1', 'SHOULD', 'A 415 to a PATCH carries Accept-Patch'],
  'media-type.accept-post': ['5.1', 'SHOULD', 'A 415 to a POST to a collection that declares upload carries Accept-Post'],
  'upload.json': ['5.1', 'MUST', 'A collection with upload creates items from JSON only where it declares schemas.create: elsewhere a JSON body its media_types do not admit, also by a wildcard (application/* or */*), gets 415; where it does, a JSON POST creates an item, never a file; a +json body is a file like any other'],
  'upload.multipart': ['5.1', 'MUST', 'An outer multipart/form-data body selects multipart upload: it gets 415 unless upload declares "multipart": true, even when media_types admits it'],
  'upload.filename': ['5.1', 'MUST', 'The server does not require filename on the file part of a multipart upload: it reads an otherwise valid part without it as the file'],
  'leap-second': ['3', 'MUST', 'A response never writes a leap second (:60) in a declared datetime or localdatetime field, and a PATCH body with one there does not succeed and, with 422 invalid, carries a format entry (or read_only); a POST may carry one in a field only the server sets, which it ignores (5.1)'],
  'i-json': ['3', 'MUST', 'A 422 for an unpaired surrogate or a noncharacter in a request body points at the string that holds it, or at "" when that string is a member name'],
  links: ['3', 'MUST', 'next and href are absolute URIs or absolute paths under the API root, and an absolute URI (also in Location and Link) uses https or the root\'s scheme'],
  'discovery.schema': ['4.2', 'MUST', 'The discovery document of a version whose text the proxy knows matches that version\'s discovery.json schema'],
  'discovery.version': ['1.1', 'MUST', 'The discovery document\'s restep follows the grammar major.minor[-draft.N|-rc.N] and is Restep 1'],
  'profile-link': ['4.1', 'SHOULD', 'Every response carries a single rel="profile" link, to the version URI'],
  health: ['4.4', 'MUST', 'The status resource answers 200 or 503 with Cache-Control: no-store (or 401, 403, 429)'],
  allow: ['4.3', 'MUST', 'A 405 names in Allow the declared methods and no others; a declared method never gets 405'],
  'status.success': ['5.1', 'MUST', 'Successes use the status in the table: GET 200, POST 201, PATCH 200 (204 with return=minimal), DELETE 204'],
  location: ['5.1', 'MUST', 'A 201 carries Location with the item path: its collection\'s path, / and its id'],
  'id.assigned': ['5.1', 'MUST', 'A PATCH with another id gets 422; so does a POST with an id where id_from does not allow it, and one without an id where id_from is "client"'],
  'patch.object': ['5.1', 'MUST', 'A patch that is not a JSON object does not succeed: 422 invalid if it is JSON, 400 if it is not'],
  'collection.shape': ['5.2', 'MUST', 'A collection answers {items, next}, with next present (string or null)'],
  reserved: ['5.3', 'MUST', 'A reserved parameter the resource does not implement gets 400 unsupported_parameter; it is not ignored'],
  'error.media-type': ['5.4', 'MUST', '4xx and 5xx with a body are application/problem+json'],
  'error.schema': ['5.4', 'MUST', 'The error body matches the problem.json schema'],
  'error.status': ['5.4', 'MUST', 'The body\'s status is the response\'s'],
  'error.code': ['5.4', 'MUST', 'code comes from the closed table for that status, or is http_ and the status\'s three digits for a status the table does not list'],
  'error.type': ['5.4', 'SHOULD', 'type is the Restep error URI for that code or another URI'],
  'error.about-blank': ['5.4', 'MUST', 'type is about:blank only for a problem with nothing beyond its status: the only code the table gives it, or http_NNN, and no reason, errors or parameter'],
  'error.no-store': ['5.4', 'MUST', 'A 428, 429, 431 or 511 carries Cache-Control: no-store'],
  'cache-private.shared': ['5.1', 'MUST', 'A private or no-store response carries no field aimed at shared caches (CDN-Cache-Control…) that would let one store it'],
  'error.detail': ['5.4', 'SHOULD', 'Errors carry detail'],
  'error.401': ['5.4', 'MUST', 'A 401 carries WWW-Authenticate'],
  'error.405': ['5.1', 'MUST', 'A 405 carries Allow'],
  'error.retry-after': ['5.4', 'SHOULD', 'A 429, a 503 or a 409 request_in_progress (7.1) carries Retry-After'],
  'error.parameter': ['5.3', 'MUST', 'invalid_parameter and unsupported_parameter name in parameter the parameter as it arrived'],
  'error.reason': ['5.4', 'MUST', 'reason follows the naming grammar and, if the discovery document declares reasons, is one of them with its code'],
  'cache-private.auth': ['5.1', 'MUST', 'A 401 or a 403 is private or no-store'],
  'no-error-in-200': ['5.4', 'MUST', 'No problem object inside a 2xx'],
  deprecation: ['5.5', 'MUST', 'A resource retired whole (version, collection, singleton, action) carries Deprecation with the notice\'s announced instant, a Link rel="deprecation" and Sunset once dated; a partial notice puts neither Deprecation nor Sunset; after the date, what is retired no longer works'],
  singleton: ['5.9', 'MUST', 'A singleton answers GET with a JSON object, and POST and DELETE with 405'],
  'sync.undeclared': ['10', 'MUST', ':changes on a collection that does not declare sync gets 404'],
  events: ['10', 'MUST', 'The events response carries Cache-Control: no-store'],
  'item.discovery': ['4.2', 'MUST', 'Items fit the discovery document: declared types, language maps, relations and inheritance'],
  'relations.link': ['9', 'MUST', 'A link of a relation to several collections carries type (one of them), and one to an item of a subcollection carries href, that item\'s path'],
  'relations.include': ['9', 'MUST', 'include of a relation that is undeclared, not expandable, deeper than include_depth, or that continues past a relation to several collections gets unsupported_parameter'],
  'relations.fields': ['9', 'MUST', 'A dotted path in fields whose relation is not in include gets invalid_parameter'],
  'actions.listed': ['11.1', 'MUST', 'Each action in _actions is declared on the collection, as an item action and with the same method'],
  'actions.undeclared': ['11.1', 'MUST', 'An undeclared action, or one declared on the other kind of resource, gets 404; with another method, 405'],
  'actions.response': ['11.1', 'MUST', 'An action answers 200, 201 with Location or 204; an unsafe collection action never 200, a safe one never 201, a 204 without ETag, and a result with output without _etag or _actions'],
  'actions.params': ['11.1', 'MUST', 'A GET action answers a query parameter its params do not declare (any, where it declares no params) with 400 unsupported_parameter, and does not reject a declared one with it'],
  'actions.empty-body': ['11.1', 'MUST', 'A POST action treats an empty body, with or without Content-Type, as {}: it never gets 400 or 415 for it'],
  'query.declared-rejected': ['5.3', 'MUST', 'A declared filter, sort or count is not rejected with unsupported_parameter'],
  'query.named-value': ['6.1', 'MUST', 'A switch with a value, or a named filter with type and no value or a value that does not fit, gets invalid_parameter'],
  'query.required': ['6.1', 'MUST', 'A list request without a filter declared "required": true gets invalid_parameter'],
  'query.undeclared': ['5.3', 'MUST', 'An undeclared filter field or operator, or sort field, gets unsupported_parameter'],
  'query.null-once': ['6.1', 'MUST', 'More than one null filter on the same to-many relationship or list field, its own or that of a path through it, gets 400 invalid_parameter, even when their values agree'],
  'query.operand': ['6.1', 'MUST', 'An integer or number operand of a filter, or of a GET action parameter (each list element too), follows the number grammar of RFC 8259 (2e1 is 20; +20, .5, 020 and 0x14 are not numbers): an invalid one gets invalid_parameter and a valid one is not rejected with it'],
  'filter.match': ['6.1', 'MUST', 'Every returned item matches the filters, comparing by the declared type'],
  'sort.order': ['6.2', 'MUST', 'Items come in the requested order, with those without a value at the end'],
  fields: ['6.3', 'MUST', 'With fields only those fields come back, plus id and members starting with _'],
  limit: ['6.4', 'MUST', 'A page does not exceed limit, and a limit outside 1..max_limit gets invalid_parameter'],
  next: ['6.4', 'MUST', 'next carries a cursor and keeps the other parameters unchanged'],
  count: ['6.5', 'MUST', 'count=true adds total, an integer; with count exact, without total_estimated'],
  'idempotency.key': ['7.1', 'MUST', 'A malformed Idempotency-Key gets 400 bad_request; with "anonymous": false, so does one without credentials (except on an idempotent action, which ignores it); an idempotent action does not reject a well-formed one'],
  'idempotency.replay': ['7.1', 'MUST', 'The same request with the same Idempotency-Key returns the same status and Location, and the stored body or the item\'s current representation (with the current ETag)'],
  'idempotency.replayed-header': ['7.1', 'SHOULD', 'A replay carries Idempotent-Replayed: true'],
  'idempotency.replay-validators': ['7.1', 'MUST', 'A replay whose body is not the item\'s current representation carries no Content-Location, ETag or _etag, and a replayed 201 without a body carries no ETag (7.3)'],
  'idempotency.mismatch': ['7.1', 'MUST', 'The same Idempotency-Key with a different request does not succeed (422 idempotency_mismatch)'],
  etag: ['7.2', 'MUST', 'The GET of a full item carries its strong ETag, and every response whose body is an item carries _etag'],
  'etag.collection': ['7.2', 'SHOULD', 'Items in a collection carry _etag when they allow PATCH or DELETE'],
  'etag.synced': ['7.2', 'MUST', 'In a collection that declares sync, every item that allows PATCH or DELETE carries _etag on every page'],
  'if-match': ['7.2', 'MUST', 'If-Match with an old ETag gets 412; with the current one, it does not; a write to a just-deleted item gets 404, not 412'],
  precondition: ['7.2', 'MUST', 'A 412 answers a conditional header and a 428 answers a write without If-Match; where a resource requires If-Match, an If-None-Match other than * does not meet it'],
  'if-none-match': ['8', 'MUST', 'A matching If-None-Match gets 304 on GET and HEAD (cache) and 412 on a write (writes)'],
  'cache-control': ['8', 'MUST', 'With cache, every response to GET or HEAD, errors included, carries Cache-Control'],
  'cache-etag': ['8', 'MUST', 'With cache, the GET of a full item or of a singleton carries ETag'],
  'cache-private': ['5.1', 'MUST', 'A response to a request with credentials is private or no-store'],
  'minimal.etag': ['7.3', 'MUST', 'A minimal response to a write that does not delete carries the item\'s ETag'],
  minimal: ['7.3', 'SHOULD', 'A minimal response carries Preference-Applied'],
};

// ── Error schema (schema/problem.json, copied as is; test.mjs checks that it matches) ──
export const PROBLEM_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://w3id.org/restep/1/schema/problem.json",
  "title": "Restep 1 error",
  "description": "Body of every 4xx or 5xx response: application/problem+json (RFC 9457) with a code (section 5.4), and of every error result in a batch (11.2). The table of codes is closed: each code of the table goes with its status, and a status the table does not list has http_ and its three digits as code. Whether http_ carries the status's own digits, whether type may be about:blank, and whether reason is declared in discovery, are checked by restep-check, not by this schema.",
  "type": "object",
  "required": [
    "type",
    "title",
    "status",
    "code"
  ],
  "properties": {
    "type": {
      "type": "string",
      "format": "uri-reference",
      "examples": [
        "https://w3id.org/restep/1/errors#invalid",
        "about:blank"
      ]
    },
    "title": {
      "type": "string"
    },
    "status": {
      "type": "integer",
      "minimum": 400,
      "maximum": 599
    },
    "code": {
      "type": "string",
      "description": "From the table of 5.4, or, for a status the table does not list, http_ followed by the status's three digits (5.4).",
      "anyOf": [
        {
          "enum": [
            "bad_request",
            "invalid_parameter",
            "unsupported_parameter",
            "idempotency_key_required",
            "unauthenticated",
            "forbidden",
            "not_found",
            "method_not_allowed",
            "not_acceptable",
            "request_timeout",
            "conflict",
            "request_in_progress",
            "state_expired",
            "retired",
            "precondition_failed",
            "content_too_large",
            "uri_too_long",
            "unsupported_media_type",
            "misdirected_request",
            "invalid",
            "idempotency_mismatch",
            "not_executed",
            "too_early",
            "precondition_required",
            "rate_limited",
            "internal",
            "not_implemented",
            "bad_gateway",
            "unavailable",
            "gateway_timeout"
          ]
        },
        {
          "pattern": "^http_[45][0-9]{2}$"
        }
      ],
      "examples": [
        "invalid_parameter",
        "not_found",
        "request_timeout",
        "too_early",
        "gateway_timeout",
        "http_418",
        "http_431"
      ]
    },
    "detail": {
      "type": "string"
    },
    "instance": {
      "type": "string",
      "format": "uri-reference"
    },
    "reason": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      "description": "Domain reason defined by the API: follows the grammar of names (3) and should be snake_case (5.4)."
    },
    "parameter": {
      "type": "string",
      "description": "The parameter name as received, after percent-decoding (5.3); also on a 403 for a field the principal can read in no item (6.1)."
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "code"
        ],
        "properties": {
          "pointer": {
            "type": "string",
            "pattern": "^(/([^~/]|~[01])*)*$",
            "description": "A JSON Pointer in its plain string form (RFC 6901, sections 3 and 5) into the request body; \"\" for the whole body."
          },
          "parameter": {
            "type": "string"
          },
          "header": {
            "type": "string",
            "examples": [
              "Idempotency-Key"
            ]
          },
          "code": {
            "type": "string",
            "examples": [
              "required",
              "type",
              "format",
              "range",
              "too_long",
              "unknown",
              "read_only",
              "taken"
            ]
          },
          "detail": {
            "type": "string"
          }
        },
        "anyOf": [
          {
            "required": [
              "pointer"
            ]
          },
          {
            "required": [
              "parameter"
            ]
          },
          {
            "required": [
              "header"
            ]
          }
        ]
      }
    }
  },
  "allOf": [
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "enum": [
              "bad_request",
              "invalid_parameter",
              "unsupported_parameter",
              "idempotency_key_required"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 400
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "unauthenticated"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 401
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "forbidden"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 403
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "not_found"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 404
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "method_not_allowed"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 405
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "not_acceptable"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 406
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "request_timeout"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 408
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "enum": [
              "conflict",
              "request_in_progress"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 409
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "enum": [
              "state_expired",
              "retired"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 410
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "precondition_failed"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 412
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "content_too_large"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 413
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "uri_too_long"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 414
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "unsupported_media_type"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 415
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "misdirected_request"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 421
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "enum": [
              "invalid",
              "idempotency_mismatch"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 422
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "not_executed"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 424
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "too_early"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 425
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "precondition_required"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 428
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "rate_limited"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 429
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "internal"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 500
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "not_implemented"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 501
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "bad_gateway"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 502
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "unavailable"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 503
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "const": "gateway_timeout"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "const": 504
          }
        }
      }
    },
    {
      "description": "http_ only for a status the table does not list (5.4).",
      "if": {
        "required": [
          "code"
        ],
        "properties": {
          "code": {
            "type": "string",
            "pattern": "^http_"
          }
        }
      },
      "then": {
        "properties": {
          "status": {
            "not": {
              "enum": [
                400,
                401,
                403,
                404,
                405,
                406,
                408,
                409,
                410,
                412,
                413,
                414,
                415,
                421,
                422,
                424,
                425,
                428,
                429,
                500,
                501,
                502,
                503,
                504
              ]
            }
          }
        }
      }
    }
  ]
};

// ── Discovery schema (schema/discovery.json, copied as is; test.mjs checks that it matches) ──
export const DISCOVERY_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://w3id.org/restep/1/schema/discovery.json",
  "title": "Restep 1 discovery document",
  "description": "The document a GET on the API root returns (section 4.2), as of draft 7. Members a server adds outside Restep start with x- (4.2); clients ignore what they do not know. Rules that relate one member to another (a collation on a declared string field, a named filter that shares no name with a filter, a subcollection path that starts with its parent's, a localized field whose source is a language map, a method in method_effects that is in methods, a parent that names a collection or singleton of the document) are checked by restep-check, not by this schema.",
  "type": "object",
  "required": [
    "restep"
  ],
  "properties": {
    "restep": {
      "type": "string",
      "pattern": "^1\\.(0|[1-9][0-9]*)(-(draft|rc)\\.(0|[1-9][0-9]*))?$",
      "description": "Full Restep version, without leading zeros: 1.0 for a published version, 1.0-draft.7 or 1.0-rc.1 for a draft or a candidate of it (1.1). The suffix is in lowercase.",
      "examples": [
        "1.0",
        "1.0-draft.7",
        "1.0-rc.1",
        "1.1-draft.2"
      ]
    },
    "version": {
      "type": "string",
      "pattern": "^[1-9][0-9]*$",
      "description": "Major version of this API, the n in /vn/ (5.5)."
    },
    "default_language": {
      "$ref": "#/$defs/language_tag",
      "description": "The API's default language (5.6): the one it uses when no language in Accept-Language matches. Required where a collection declares localized fields."
    },
    "profiles": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "examples": [
          "core",
          "query",
          "writes",
          "cache",
          "relations",
          "sync"
        ]
      }
    },
    "extensions": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "examples": [
          "actions",
          "batch",
          "filter-expr",
          "query-method",
          "oauth",
          "inherit"
        ]
      }
    },
    "batch": {
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/path"
        },
        "max_operations": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "idempotency": {
      "type": "object",
      "properties": {
        "ttl": {
          "type": "integer",
          "minimum": 86400,
          "description": "Seconds a key is kept (7.1)."
        },
        "anonymous": {
          "type": "boolean",
          "description": "false: requests without credentials that carry Idempotency-Key get 400 bad_request; missing means true (7.1)."
        }
      }
    },
    "events": {
      "$ref": "#/$defs/path",
      "description": "Server-Sent Events path, relative to the API root (10)."
    },
    "status": {
      "$ref": "#/$defs/link",
      "description": "Link to the service status resource (4.4)."
    },
    "collections": {
      "type": "object",
      "propertyNames": {
        "$ref": "#/$defs/name"
      },
      "additionalProperties": {
        "$ref": "#/$defs/collection"
      }
    },
    "singletons": {
      "type": "object",
      "description": "Resources that are neither a collection nor an item of one, keyed by a name of the API's choosing (5.9).",
      "propertyNames": {
        "$ref": "#/$defs/name"
      },
      "additionalProperties": {
        "$ref": "#/$defs/singleton"
      }
    },
    "deprecations": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/deprecation",
        "properties": {
          "kind": {
            "enum": [
              "version",
              "profile",
              "extension",
              "collection",
              "singleton",
              "reason"
            ]
          }
        }
      },
      "description": "Retirement notices of the version, a profile, an extension, a collection, a singleton or a reason (5.5)."
    },
    "reasons": {
      "type": "object",
      "propertyNames": {
        "$ref": "#/$defs/name"
      },
      "additionalProperties": {
        "$ref": "#/$defs/reason"
      },
      "description": "The domain reasons the API can give, keyed by reason; if declared, complete (5.4)."
    },
    "shared_cache": {
      "$ref": "#/$defs/reserved_shared_cache"
    }
  },
  "patternProperties": {
    "^x-": true
  },
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "profiles": {
            "contains": {
              "const": "sync"
            }
          }
        },
        "required": [
          "profiles"
        ]
      },
      "then": {
        "properties": {
          "profiles": {
            "contains": {
              "const": "query"
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "extensions": {
            "contains": {
              "enum": [
                "filter-expr",
                "query-method"
              ]
            }
          }
        },
        "required": [
          "extensions"
        ]
      },
      "then": {
        "required": [
          "profiles"
        ],
        "properties": {
          "profiles": {
            "contains": {
              "const": "query"
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "extensions": {
            "contains": {
              "const": "batch"
            }
          }
        },
        "required": [
          "extensions"
        ]
      },
      "then": {
        "required": [
          "batch"
        ]
      }
    },
    {
      "description": "A collection declares inherit or inherit_items only if extensions lists inherit (11.6).",
      "anyOf": [
        {
          "properties": {
            "collections": {
              "additionalProperties": {
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "inherit"
                      ]
                    },
                    {
                      "required": [
                        "inherit_items"
                      ]
                    }
                  ]
                }
              }
            }
          }
        },
        {
          "required": [
            "extensions"
          ],
          "properties": {
            "extensions": {
              "contains": {
                "const": "inherit"
              }
            }
          }
        }
      ]
    },
    {
      "description": "A collection declares sync only if profiles lists sync (10).",
      "anyOf": [
        {
          "properties": {
            "collections": {
              "additionalProperties": {
                "not": {
                  "required": [
                    "sync"
                  ]
                }
              }
            }
          }
        },
        {
          "required": [
            "profiles"
          ],
          "properties": {
            "profiles": {
              "contains": {
                "const": "sync"
              }
            }
          }
        }
      ]
    },
    {
      "description": "An API with localized fields declares default_language (5.6).",
      "anyOf": [
        {
          "properties": {
            "collections": {
              "additionalProperties": {
                "not": {
                  "required": [
                    "localized"
                  ]
                }
              }
            }
          }
        },
        {
          "required": [
            "default_language"
          ]
        }
      ]
    }
  ],
  "$defs": {
    "name": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      "description": "A name the API gives: name = ALPHA *63( ALPHA / DIGIT / \"_\" / \"-\" ) (3). It never starts with _, which Restep reserves."
    },
    "field_path": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}(\\.[A-Za-z][A-Za-z0-9_-]{0,63})*$",
      "description": "A field or a dotted path: names joined by ., through relationships or nested objects, whose last segment can be a lowercase language tag (name.es-mx) (3, 6.1)."
    },
    "language_tag": {
      "type": "string",
      "pattern": "^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$",
      "description": "A language tag (BCP 47, RFC 5646). This pattern only approximates the grammar of RFC 5646, section 2.1, and admits its private-use and grandfathered tags.",
      "examples": [
        "es-es",
        "en",
        "es-419"
      ]
    },
    "media_range": {
      "type": "string",
      "pattern": "^(\\*/\\*|[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*|\\*))$",
      "description": "A media type without parameters (RFC 6838, section 4.2), whose subtype can be * to match any, or */* to match every media type (5.1).",
      "examples": [
        "image/*",
        "application/pdf",
        "*/*"
      ]
    },
    "reason": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]*$",
          "description": "The code this reason comes with (5.4)."
        },
        "description": {
          "$ref": "#/$defs/description"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "reserved_shared_cache": {
      "description": "Reserved for a minor version, at the root and in each collection and singleton: a server of this version MUST NOT send it (4.2).",
      "not": {}
    },
    "path": {
      "type": "string",
      "pattern": "^/",
      "description": "A path relative to the API root, starting with / (2). A collection path MAY be a URI template (RFC 6570)."
    },
    "template_path": {
      "allOf": [
        {
          "$ref": "#/$defs/path"
        }
      ],
      "pattern": "^/(?:[^{}]|\\{[A-Za-z][A-Za-z0-9_]*\\})*$",
      "not": {
        "pattern": "\\{([^}]+)\\}.*\\{\\1\\}"
      },
      "description": "A collection path, or that of a singleton with a parent: a path whose template variables, if any, are simple strings ({name}) whose names match ALPHA *( ALPHA / DIGIT / \"_\" ) and are distinct (4.2)."
    },
    "link": {
      "type": "string",
      "pattern": "^(/(?!/)|https?:)",
      "description": "A link in a body: an absolute path that includes the API root's path, or an absolute URI whose scheme is https or the API root's (3)."
    },
    "type": {
      "enum": [
        "string",
        "integer",
        "number",
        "decimal",
        "boolean",
        "date",
        "datetime",
        "localdatetime",
        "timezone",
        "duration",
        "enum"
      ]
    },
    "op": {
      "enum": [
        "eq",
        "ne",
        "lt",
        "le",
        "gt",
        "ge",
        "in",
        "nin",
        "null",
        "prefix",
        "contains"
      ]
    },
    "effects": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "enum": [
          "destroys",
          "external",
          "charges"
        ]
      },
      "description": "Consequences of an operation that a person may want to approve first (11.1); [] declares none."
    },
    "method_effects": {
      "type": "object",
      "propertyNames": {
        "enum": [
          "POST",
          "PATCH",
          "DELETE"
        ]
      },
      "additionalProperties": {
        "$ref": "#/$defs/effects"
      },
      "description": "Effects of unsafe methods, keyed by method (4.3). An undeclared DELETE has [\"destroys\"]; any other undeclared unsafe method, all three."
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "description": "A short plain-text explanation, one sentence; data, never instructions (4.3)."
    },
    "schema": {
      "oneOf": [
        {
          "type": "object",
          "description": "A JSON Schema 2020-12 object."
        },
        {
          "$ref": "#/$defs/link",
          "description": "A link to one (3)."
        }
      ]
    },
    "method": {
      "enum": [
        "GET",
        "POST",
        "PATCH",
        "DELETE"
      ]
    },
    "methods": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/method"
      },
      "uniqueItems": true
    },
    "filter": {
      "type": "object",
      "required": [
        "type",
        "ops"
      ],
      "properties": {
        "type": {
          "$ref": "#/$defs/type"
        },
        "values": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "description": {
          "$ref": "#/$defs/description"
        },
        "ops": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/op"
          },
          "minItems": 1,
          "uniqueItems": true
        },
        "quantifier": {
          "enum": [
            "some"
          ],
          "description": "On a path through one to-many relationship or a list field: an item matches when some related item or element matches (6.1). On the relationship or list field itself with null as its only operator, declared with the type of the related items' id or of the elements, it may be omitted or be some, with the same selection: null then tests the whole relationship or list (6.1). Other values are reserved for minor versions."
        },
        "required": {
          "type": "boolean",
          "description": "A list request without this filter gives invalid_parameter (6.1)."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "enum"
              }
            }
          },
          "then": {
            "required": [
              "values"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "boolean"
              }
            }
          },
          "then": {
            "properties": {
              "ops": {
                "items": {
                  "enum": [
                    "eq",
                    "ne",
                    "null"
                  ]
                }
              }
            }
          }
        },
        {
          "description": "prefix and contains only on string fields and translations (6.1).",
          "if": {
            "required": [
              "ops"
            ],
            "properties": {
              "ops": {
                "contains": {
                  "enum": [
                    "prefix",
                    "contains"
                  ]
                }
              }
            }
          },
          "then": {
            "properties": {
              "type": {
                "const": "string"
              }
            }
          }
        },
        {
          "description": "No ne or nin on a path declared with quantifier (6.1).",
          "if": {
            "required": [
              "quantifier"
            ]
          },
          "then": {
            "properties": {
              "ops": {
                "not": {
                  "contains": {
                    "enum": [
                      "ne",
                      "nin"
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    },
    "named_filter": {
      "type": "object",
      "required": [
        "description"
      ],
      "description": "A filter by name that does not compare a field (6.1): a switch without type, or one that takes a value of its type.",
      "properties": {
        "type": {
          "$ref": "#/$defs/type"
        },
        "values": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "description": {
          "$ref": "#/$defs/description",
          "description": "Which items it returns; it is what gives the filter its meaning."
        },
        "default": {
          "type": "boolean",
          "description": "true: the switch applies to every list request that does not turn it off with filter[name]=false (6.1)."
        },
        "required": {
          "type": "boolean",
          "description": "A list request without this filter gives invalid_parameter (6.1)."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "enum"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "required": [
              "values"
            ]
          }
        },
        {
          "description": "Only a switch, a named filter without type, can be a default filter (6.1).",
          "if": {
            "properties": {
              "default": {
                "const": true
              }
            },
            "required": [
              "default"
            ]
          },
          "then": {
            "not": {
              "required": [
                "type"
              ]
            }
          }
        }
      ]
    },
    "relation": {
      "type": "object",
      "required": [
        "to"
      ],
      "properties": {
        "to": {
          "oneOf": [
            {
              "$ref": "#/$defs/name"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/$defs/name"
              },
              "minItems": 2,
              "uniqueItems": true
            }
          ]
        },
        "many": {
          "type": "boolean"
        },
        "include": {
          "type": "boolean"
        },
        "path": {
          "$ref": "#/$defs/template_path",
          "description": "The template of the subcollection it leads to (9)."
        },
        "media_types": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/media_range"
          },
          "minItems": 1,
          "uniqueItems": true,
          "description": "To a collection that declares upload: the media types of the files it may link (5.1)."
        },
        "description": {
          "$ref": "#/$defs/description"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "param": {
      "type": "object",
      "required": [
        "type"
      ],
      "description": "A query parameter of a GET action (11.1).",
      "properties": {
        "type": {
          "$ref": "#/$defs/type"
        },
        "values": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "list": {
          "type": "boolean",
          "description": "Values separated by commas, read after percent-decoding (11.1)."
        },
        "required": {
          "type": "boolean",
          "description": "Missing, it gives invalid_parameter (11.1)."
        },
        "description": {
          "$ref": "#/$defs/description"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "if": {
        "properties": {
          "type": {
            "const": "enum"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "required": [
          "values"
        ]
      }
    },
    "action": {
      "type": "object",
      "required": [
        "safe",
        "idempotent"
      ],
      "description": "An action (11.1). A collection's actions carry on; a singleton's do not.",
      "properties": {
        "on": {
          "enum": [
            "item",
            "collection"
          ]
        },
        "safe": {
          "type": "boolean"
        },
        "idempotent": {
          "type": "boolean"
        },
        "method": {
          "enum": [
            "GET",
            "POST"
          ],
          "description": "POST unless declared; only safe actions may use GET (11.1)."
        },
        "description": {
          "$ref": "#/$defs/description"
        },
        "effects": {
          "$ref": "#/$defs/effects",
          "description": "Without it, a client treats the action as having all three effects; a safe action declares only charges (11.1)."
        },
        "input": {
          "$ref": "#/$defs/schema",
          "description": "Schema of the action's body, for a POST action (4.3)."
        },
        "params": {
          "type": "object",
          "description": "Query parameters of a GET action, keyed by name (11.1).",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/param"
          }
        },
        "output": {
          "$ref": "#/$defs/schema",
          "description": "Schema of a safe action's result, which is not a representation (11.1)."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "required": [
              "method"
            ],
            "properties": {
              "method": {
                "const": "GET"
              }
            }
          },
          "then": {
            "properties": {
              "safe": {
                "const": true
              }
            },
            "not": {
              "required": [
                "input"
              ]
            }
          }
        },
        {
          "description": "params only on a GET action (11.1).",
          "if": {
            "required": [
              "params"
            ]
          },
          "then": {
            "required": [
              "method"
            ],
            "properties": {
              "method": {
                "const": "GET"
              }
            }
          }
        },
        {
          "description": "output only on a safe action (11.1).",
          "if": {
            "required": [
              "output"
            ]
          },
          "then": {
            "required": [
              "safe"
            ],
            "properties": {
              "safe": {
                "const": true
              }
            }
          }
        },
        {
          "description": "A safe action declares only charges (11.1).",
          "if": {
            "required": [
              "safe"
            ],
            "properties": {
              "safe": {
                "const": true
              }
            }
          },
          "then": {
            "properties": {
              "effects": {
                "items": {
                  "const": "charges"
                }
              }
            }
          }
        },
        {
          "description": "A safe action is idempotent (11.1; RFC 9110, section 9.2.2).",
          "if": {
            "required": [
              "safe"
            ],
            "properties": {
              "safe": {
                "const": true
              }
            }
          },
          "then": {
            "properties": {
              "idempotent": {
                "const": true
              }
            }
          }
        }
      ]
    },
    "collection_action": {
      "allOf": [
        {
          "$ref": "#/$defs/action"
        }
      ],
      "required": [
        "on"
      ]
    },
    "singleton_action": {
      "allOf": [
        {
          "$ref": "#/$defs/action"
        }
      ],
      "not": {
        "required": [
          "on"
        ]
      },
      "description": "An action of a singleton, used at {path}:{name}; it carries no on (11.1)."
    },
    "switch": {
      "type": "object",
      "required": [
        "field",
        "initial"
      ],
      "description": "A boolean field of the item itself: while it is false, nothing comes from above (11.6).",
      "properties": {
        "field": {
          "$ref": "#/$defs/name"
        },
        "initial": {
          "type": "boolean",
          "description": "The value a POST that leaves the field out gives it."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "inherit": {
      "type": "object",
      "required": [
        "own"
      ],
      "properties": {
        "own": {
          "$ref": "#/$defs/name",
          "description": "The own field, written; null means it inherits."
        },
        "from": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/name"
          },
          "description": "To-one relationships this step inherits from, in order."
        },
        "default": {
          "type": "boolean",
          "description": "There is a default at the end of the chain."
        },
        "combine": {
          "enum": [
            "replace",
            "fields"
          ],
          "description": "replace (the default) takes the own value whole; fields, for objects of scalars, resolves each member on its own (11.6)."
        },
        "switch": {
          "$ref": "#/$defs/switch"
        },
        "description": {
          "$ref": "#/$defs/description"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "inherit_items": {
      "type": "object",
      "required": [
        "from"
      ],
      "description": "Inherited items of a subcollection (11.6).",
      "properties": {
        "from": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/field_path"
          },
          "description": "To-one relationships of the parent item, in order, through which the same subcollection of the source is found."
        },
        "key": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/name"
          },
          "description": "Fields that identify an item across levels; without it, inherited and own items add up."
        },
        "switch": {
          "$ref": "#/$defs/switch"
        },
        "description": {
          "$ref": "#/$defs/description"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "language_map": {
      "type": "object",
      "description": "Left for minor versions (4.2): today only x- members.",
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "localized": {
      "type": "object",
      "required": [
        "source"
      ],
      "description": "A localized field (3); the rest of its object is left for minor versions.",
      "properties": {
        "source": {
          "$ref": "#/$defs/name",
          "description": "The language map of the same item whose text it carries."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "local_time": {
      "type": "object",
      "description": "A field that holds local date-times (3, 4.2).",
      "properties": {
        "zone": {
          "$ref": "#/$defs/field_path",
          "description": "A timezone field of the item, or reached through a relationship; without it, a floating local time."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "upload": {
      "type": "object",
      "required": [
        "media_types"
      ],
      "description": "A POST to the collection MAY carry the bytes of a file instead of JSON (5.1).",
      "properties": {
        "media_types": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/media_range"
          },
          "minItems": 1,
          "uniqueItems": true
        },
        "max_size": {
          "type": "integer",
          "minimum": 1,
          "description": "Largest file, in bytes; a larger one gives 413 content_too_large."
        },
        "multipart": {
          "type": "boolean",
          "description": "true: the POST MAY carry multipart/form-data with exactly one part, named file (5.1)."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false
    },
    "deprecation": {
      "type": "object",
      "required": [
        "kind",
        "announced"
      ],
      "description": "A retirement notice (5.5). Where it goes decides which kinds it can have: the root, a collection or a singleton.",
      "properties": {
        "kind": {
          "enum": [
            "version",
            "profile",
            "extension",
            "collection",
            "singleton",
            "reason",
            "field",
            "filter",
            "operator",
            "value",
            "sort",
            "relation",
            "include",
            "count",
            "max_limit",
            "action",
            "method",
            "item_method"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "description": "What is retired: a name, a field, a filter field or a method, as the kind says."
        },
        "op": {
          "$ref": "#/$defs/op",
          "description": "The operator, for kind operator."
        },
        "value": {
          "description": "The enum value (value), the lower limit (max_limit) or \"estimated\" (count)."
        },
        "announced": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}([Zz]|[+-]\\d{2}:\\d{2})$",
          "description": "When the notice was first published, in whole seconds; it never changes (5.5)."
        },
        "sunset": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}([Zz]|[+-]\\d{2}:\\d{2})$",
          "description": "When it is removed, once there is a date, in whole seconds (5.5)."
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "enum": [
                  "version",
                  "count",
                  "max_limit"
                ]
              }
            }
          },
          "else": {
            "required": [
              "name"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "operator"
              }
            }
          },
          "then": {
            "required": [
              "op"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "value"
              }
            }
          },
          "then": {
            "required": [
              "value"
            ],
            "properties": {
              "value": {
                "type": "string"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "max_limit"
              }
            }
          },
          "then": {
            "required": [
              "value"
            ],
            "properties": {
              "value": {
                "type": "integer",
                "minimum": 1
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "count"
              }
            }
          },
          "then": {
            "properties": {
              "value": {
                "const": "estimated"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "enum": [
                  "method",
                  "item_method"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "name": {
                "$ref": "#/$defs/method"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "enum": [
                  "collection",
                  "singleton",
                  "relation",
                  "action",
                  "reason"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "name": {
                "$ref": "#/$defs/name"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "enum": [
                  "field",
                  "filter",
                  "operator",
                  "value",
                  "sort",
                  "include"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "name": {
                "$ref": "#/$defs/field_path"
              }
            }
          }
        }
      ]
    },
    "singleton": {
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/template_path",
          "description": "Never a path that a collection or an item of one has or could have; a template only with parent (5.9)."
        },
        "parent": {
          "$ref": "#/$defs/name",
          "description": "The collection or singleton it hangs from; its path starts with the parent's item path, or the parent singleton's path, followed by / (5.9)."
        },
        "description": {
          "$ref": "#/$defs/description"
        },
        "methods": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "GET",
              "PATCH"
            ]
          },
          "contains": {
            "const": "GET"
          },
          "description": "Exact, as in 4.3; a singleton always supports GET (5.9)."
        },
        "schemas": {
          "type": "object",
          "properties": {
            "item": {
              "$ref": "#/$defs/schema",
              "description": "Its full representation."
            },
            "update": {
              "$ref": "#/$defs/schema",
              "description": "The body of a PATCH, a merge patch."
            }
          },
          "patternProperties": {
            "^x-": true
          },
          "additionalProperties": false
        },
        "actions": {
          "type": "object",
          "description": "Its actions, used at {path}:{name} (5.9, 11.1).",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/singleton_action"
          }
        },
        "deprecations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/deprecation",
            "properties": {
              "kind": {
                "enum": [
                  "field",
                  "method",
                  "action"
                ]
              },
              "name": {
                "type": "string"
              }
            },
            "if": {
              "properties": {
                "kind": {
                  "const": "method"
                }
              }
            },
            "then": {
              "properties": {
                "name": {
                  "const": "PATCH"
                }
              }
            }
          }
        },
        "method_effects": {
          "$ref": "#/$defs/method_effects",
          "propertyNames": {
            "const": "PATCH"
          },
          "description": "Effects of its PATCH, the only key (4.3, 5.9); an undeclared PATCH has all three."
        },
        "shared_cache": {
          "$ref": "#/$defs/reserved_shared_cache"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "if": {
        "not": {
          "required": [
            "parent"
          ]
        }
      },
      "then": {
        "properties": {
          "path": {
            "not": {
              "pattern": "[{}]"
            }
          }
        }
      }
    },
    "collection": {
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/template_path"
        },
        "parent": {
          "$ref": "#/$defs/name",
          "description": "The collection whose items a subcollection hangs from; required when path is a template (4.2)."
        },
        "description": {
          "$ref": "#/$defs/description"
        },
        "methods": {
          "$ref": "#/$defs/methods",
          "description": "Methods the collection supports (4.3); absent means unknown."
        },
        "item_methods": {
          "$ref": "#/$defs/methods",
          "description": "Methods its items support (4.3); absent means unknown."
        },
        "method_effects": {
          "$ref": "#/$defs/method_effects",
          "description": "Effects of the collection's unsafe methods (4.3)."
        },
        "item_method_effects": {
          "$ref": "#/$defs/method_effects",
          "description": "Effects of its items' unsafe methods (4.3)."
        },
        "schemas": {
          "type": "object",
          "properties": {
            "item": {
              "$ref": "#/$defs/schema",
              "description": "The full representation of an item."
            },
            "create": {
              "$ref": "#/$defs/schema",
              "description": "The body of a POST."
            },
            "update": {
              "$ref": "#/$defs/schema",
              "description": "The body of a PATCH, a merge patch."
            }
          },
          "patternProperties": {
            "^x-": true
          },
          "additionalProperties": false
        },
        "id_from": {
          "enum": [
            "server",
            "client",
            "either"
          ],
          "description": "Who chooses an item's id; missing means server (5.1)."
        },
        "reusable_ids": {
          "type": "boolean",
          "description": "With id_from client: the id of a deleted item is free again (5.1)."
        },
        "upsert": {
          "type": "boolean",
          "description": "With id_from client or either: a PATCH to a free id creates the item (5.1)."
        },
        "upload": {
          "$ref": "#/$defs/upload"
        },
        "filter": {
          "type": "object",
          "propertyNames": {
            "$ref": "#/$defs/field_path"
          },
          "additionalProperties": {
            "$ref": "#/$defs/filter"
          },
          "properties": {
            "id": {
              "$ref": "#/$defs/filter",
              "properties": {
                "ops": {
                  "items": {
                    "enum": [
                      "eq",
                      "ne",
                      "in",
                      "nin",
                      "null"
                    ]
                  }
                }
              },
              "description": "The order of ids is the server's: no lt, le, gt or ge; nor prefix or contains (6.1)."
            }
          }
        },
        "named_filters": {
          "type": "object",
          "description": "Filters by name (6.1); none shares its name with a key of filter.",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/named_filter"
          }
        },
        "sort": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/field_path"
          },
          "uniqueItems": true
        },
        "collations": {
          "type": "object",
          "description": "How a string field, an enum of strings listed in sort, a localized field or a translation field.tag is compared and sorted (6.1); a field not listed is codepoint.",
          "propertyNames": {
            "$ref": "#/$defs/field_path",
            "not": {
              "const": "id"
            }
          },
          "additionalProperties": {
            "enum": [
              "codepoint",
              "server"
            ]
          }
        },
        "max_limit": {
          "type": "integer",
          "minimum": 1
        },
        "count": {
          "enum": [
            "exact",
            "estimated"
          ]
        },
        "relations": {
          "type": "object",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/relation"
          }
        },
        "language_maps": {
          "type": "object",
          "description": "Fields of the collection that are language maps (3), all of them; absent means none.",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/language_map"
          }
        },
        "localized": {
          "type": "object",
          "description": "Localized fields of the collection (3), all of them, each with its source.",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/localized"
          }
        },
        "local_times": {
          "type": "object",
          "description": "Fields of the collection that hold local date-times, and where each one's time zone comes from (4.2).",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/local_time"
          }
        },
        "inherit": {
          "type": "object",
          "description": "Inherited fields (11.6): each key is an effective, read-only field.",
          "propertyNames": {
            "$ref": "#/$defs/name"
          },
          "additionalProperties": {
            "$ref": "#/$defs/inherit"
          }
        },
        "inherit_items": {
          "$ref": "#/$defs/inherit_items"
        },
        "include_depth": {
          "type": "integer",
          "minimum": 1
        },
        "sync": {
          "type": "object",
          "description": "Declares the collection synced, {} if it has nothing to say; only synced collections answer :changes (10).",
          "properties": {
            "retention": {
              "type": "integer",
              "minimum": 0,
              "description": "Seconds changes are kept (10)."
            }
          }
        },
        "actions": {
          "type": "object",
          "propertyNames": {
            "$ref": "#/$defs/name",
            "not": {
              "const": "changes"
            }
          },
          "additionalProperties": {
            "$ref": "#/$defs/collection_action"
          },
          "properties": {
            "new": {
              "allOf": [
                {
                  "$ref": "#/$defs/collection_action"
                }
              ],
              "required": [
                "method"
              ],
              "properties": {
                "on": {
                  "const": "collection"
                },
                "safe": {
                  "const": true
                },
                "method": {
                  "const": "GET"
                }
              },
              "description": "A reserved name: a collection's action named new is the one that gives the starting values of a new item and an effective schema, {\"values\": …, \"schema\": …}, a safe collection action used with GET (11.1)."
            }
          }
        },
        "deprecations": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/deprecation",
            "properties": {
              "kind": {
                "enum": [
                  "field",
                  "filter",
                  "operator",
                  "value",
                  "sort",
                  "relation",
                  "include",
                  "count",
                  "max_limit",
                  "action",
                  "method",
                  "item_method"
                ]
              }
            }
          }
        },
        "shared_cache": {
          "$ref": "#/$defs/reserved_shared_cache"
        }
      },
      "patternProperties": {
        "^x-": true
      },
      "additionalProperties": false,
      "allOf": [
        {
          "description": "A synced collection declares id in filter with in, and has no required filter (10).",
          "if": {
            "required": [
              "sync"
            ]
          },
          "then": {
            "required": [
              "filter"
            ],
            "properties": {
              "filter": {
                "required": [
                  "id"
                ],
                "properties": {
                  "id": {
                    "properties": {
                      "ops": {
                        "contains": {
                          "const": "in"
                        }
                      },
                      "required": {
                        "const": false
                      }
                    }
                  }
                },
                "additionalProperties": {
                  "properties": {
                    "required": {
                      "const": false
                    }
                  }
                }
              },
              "named_filters": {
                "additionalProperties": {
                  "properties": {
                    "required": {
                      "const": false
                    }
                  }
                }
              }
            }
          }
        },
        {
          "if": {
            "required": [
              "path"
            ],
            "properties": {
              "path": {
                "pattern": "\\{"
              }
            }
          },
          "then": {
            "required": [
              "parent"
            ]
          }
        },
        {
          "description": "A collection whose methods leave out GET cannot be listed (4.3).",
          "if": {
            "required": [
              "methods"
            ],
            "properties": {
              "methods": {
                "not": {
                  "contains": {
                    "const": "GET"
                  }
                }
              }
            }
          },
          "then": {
            "not": {
              "anyOf": [
                {
                  "required": [
                    "filter"
                  ]
                },
                {
                  "required": [
                    "named_filters"
                  ]
                },
                {
                  "required": [
                    "sort"
                  ]
                },
                {
                  "required": [
                    "count"
                  ]
                },
                {
                  "required": [
                    "sync"
                  ]
                }
              ]
            }
          }
        },
        {
          "description": "reusable_ids only with id_from client (5.1).",
          "if": {
            "required": [
              "reusable_ids"
            ],
            "properties": {
              "reusable_ids": {
                "const": true
              }
            }
          },
          "then": {
            "required": [
              "id_from"
            ],
            "properties": {
              "id_from": {
                "const": "client"
              }
            }
          }
        },
        {
          "description": "upsert only with id_from client or either (5.1).",
          "if": {
            "required": [
              "upsert"
            ],
            "properties": {
              "upsert": {
                "const": true
              }
            }
          },
          "then": {
            "required": [
              "id_from"
            ],
            "properties": {
              "id_from": {
                "enum": [
                  "client",
                  "either"
                ]
              }
            }
          }
        },
        {
          "description": "Only a subcollection declares inherit_items (11.6).",
          "if": {
            "required": [
              "inherit_items"
            ]
          },
          "then": {
            "required": [
              "parent"
            ]
          }
        },
        {
          "description": "A collection that takes files and creates items from JSON (upload with schemas.create) and whose media_types admit application/json, also by a wildcard, declares multipart true: a JSON file only travels as the file part of multipart/form-data (5.1).",
          "if": {
            "required": [
              "upload",
              "schemas"
            ],
            "properties": {
              "schemas": {
                "required": [
                  "create"
                ]
              },
              "upload": {
                "properties": {
                  "media_types": {
                    "contains": {
                      "pattern": "^([Aa][Pp][Pp][Ll][Ii][Cc][Aa][Tt][Ii][Oo][Nn]/([Jj][Ss][Oo][Nn]|\\*)|\\*/\\*)$"
                    }
                  }
                }
              }
            }
          },
          "then": {
            "properties": {
              "upload": {
                "required": [
                  "multipart"
                ],
                "properties": {
                  "multipart": {
                    "const": true
                  }
                }
              }
            }
          }
        }
      ]
    }
  }
};

// JSON Schema 2020-12 validator for what the schemas of Restep 1 use (schema/problem.json and
// discovery.json): type, enum, const, required, properties, patternProperties, additionalProperties,
// propertyNames, items, prefixItems, contains, minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
// minimum, maximum, exclusiveMinimum, exclusiveMaximum, allOf, anyOf, oneOf, not, if/then/else and local $ref
// (#/…). format and the annotations are ignored. Returns one message per failure.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TYPE_IS = {
  object: isObject, array: Array.isArray, string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v), integer: (v) => Number.isInteger(v), null: (v) => v === null,
};
const regexCache = new Map();
const regex = (p) => { if (!regexCache.has(p)) regexCache.set(p, new RegExp(p, 'u')); return regexCache.get(p); };
export function schemaErrors(schema, v, at = '', root = schema) {
  if (schema === true || schema === undefined) return [];
  const where = at || '/';
  if (schema === false) return [`${where} is not allowed`];
  const out = [];
  const valid = (s, x) => schemaErrors(s, x, '', root).length === 0;
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#')) out.push(`${where}: external $ref ${schema.$ref} is not followed`);
    else {
      let target = root;
      for (const part of schema.$ref.slice(1).split('/').slice(1)) target = target?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
      if (target === undefined) out.push(`${where}: $ref ${schema.$ref} has no target`);
      else out.push(...schemaErrors(target, v, at, root));
    }
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => TYPE_IS[t]?.(v))) return [...out, `${where} is not of type ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.some((e) => canonical(e) === canonical(v))) out.push(`${where} is not one of the allowed values`);
  if ('const' in schema && canonical(schema.const) !== canonical(v)) out.push(`${where} is not ${JSON.stringify(schema.const)}`);
  if (typeof v === 'string') {
    const len = [...v].length;
    if (schema.minLength !== undefined && len < schema.minLength) out.push(`${where} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) out.push(`${where} is longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !regex(schema.pattern).test(v)) out.push(`${where} (${JSON.stringify(v)}) does not match ${schema.pattern}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${where} is less than ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${where} is greater than ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) out.push(`${where} is not greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) out.push(`${where} is not less than ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${where} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) out.push(`${where} has more than ${schema.maxItems} items`);
    if (schema.uniqueItems && v.some((x, i) => v.findIndex((y) => canonical(x) === canonical(y)) !== i)) out.push(`${where} has repeated items`);
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefix.forEach((s, i) => { if (i < v.length) out.push(...schemaErrors(s, v[i], `${at}/${i}`, root)); });
    if (schema.items !== undefined) v.forEach((x, i) => { if (i >= prefix.length) out.push(...schemaErrors(schema.items, x, `${at}/${i}`, root)); });
    if (schema.contains !== undefined && !v.some((x) => valid(schema.contains, x))) out.push(`${where} has no item that matches contains`);
  }
  if (isObject(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`missing ${at}/${k}`);
    for (const [k, x] of Object.entries(v)) {
      const p = `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      let matched = false;
      if (isObject(schema.properties) && Object.hasOwn(schema.properties, k)) { matched = true; out.push(...schemaErrors(schema.properties[k], x, p, root)); }
      for (const [re, s] of Object.entries(schema.patternProperties ?? {})) if (regex(re).test(k)) { matched = true; out.push(...schemaErrors(s, x, p, root)); }
      if (!matched && schema.additionalProperties !== undefined) out.push(...schemaErrors(schema.additionalProperties, x, p, root).map((e) => (schema.additionalProperties === false ? `${p} is not an allowed member` : e)));
      if (schema.propertyNames !== undefined && !valid(schema.propertyNames, k)) out.push(`${p}: the member name is not allowed`);
    }
  }
  for (const s of Array.isArray(schema.allOf) ? schema.allOf : []) out.push(...schemaErrors(s, v, at, root));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => valid(s, v)))
    out.push(`${where} matches none of the alternatives (${schema.anyOf.map((s) => (s?.required ? s.required.join('+') : '?')).join(', ')})`);
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => valid(s, v)).length;
    if (n !== 1) out.push(`${where} matches ${n} oneOf alternatives, not one`);
  }
  if (schema.not !== undefined && valid(schema.not, v)) out.push(`${where} matches a schema it must not${schema.not?.description ? ` (${schema.not.description})` : ''}`);
  if (schema.if !== undefined) {
    if (valid(schema.if, v)) { if (schema.then !== undefined) out.push(...schemaErrors(schema.then, v, at, root)); }
    else if (schema.else !== undefined) out.push(...schemaErrors(schema.else, v, at, root));
  }
  return out;
}

// ── Utilities shared with restep-check (copied: restep-check exports nothing) ──
// 5.4: the table is closed; a status it does not list has http_ and its three digits, never a name from the
// IANA registry.
const TABLE = {
  400: ['bad_request', 'invalid_parameter', 'unsupported_parameter', 'idempotency_key_required'], 401: ['unauthenticated'],
  403: ['forbidden'], 404: ['not_found'], 405: ['method_not_allowed'], 406: ['not_acceptable'], 408: ['request_timeout'],
  409: ['conflict', 'request_in_progress'], 410: ['state_expired', 'retired'], 412: ['precondition_failed'], 413: ['content_too_large'],
  414: ['uri_too_long'], 415: ['unsupported_media_type'], 421: ['misdirected_request'], 422: ['invalid', 'idempotency_mismatch'],
  424: ['not_executed'], 425: ['too_early'], 428: ['precondition_required'], 429: ['rate_limited'], 500: ['internal'],
  501: ['not_implemented'], 502: ['bad_gateway'], 503: ['unavailable'], 504: ['gateway_timeout'],
};
const expectedCodes = (status) => TABLE[status] ?? [`http_${status}`];
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

function linkTargets(value, rel) { // URIs of the links of a Link header with that rel
  const out = [];
  for (const m of String(value ?? '').matchAll(/<([^>]*)>([^,<]*)/g)) {
    const rels = m[2].match(/rel\s*=\s*("([^"]*)"|[^;\s]+)/i);
    if (rels && (rels[2] ?? rels[1]).split(/\s+/).includes(rel)) out.push(m[1]);
  }
  return out;
}
function cmpDecimal(a, b) { // exact: compares digits, never goes through Number
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
function cmpText(a, b) { // by Unicode code points
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
// 3 and 6.1: a time with a leap second (:60), which a server never writes and a filter or a body rejects.
const LEAP = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:60/;
// 3: a local date-time, full-date "T" partial-time of RFC 3339, without an offset.
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const isLeap = (v) => typeof v === 'string' && (DATETIME.test(v) || LOCAL_DATETIME.test(v)) && LEAP.test(v);
// 6.1 and 11.1: integer and number operands follow the number grammar of RFC 8259, section 6, exponent included
// (2e1 is 20; +20, .5, 020 and 0x14 are not numbers).
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
// 6.1: an integer operand is a number whose exact decimal value has no fractional part (20.0 is 20, 20.5 is not),
// decided on the digits, never through floating point.
function integralNumber(raw) {
  const m = JSON_NUMBER.test(String(raw)) && /^-?(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(String(raw));
  if (!m) return false;
  const digits = `${m[1]}${m[2] ?? ''}`.replace(/^0+(?=\d)/, '');
  const scale = (m[2] ?? '').length - Number(m[3] ?? 0);
  if (scale <= 0) return true;
  return /^0+$/.test(scale >= digits.length ? digits : digits.slice(-scale));
}
// 6.1 (council, round 4, decision 6): a numeric operand is compared as a number, exactly, even outside the range
// of a double: 1e400 is neither an infinity nor 1e-400 zero. Exact form: sign, significant digits and the exponent
// e (a BigInt) such that the value is 0.digits × 10^e; zero has no digits.
function exactNumber(raw) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(String(raw));
  if (!m) return null;
  let digits = `${m[2]}${m[3] ?? ''}`, exp = BigInt(m[4] ?? 0) + BigInt(m[2].length);
  const lead = digits.match(/^0*/)[0].length;
  digits = digits.slice(lead).replace(/0+$/, '');
  exp -= BigInt(lead);
  return { neg: m[1] === '-' && digits !== '', digits, exp };
}
function cmpExact(a, b) {
  const sa = a.digits === '' ? 0 : a.neg ? -1 : 1, sb = b.digits === '' ? 0 : b.neg ? -1 : 1;
  if (sa !== sb || sa === 0) return sa - sb;
  if (a.exp !== b.exp) return a.exp > b.exp ? sa : -sa;
  const n = Math.max(a.digits.length, b.digits.length), x = a.digits.padEnd(n, '0'), y = b.digits.padEnd(n, '0');
  return x === y ? 0 : x > y ? sa : -sa;
}
// Whether a valid numeric operand falls outside what a double holds: a server that parses it into one gets an
// infinity, or zero for a non-zero operand.
const beyondDouble = (raw) => JSON_NUMBER.test(raw) && (!Number.isFinite(Number(raw)) || (Number(raw) === 0 && exactNumber(raw).digits !== ''));
function durationSeconds(s) {
  const m = String(s).match(DURATION);
  if (!m || m[1] || m[2]) return NaN; // years and months have no fixed length
  const n = (x) => (x ? parseFloat(x) : 0);
  return n(m[3]) * 604800 + n(m[4]) * 86400 + n(m[6]) * 3600 + n(m[7]) * 60 + n(m[8]);
}
// Comparable form of a value of that type; undefined if it does not fit the type.
function norm(type, v) {
  switch (type) {
    case 'decimal': return typeof v === 'string' && DECIMAL.test(v) ? v : undefined;
    // An operand (a string) keeps its exact form; a value of the item is a JSON number already.
    case 'integer': return typeof v === 'number' ? (Number.isInteger(v) ? v : undefined) : integralNumber(v) ? exactNumber(v) : undefined;
    case 'number': return typeof v === 'number' ? (Number.isFinite(v) ? v : undefined) : typeof v === 'string' && JSON_NUMBER.test(v) ? exactNumber(v) : undefined;
    case 'boolean': return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
    case 'date': return DATE.test(v) ? Date.parse(`${v}T00:00:00Z`) : undefined;
    case 'datetime': return DATETIME.test(v) && !isLeap(v) ? Date.parse(v) : undefined;
    case 'localdatetime': return typeof v === 'string' && LOCAL_DATETIME.test(v) && !isLeap(v) ? v.replace('t', 'T') : undefined;
    case 'duration': { const s = durationSeconds(v); return Number.isNaN(s) ? undefined : s; }
    default: return typeof v === 'string' ? v : undefined;
  }
}
function cmp(type, a, b) {
  if (type === 'decimal') return cmpDecimal(a, b);
  if (type === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (isObject(a) || isObject(b)) return cmpExact(isObject(a) ? a : exactNumber(String(a)), isObject(b) ? b : exactNumber(String(b)));
  return cmpText(String(a), String(b));
}
// Whether an item meets filter[field][op]=raw, according to 6.1.
function matches(type, op, value, raw) {
  // 6.1: on a relationship or a list field, an empty list, an absent field and null are the same.
  if (op === 'null') return (blank(value) || (Array.isArray(value) && value.length === 0)) === (raw === 'true');
  if (blank(value)) return false;
  const x = norm(type, value);
  if (x === undefined) return false;
  if (op === 'in' || op === 'nin') return raw.split(',').some((r) => cmp(type, x, norm(type, r)) === 0) === (op === 'in');
  if (op === 'prefix') return String(value).startsWith(raw);
  if (op === 'contains') return String(value).includes(raw);
  const c = cmp(type, x, norm(type, raw));
  return { eq: c === 0, ne: c !== 0, lt: c < 0, le: c <= 0, gt: c > 0, ge: c >= 0 }[op];
}
// Whether a value fits the type a field is declared with (4.2): a value of the item, not of the URL.
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
const HELP = `restep-proxy ${VERSION} · reverse proxy that watches the Restep 1 contract

Usage:
  restep-proxy --target <url> [options]

Options:
  --target <url>      Restep API to forward to (required), e.g. http://api:8080 or
                      http://api:8080/v1/ if the API root is not the host root. Paths are
                      forwarded as they are.
  --port <n>          Port the proxy listens on (8871 by default)
  --host <host>       Interface to listen on (127.0.0.1 by default)
  --report <file>     On exit, writes the report as JSON
  --strict            Replaces every response that breaks a MUST with a 502 problem+json
  --max-body <bytes>  Largest body that is analysed (2097152 by default)
  --preserve-host     Forwards the client's Host header instead of the target's
  --quiet             No live log, only the final summary
  -h, --help          This help

With RESTEP_TOKEN, the initial GET to the discovery document carries Authorization: Bearer
(client traffic goes through with its own credentials).

GET /_restep-proxy gives the summary as HTML; GET /_restep-proxy.json, the report as JSON.
Exit code on exit (SIGINT or SIGTERM): 0 with no violations, 1 with any, 2 if it cannot start.`;

function parseArgs(argv) {
  const o = { target: null, port: 8871, host: '127.0.0.1', report: null, strict: false, maxBody: 2 * 1024 * 1024, preserveHost: false, quiet: false };
  const value = (i) => { if (argv[i + 1] === undefined) usage(`${argv[i]} needs a value.`); return argv[i + 1]; };
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
    else usage(`Unknown option: ${a}`);
  }
  if (!o.target) usage('Missing --target.');
  try { o.target = new URL(o.target); } catch { usage(`--target is not a URL: ${o.target}`); }
  if (!['http:', 'https:'].includes(o.target.protocol)) usage('--target must be http or https.');
  if (!o.target.pathname.endsWith('/')) o.target.pathname += '/';
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) usage('--port must be a port number.');
  if (!Number.isInteger(o.maxBody) || o.maxBody < 0) usage('--max-body must be a number of bytes.');
  return o;
}
function usage(msg) { console.error(`${msg}\n\n${HELP}`); process.exit(2); }

// ── Estado ────────────────────────────────────────────────────────────────────
let opts, target, rootPath;
let disc = null; // documento de descubrimiento vigente
let announced = ['core'];
let knownText = false; // §1.2: whether the text of the experimental parts of the declared version is known
let routes = []; // collections of the discovery document, with their regular expressions
let singletonRoutes = new Map(); // full path → { name, c } of each singleton (§5.9)
const stats = { started: new Date(), exchanges: 0, analysed: 0, byClass: {}, upstreamErrors: 0, replaced: 0 };
const groups = new Map(); // check + method + path → group
const etags = new Map(); // item path → { current, old: Set }
const writeSeq = new Map(); // path → writes started
const inflight = new Map(); // path → writes in progress
const idem = new Map(); // Idempotency-Key scope → { print, status, body, replay, expires, pending }
const deleted = new Set(); // paths of items the proxy has seen deleted (§7.2: a write afterwards gives 404)
const requireIfMatch = new Set(); // method and path of writes that answered 428 without If-Match (§7.2)

const has = (p) => announced.includes(p);
const joinRoot = (p) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) { try { return new URL(p).pathname; } catch { return p; } }
  return rootPath.replace(/\/$/, '') + (p.startsWith('/') ? p : `/${p}`);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// §1.1: a document whose restep does not follow the grammar, or of another major version, is not Restep 1.
const restep1 = (doc) => { const v = RESTEP_VERSION.exec(doc?.restep ?? ''); return !!v && v[1] === '1'; };
function setDiscovery(doc) {
  disc = doc;
  knownText = KNOWN_TEXTS.includes(doc.restep);
  announced = ['core', ...(Array.isArray(doc.profiles) ? doc.profiles : []), ...(Array.isArray(doc.extensions) ? doc.extensions : [])]
    .filter((p, i, a) => typeof p === 'string' && a.indexOf(p) === i);
  // §5.9: a singleton with a template or with parent is ignored.
  singletonRoutes = new Map();
  for (const [name, c] of Object.entries(isObject(doc.singletons) ? doc.singletons : {}))
    if (isObject(c) && typeof c.path === 'string' && !/[{}]/.test(c.path) && c.parent === undefined) singletonRoutes.set(joinRoot(c.path).replace(/\/$/, ''), { name, c });
  routes = [];
  for (const [name, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string') continue;
    const full = joinRoot(c.path);
    const src = full.replace(/\/$/, '').split(/(\{[^}]*\})/).map((p) => (p.startsWith('{') ? '[^/]+' : escapeRe(p))).join('');
    routes.push({ name, c, label: c.path, coll: new RegExp(`^${src}$`), item: new RegExp(`^${src}/([^/]+)$`),
      action: new RegExp(`^${src}(?:/([^/]+))?(?::|%3[aA])([^/:]+)$`) });
  }
  // The longest first, so a subcollection wins over an item of its parent.
  routes.sort((a, b) => b.coll.source.length - a.coll.source.length);
}
function statusPath() {
  if (typeof disc?.status !== 'string') return null;
  try { const u = new URL(disc.status, target); return u.origin === target.origin ? u.pathname : null; } catch { return null; }
}
const metadataPath = () => `/.well-known/oauth-protected-resource${rootPath === '/' ? '' : rootPath}`;
// §10: events is relative to the API root, like the discovery document's path.
const eventsPath = () => (typeof disc?.events === 'string' ? joinRoot(disc.events) : null);
// §10: a collection is synced if it declares sync with the profile announced (and, being experimental, §1.2,
// it is only judged with a known text).
const synced = (c) => has('sync') && knownText && isObject(c?.sync);

// What a path is: discovery, status, metadata (outside the API), collection, item, action or other.
function classify(pathname) {
  if (pathname === rootPath || pathname === rootPath.replace(/\/$/, '')) return { kind: 'discovery', label: '/' };
  if (pathname === statusPath()) return { kind: 'status', label: pathname };
  if (pathname === metadataPath() || pathname.startsWith('/.well-known/')) return { kind: 'metadata', label: pathname };
  if (pathname === eventsPath()) return { kind: 'events', label: pathname };
  const single = singletonRoutes.get(pathname.replace(/\/$/, ''));
  if (single) return { kind: 'singleton', r: single, label: single.c.path };
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
  return { kind: 'other', label: '(other route)' };
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
    g = { check: f.id, section, level, description: CHECKS[f.id][2], spec: sectionUrl(section, f.id), method: ex.method,
      route: ex.route.label, count: 0, first: sample, last: sample };
    groups.set(key, g);
  }
  g.count++;
  g.last = sample;
  const tag = level === 'MUST' ? paint('1;31', 'VIOLATION') : paint(33, 'WARNING  ');
  if (g.count === 1) {
    log(`${paint(90, clock())} ${tag} ${f.id} (${section}, ${level})  ${ex.method} ${ex.route.label}`);
    log(`${' '.repeat(19)}${ex.method} ${ex.url} → ${ex.status}: ${f.msg}`);
  } else if (REMIND.has(g.count)) {
    log(`${paint(90, clock())} ${paint(90, `… ${f.id}  ${ex.method} ${ex.route.label}: ${g.count} so far`)}`);
  }
}
const totals = () => {
  let violations = 0, warnings = 0;
  for (const g of groups.values()) if (g.level === 'MUST') violations += g.count; else warnings += g.count;
  return { violations, warnings };
};
const sortedGroups = () => [...groups.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'MUST' ? -1 : 1));

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

// ── Analysis of an exchange ────────────────────────────────────────────────
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

  // 3: valid JSON.
  if (hasBody && isJsonType(mediaType(rh['content-type'])) && ex.bodyError) bad('json', ex.bodyError);
  // §3: Location and Link, with https or the root's scheme.
  if (r.kind !== 'other') linkSchemes(ex, bad);

  // 4.4: the status resource, outside the API.
  if (r.kind === 'status') {
    if (read && ![200, 503, 401, 403, 429].includes(s)) bad('health', `${s}; expected 200 or 503 (or 401, 403, 429)`);
    if (read && (s === 200 || s === 503) && !/\bno-store\b/i.test(rh['cache-control'] ?? ''))
      bad('health', `Cache-Control: ${rh['cache-control'] ?? '(none)'}; expected no-store`);
    return out;
  }
  if (r.kind === 'metadata') return out;
  // §10: the event stream carries Cache-Control: no-store.
  if (r.kind === 'events') {
    if (has('sync') && knownText && read && ok && !/\bno-store\b/i.test(rh['cache-control'] ?? '')) bad('events', `Cache-Control: ${rh['cache-control'] ?? '(none)'}; expected no-store`);
    return out;
  }
  // §3: a 2xx with a body is application/json (except for a schema); outside Restep (§5.9) it is not required.
  if (ok && hasBody && r.kind !== 'other') {
    const t = mediaType(rh['content-type']);
    if (t !== 'application/json' && t !== 'application/schema+json') bad('json-type', `Content-Type: ${rh['content-type'] ?? '(none)'}`);
  }
  mediaTypeChecks(ex, bad);
  if (r.kind === 'discovery' && ok && isObject(d) && typeof d.restep === 'string' && !restep1(d))
    bad('discovery.version', `restep is ${JSON.stringify(d.restep)}: it does not follow major.minor[-draft.N|-rc.N] or is not Restep 1`);
  // 4.2: a document that declares a version whose text the proxy knows fits that version's discovery schema.
  if (r.kind === 'discovery' && ok && isObject(d) && KNOWN_TEXTS.includes(d.restep)) {
    const errors = schemaErrors(DISCOVERY_SCHEMA, d);
    if (errors.length) bad('discovery.schema', `${errors.length} error(s): ${errors.slice(0, 4).join('; ')}`);
  }

  // 4.1: cabecera de perfil.
  if (s !== 304 && disc) {
    const links = linkTargets(rh.link, 'profile');
    const extra = links.filter((u) => u.startsWith(PROFILE) && u !== PROFILE);
    if (!links.includes(PROFILE)) bad('profile-link', `missing <${PROFILE}>; rel="profile"`);
    else if (extra.length) bad('profile-link', `lists profiles in the header (${extra.map((u) => u.slice(PROFILE.length)).join(', ')}): only the version URI goes there`);
  }
  // 8: with cache, Cache-Control on every response to GET or HEAD. 5.1: private or no-store with credentials, and on 401 and 403.
  if (read && has('cache') && !rh['cache-control']) bad('cache-control', 'no Cache-Control');
  if (read && q.authorization && rh['cache-control'] && !/\b(private|no-store)\b/i.test(rh['cache-control']))
    bad('cache-private', `request with Authorization and Cache-Control: ${rh['cache-control']}`);
  if ((s === 401 || s === 403) && !/\b(private|no-store)\b/i.test(rh['cache-control'] ?? ''))
    bad('cache-private.auth', `${s} with Cache-Control: ${rh['cache-control'] ?? '(none)'}`);

  // 5.1: a field aimed at shared caches (RFC 9213) would let one store a private or no-store response.
  if (/\b(private|no-store)\b/i.test(rh['cache-control'] ?? '')) {
    const shared = ['cdn-cache-control', 'surrogate-control'].find((h) => rh[h] !== undefined && !/\b(no-store|private)\b/i.test(rh[h]));
    if (shared) bad('cache-private.shared', `Cache-Control: ${rh['cache-control']} with ${shared}: ${rh[shared]}`);
  }

  if (s >= 400) errorChecks(ex, bad);
  if (s === 422 && ex.reqJsonParsed) ijsonChecks(ex, bad);
  else if (ok && isObject(d) && typeof d.code === 'string' && typeof d.type === 'string' && Number.isInteger(d.status) && d.status >= 400)
    bad('no-error-in-200', `a problem object (code ${d.code}) inside a ${s}`);

  if (r.kind === 'collection' || r.kind === 'item') {
    resourceChecks(ex, bad);
    reservedChecks(ex, bad);
    operandChecks(ex, bad);
    nullOnceChecks(ex, bad);
    leapChecks(ex, bad);
  } else if (r.kind === 'singleton') singletonChecks(ex, bad);
  if (r.kind === 'collection' || r.kind === 'item' || r.kind === 'singleton') {
    if (has('writes')) writesChecks(ex, bad);
    if (has('cache')) cacheChecks(ex, bad);
  }
  if (r.kind === 'action' && r.action !== 'changes' && has('actions')) actionChecks(ex, bad);
  if (r.kind === 'action' && r.action === 'changes' && !r.id && ok && !synced(r.r.c) && has('sync') && knownText)
    bad('sync.undeclared', `${r.r.name} does not declare sync and :changes got ${s}; expected 404`);
  if (r.kind === 'discovery' && ok && [...ex.params].length) {
    for (const k of new Set(ex.params.keys())) if (isReservedName(k)) bad('reserved', `${k} at the root was ignored; expected 400 unsupported_parameter`);
  }
  if (has('writes') && ex.method === 'POST' && (r.kind === 'collection' || r.kind === 'action')) idempotencyChecks(ex, bad);
  deprecationChecks(ex, bad);
  return out;
}

const baseName = (k) => k.replace(/\[.*$/, '');
const isReservedName = (k) => RESERVED.includes(baseName(k)) || k.startsWith('$');

// §3: an absolute URI in Location or Link uses https or the scheme of the API root.
function linkSchemes(ex, bad) {
  const okScheme = (u) => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(u); return !m || m[1].toLowerCase() === 'https' || `${m[1].toLowerCase()}:` === target.protocol; };
  const loc = ex.resHeaders.location;
  if (typeof loc === 'string' && !okScheme(loc)) bad('links', `Location: ${loc} uses neither https nor the root's scheme`);
  for (const m of String(ex.resHeaders.link ?? '').matchAll(/<([^>]*)>/g)) if (!okScheme(m[1])) { bad('links', `Link with <${m[1]}>, which uses neither https nor the root's scheme`); break; }
}

// §3 and §5.1: the media type of request bodies. Only a success that should have been 415 or 400 is judged.
function jsonMediaOk(header, types) {
  if (header === undefined) return false;
  const [type, ...params] = String(header).split(';');
  if (!types.includes(type.trim().toLowerCase())) return false;
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    let v = p.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.toLowerCase() !== 'utf-8') return false;
  }
  return true;
}
// 5.1: whether media_types admits a media type, by a range with * as subtype or by */* (council, round 4, 1a and 2).
const admits = (ranges, t) => !!t && ranges.some((x) => x === '*/*' || x === t || (x.endsWith('/*') && t.startsWith(x.slice(0, -1))));
// 5.1: the parts of a multipart/form-data body (RFC 7578), with their name, filename and media type; null when the
// body is not one the proxy can read.
function multipartParts(ct, body) {
  const b = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(ct ?? ''));
  if (!b || !body?.length) return null;
  const text = body.toString('latin1'), sep = `--${b[1] ?? b[2]}`, chunks = text.split(sep);
  if (chunks.length < 3 || !chunks[chunks.length - 1].startsWith('--')) return null;
  const parts = [];
  for (const chunk of chunks.slice(1, -1)) {
    const end = chunk.indexOf('\r\n\r\n');
    if (end < 0) return null;
    const headers = chunk.slice(0, end).split('\r\n').filter(Boolean);
    const disposition = headers.find((h) => /^content-disposition:/i.test(h)) ?? '';
    const param = (name) => { const x = new RegExp(`;\\s*${name}=(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(disposition); return x ? (x[1] ?? x[2]) : undefined; };
    const type = headers.find((h) => /^content-type:/i.test(h));
    parts.push({ name: param('name'), filename: param('filename'), type: type ? mediaType(type.slice(type.indexOf(':') + 1)) : undefined });
  }
  return parts;
}
function mediaTypeChecks(ex, bad) {
  const r = ex.route, m = ex.method, s = ex.status, ok = s >= 200 && s < 300;
  const ct = ex.reqHeaders['content-type'], empty = !ex.reqBody || ex.reqBody.length === 0;
  // 5.1 (council, round 4, decision 4b): the server reads an otherwise valid file part without filename as the file;
  // a 400 or 422 to one, where media_types admits its type, means it required filename.
  if (m === 'POST' && r.kind === 'collection' && (s === 400 || s === 422) && isObject(r.r.c.upload) && r.r.c.upload.multipart === true
    && mediaType(ct) === 'multipart/form-data') {
    const parts = multipartParts(ct, ex.reqBody), ranges = Array.isArray(r.r.c.upload.media_types) ? r.r.c.upload.media_types.map((x) => String(x).toLowerCase()) : [];
    if (parts?.length === 1 && parts[0].name === 'file' && parts[0].filename === undefined && admits(ranges, parts[0].type))
      bad('upload.filename', `a file part of ${parts[0].type} without filename got ${s}${ex.data?.code ? ` ${ex.data.code}` : ''}; the server does not require filename and reads the part as the file`);
  }
  if (m === 'PATCH' && (r.kind === 'item' || r.kind === 'singleton')) {
    if (s === 415 && !ex.resHeaders['accept-patch']) bad('media-type.accept-patch', '415 to a PATCH without Accept-Patch');
    if (!ok) return;
    if (!jsonMediaOk(ct, ['application/merge-patch+json', 'application/json'])) bad('media-type', `a PATCH with Content-Type: ${ct ?? '(none)'} got ${s}; expected 415`);
    else if (empty && ex.reqBody) bad('media-type', `a PATCH with an empty body got ${s}; expected 400 bad_request`);
    return;
  }
  // §5.1: a 415 from a collection that declares upload (also to a JSON body where it only takes files) says what it
  // accepts in Accept-Post.
  if (m === 'POST' && r.kind === 'collection' && s === 415 && isObject(r.r.c.upload) && !ex.resHeaders['accept-post'])
    bad('media-type.accept-post', `415 to a POST with Content-Type: ${ct ?? '(none)'} to a collection that declares upload, without Accept-Post`);
  const post = m === 'POST' && (r.kind === 'collection' || r.kind === 'action');
  if (!ok || !(post || (m === 'QUERY' && r.kind === 'collection'))) return;
  // §11.1: an action with POST treats an empty body, with or without Content-Type, as {}.
  if (r.kind === 'action' && empty) return;
  // §5.1: a collection that declares upload also takes a file of one of its media types, or multipart/form-data
  // where it declares "multipart": true.
  const upload = r.kind === 'collection' && m === 'POST' && isObject(r.r.c.upload) ? r.r.c.upload : null;
  if (upload) {
    const t = mediaType(ct);
    const ranges = Array.isArray(upload.media_types) ? upload.media_types.map((x) => String(x).toLowerCase()) : [];
    // §5.1 (council, decisions 1 and 2): schemas.create announces creation from JSON. With it, a JSON POST always
    // creates an item, never a file; without it, the collection only takes files, a JSON one included where
    // media_types admits it, and answers any other JSON body with 415.
    const creates = isObject(r.r.c.schemas) && r.r.c.schemas.create !== undefined;
    // 5.1 (council, round 4, decision 2): an outer multipart/form-data always selects multipart upload, and gives 415
    // unless upload.multipart is true, even when media_types admits it.
    if (t === 'multipart/form-data') {
      if (upload.multipart !== true) bad('upload.multipart', `a multipart/form-data POST to a collection whose upload does not declare "multipart": true got ${s}; expected 415${admits(ranges, t) ? ', even though media_types admits it' : ''}`);
      return;
    }
    // 5.1 (council, round 4, decision 1b): a +json type is a file like any other; only application/json selects
    // the creation of an item from JSON. A file item carries _content.
    if (t && t !== 'application/json' && t.endsWith('+json') && admits(ranges, t)) {
      if (isObject(ex.data) && ex.data._content === undefined && s === 201)
        bad('upload.json', `a POST with ${t}, which media_types admits, created an item without _content; a +json body is a file like any other`);
      return;
    }
    if (t === 'application/json') {
      const content = isObject(ex.data) && isObject(ex.data._content) ? ex.data._content : null;
      if (creates && content && /^application\/json$/i.test(mediaType(content.media_type))) {
        bad('upload.json', `a JSON POST to a collection that creates items from JSON (schemas.create) stored a file (_content with ${content.media_type}); expected an item created from its fields`);
        return;
      }
      // Council, round 4, decision 1a: also through */* or application/*.
      if (!creates && !admits(ranges, t)) {
        bad('upload.json', `a JSON POST to a collection with upload and without schemas.create, whose media_types do not admit JSON, also by a wildcard, got ${s}; expected 415`);
        return;
      }
      if (!creates) return;
    } else if (admits(ranges, t)) return;
  }
  if (!jsonMediaOk(ct, ['application/json'])) bad('media-type', `a ${m} with Content-Type: ${ct ?? '(none)'} got ${s}; expected 415`);
  else if (empty && ex.reqBody) bad('media-type', `a ${m} with an empty body and application/json got ${s}; expected 400 bad_request`);
}

// §5.9: un singleton.
function singletonChecks(ex, bad) {
  const c = ex.route.r.c, p = ex.params, s = ex.status, ok = s >= 200 && s < 300, m = ex.method, d = ex.data;
  const declared = Array.isArray(c.methods) ? c.methods : null;
  if (s === 405 && declared && ex.resHeaders.allow) {
    const allow = ex.resHeaders.allow.split(',').map((x) => x.trim().toUpperCase()).filter((x) => FOUR.includes(x));
    const missing = declared.filter((x) => !allow.includes(x)), extra = allow.filter((x) => !declared.includes(x));
    if (missing.length || extra.length) bad('allow', `Allow: ${ex.resHeaders.allow}; declared ${declared.join(', ')}`);
  }
  if (s === 405 && declared?.includes(m === 'HEAD' ? 'GET' : m)) bad('allow', `${m} is declared and got 405`);
  if (ok && (m === 'POST' || m === 'DELETE')) bad('singleton', `${m} to a singleton got ${s}; expected 405`);
  if (ok && m === 'GET' && !isObject(d) && !ex.bodyError) bad('singleton', 'the singleton\'s GET does not return a JSON object');
  // 5.3 and 5.9: on a singleton only fields (with query, on GET and HEAD); the other reserved ones fail loudly.
  if (ok) for (const k of new Set(p.keys())) {
    if (!isReservedName(k)) continue;
    if (k === 'fields' && has('query') && (m === 'GET' || m === 'HEAD')) continue;
    bad('reserved', `${k} was ignored on a singleton; expected 400 unsupported_parameter`);
  }
  if (ok && m === 'GET' && isObject(d) && once(p, 'fields') && has('query')) {
    const allowed = new Set(['id', ...p.get('fields').split(',')]);
    const extra = Object.keys(d).filter((k) => !allowed.has(k) && !k.startsWith('_'));
    if (extra.length) bad('fields', `fields=${p.get('fields')} and the singleton also returns ${extra.slice(0, 5).join(', ')}`);
  }
}

// §8: cache. ETag on the full GET of an item or a singleton, and 304 for a matching If-None-Match.
function cacheChecks(ex, bad) {
  const r = ex.route, p = ex.params, s = ex.status, m = ex.method, rh = ex.resHeaders, q = ex.reqHeaders;
  const full = !p.has('fields') && !p.has('include');
  if ((r.kind === 'item' || r.kind === 'singleton') && m === 'GET' && s === 200 && full && !rh.etag && !has('writes'))
    bad('cache-etag', `the GET of the full ${r.kind === 'item' ? 'item' : 'singleton'} carries no ETag`);
  if ((m === 'GET' || m === 'HEAD') && s === 200 && q['if-none-match'] && rh.etag) {
    const list = etagList(q['if-none-match']);
    if (list.some((t) => t === '*' || weakEq(t, rh.etag))) bad('if-none-match', `If-None-Match: ${q['if-none-match']} matches the ETag ${rh.etag} and the response is 200, not 304`);
  }
}

function errorChecks(ex, bad) {
  const rh = ex.resHeaders, s = ex.status;
  if (s === 401 && !rh['www-authenticate']) bad('error.401', 'no WWW-Authenticate');
  if (s === 405 && !rh.allow) bad('error.405', 'no Allow');
  if ((s === 429 || s === 503) && !rh['retry-after']) bad('error.retry-after', 'no Retry-After');
  if (s === 409 && ex.data?.code === 'request_in_progress' && !rh['retry-after']) bad('error.retry-after', '409 request_in_progress without Retry-After');
  // 5.4: these depend on the request, not on the resource: no cache may keep them.
  if ([428, 429, 431, 511].includes(s) && !/\bno-store\b/i.test(rh['cache-control'] ?? '')) bad('error.no-store', `${s} with Cache-Control: ${rh['cache-control'] ?? '(none)'}`);
  if (ex.method === 'HEAD' || !ex.size) return;
  const t = mediaType(rh['content-type']);
  if (t !== 'application/problem+json') bad('error.media-type', `Content-Type: ${t || '(none)'}`);
  const d = ex.data;
  if (!isObject(d)) { if (!ex.bodyError) bad('error.schema', 'the body is not a JSON object'); return; }
  const problems = schemaErrors(PROBLEM_SCHEMA, d);
  if (problems.length) bad('error.schema', problems.slice(0, 4).join('; '));
  if (d.status !== undefined && d.status !== s) bad('error.status', `status ${JSON.stringify(d.status)} in a ${s} response`);
  if (typeof d.code === 'string') {
    const codes = expectedCodes(s);
    if (!codes.includes(d.code)) bad('error.code', `code "${d.code}" for ${s}; expected ${codes.join(' or ')}`);
    if (d.type === 'about:blank') {
      // 5.4: about:blank says the problem has no semantics beyond its status (RFC 9457, 4.2.1).
      const plain = (codes.length === 1 && codes[0] === d.code) || /^http_\d{3}$/.test(d.code);
      const extra = ['reason', 'errors', 'parameter'].filter((k) => d[k] !== undefined);
      if (!plain || extra.length) bad('error.about-blank', `type about:blank with code ${d.code}${extra.length ? ` and ${extra.join(', ')}` : ''}`);
    } else if (typeof d.type === 'string' && !(/^[a-z][a-z0-9+.-]*:/i.test(d.type)
      && (!d.type.startsWith(`${PROFILE}errors#`) || d.type === `${PROFILE}errors#${d.code}`)))
      bad('error.type', `type ${d.type} for code ${d.code}`);
  }
  if (!(typeof d.detail === 'string' && d.detail)) bad('error.detail', 'no detail');
  // 5.4: reason follows the grammar of names and, with reasons declared, is one of them with its code.
  if (d.reason !== undefined) {
    const declared = isObject(disc?.reasons) ? disc.reasons : null;
    if (typeof d.reason !== 'string' || !NAME.test(d.reason)) bad('error.reason', `reason ${JSON.stringify(d.reason)} does not follow the naming grammar`);
    else if (declared && !Object.hasOwn(declared, d.reason)) bad('error.reason', `reason "${d.reason}" is not in reasons`);
    else if (declared && declared[d.reason]?.code !== d.code) bad('error.reason', `reason "${d.reason}" comes with code ${d.code}; reasons says ${declared[d.reason]?.code}`);
  }
  if (d.code === 'invalid_parameter' || d.code === 'unsupported_parameter') {
    if (!(typeof d.parameter === 'string' && d.parameter)) bad('error.parameter', `${d.code} without parameter`);
    else if (d.code === 'unsupported_parameter' && ex.method !== 'QUERY' && !ex.params.has(d.parameter))
      bad('error.parameter', `parameter "${d.parameter}" is none of the ones received (${[...new Set(ex.params.keys())].join(', ') || 'none'})`);
  }
}

// The filter declaration of a field, or undefined.
const filterDecl = (c, f) => (isObject(c.filter) && isObject(c.filter[f]) ? c.filter[f] : undefined);
// The declaration of a named filter (6.1), or undefined. Without type it is a switch.
const namedDecl = (c, f) => (isObject(c.named_filters) && isObject(c.named_filters[f]) ? c.named_filters[f] : undefined);
// 6.1: a switch takes no value, except false on one declared "default": true, which turns it off.
const namedValueOk = (d, raw) => (typeof d.type !== 'string' ? raw === '' || (d.default === true && raw === 'false') : raw !== '' && norm(d.type, raw) !== undefined && enumOk(d, raw));
const opsOf = (d) => (Array.isArray(d?.ops) ? d.ops : []);
const parseFilterKey = (k) => { const m = k.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/); return m ? { field: m[1], op: m[2] ?? 'eq' } : null; };
// Whether a filter's value fits its type (6.1), to know whether a rejection is legitimate.
function filterValueOk(decl, op, raw) {
  if (op === 'null') return raw === 'true' || raw === 'false';
  if (op === 'in' || op === 'nin') return raw !== '' && raw.split(',').every((v) => norm(decl.type, v) !== undefined && enumOk(decl, v));
  if (op === 'prefix' || op === 'contains') return raw !== '';
  return norm(decl.type, raw) !== undefined && enumOk(decl, raw);
}
const enumOk = (decl, v) => decl.type !== 'enum' || !Array.isArray(decl.values) || decl.values.includes(v);
// 6.1 and 11.1 (council, decision 7): whether a numeric operand, or each element of a list, follows the number grammar.
const NUMERIC_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin'];
const numericOk = (type, raw, list) => (list ? raw.split(',') : [raw]).every((v) => norm(type, v) !== undefined);
// The judgement on one numeric parameter: accepted although invalid, or rejected with invalid_parameter although valid.
function operandJudgement(ex, key, type, list, bad, what) {
  const p = ex.params, s = ex.status, raw = p.get(key);
  if (!once(p, key) || (type !== 'integer' && type !== 'number')) return;
  const valid = numericOk(type, raw, list);
  if (s >= 200 && s < 300 && !valid) bad('query.operand', `${key}=${raw} is not a valid ${type} ${what} (the number grammar of RFC 8259) and got ${s}; expected 400 invalid_parameter`);
  // 5.3 and 6.1 (council, round 4, decision 6): an operand outside the range of a double may be over a request
  // limit the server does not declare, so its invalid_parameter is not judged; any other rejection is.
  const beyond = valid && (list ? raw.split(',') : [raw]).some(beyondDouble);
  if (s === 400 && ex.data?.code === 'invalid_parameter' && ex.data.parameter === key && valid && !beyond)
    bad('query.operand', `${key}=${raw} is a valid ${type} ${what} and was rejected with invalid_parameter`);
  else if (beyond && ((s === 400 && ex.data?.code !== 'invalid_parameter') || s === 422 || s === 500)
    && (ex.data?.parameter === key || [...new Set(p.keys())].length === 1))
    bad('query.operand', `${key}=${raw} is a valid ${type} ${what} outside the range of a double and got ${s}${ex.data?.code ? ` ${ex.data.code}` : ''}; expected a comparison as a number, exactly, or 400 invalid_parameter if it is over a request limit`);
}
function operandChecks(ex, bad) {
  const c = ex.route.r.c;
  if (ex.route.kind !== 'collection' || (ex.method !== 'GET' && ex.method !== 'HEAD') || !has('query')) return;
  const retired = retiredNames(c);
  for (const k of new Set(ex.params.keys())) {
    const f = parseFilterKey(k), decl = f && filterDecl(c, f.field);
    if (!decl || !NUMERIC_OPS.includes(f.op) || !opsOf(decl).includes(f.op) || retired.filter.has(f.field)) continue;
    operandJudgement(ex, k, decl.type, f.op === 'in' || f.op === 'nin', bad, 'operand');
  }
}
const once = (params, k) => params.getAll(k).length === 1;
// 6.1: the group a filter joins, as restep-check sees it: a to-many relationship (its own, or the first step of a
// path) or a field declared with quantifier.
function quantifiedGroup(c, f) {
  const seg = f.split('.')[0], r = isObject(c?.relations) ? c.relations[seg] : undefined;
  if (isObject(r) && r.many === true) return seg;
  return isObject(c?.filter?.[f]) && c.filter[f].quantifier !== undefined ? f : null;
}
// 6.1 (council, round 4, decision 5a): more than one null filter on the same to-many relationship or list field,
// its own or that of a path through it, gives invalid_parameter, even when their values agree.
function nullOnceChecks(ex, bad) {
  const c = ex.route.r.c, s = ex.status;
  if (ex.route.kind !== 'collection' || (ex.method !== 'GET' && ex.method !== 'HEAD') || !has('query')) return;
  if (!((s >= 200 && s < 300) || (s === 400 && ex.data?.code !== 'invalid_parameter'))) return;
  const retired = retiredNames(c), groups = new Map();
  for (const k of new Set(ex.params.keys())) {
    const f = parseFilterKey(k), decl = f && f.op === 'null' && filterDecl(c, f.field), g = decl && quantifiedGroup(c, f.field);
    if (!g || !opsOf(decl).includes('null') || retired.filter.has(f.field) || !once(ex.params, k) || !filterValueOk(decl, 'null', ex.params.get(k))) continue;
    groups.set(g, [...(groups.get(g) ?? []), `${k}=${ex.params.get(k)}`]);
  }
  for (const [g, keys] of groups) if (keys.length > 1)
    bad('query.null-once', `${keys.join(' and ')}: two null filters on the group ${g} got ${s}${s >= 400 ? ` ${ex.data?.code ?? ''}`.trimEnd() : ''}; expected 400 invalid_parameter, even when their values agree`);
}

// 5.3: which reserved parameters this resource implements with this method.
function implemented(r, method) {
  const out = new Set();
  if (method !== 'GET' && method !== 'HEAD') return out;
  const c = r.r.c;
  if (has('query')) {
    out.add('fields');
    if (r.kind === 'collection') {
      out.add('limit'); out.add('cursor');
      if ([c.filter, c.named_filters].some((x) => isObject(x) && Object.keys(x).length)) out.add('filter');
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
  // 6.1: a list request without a required filter gives invalid_parameter.
  if (ok && r.kind === 'collection' && (ex.method === 'GET' || ex.method === 'HEAD') && !r.action) {
    const present = new Set(keys.map((k) => parseFilterKey(k)?.field).filter(Boolean));
    for (const [f, d] of [...Object.entries(isObject(c.filter) ? c.filter : {}), ...Object.entries(isObject(c.named_filters) ? c.named_filters : {})])
      if (isObject(d) && d.required === true && !present.has(f)) { bad('query.required', `a list request without filter[${f}], which is required, got ${ex.status}; expected 400 invalid_parameter`); break; }
  }
  // Success with something that should have failed loudly.
  if (ok) {
    for (const k of keys) {
      if (!isReservedName(k)) continue;
      const base = baseName(k);
      // 5.3: the forms Restep defines are name=value and, for filter, filter[field] and filter[field][op].
      const formOk = k.startsWith('$') ? false : base === 'filter' ? (k === 'filter' ? has('filter-expr') : /^filter\[[^\]]+\](\[[^\]]+\])?$/.test(k)) : k === base;
      if (!impl.has(base) || !formOk) { bad('reserved', `${k} was ignored; expected 400 unsupported_parameter`); continue; }
      if (base === 'filter' && k !== 'filter') {
        const f = parseFilterKey(k);
        const named = f && namedDecl(c, f.field);
        if (named) {
          if (k.includes('][')) bad('query.undeclared', `${f.field} is a named filter and takes no operator: ${k} was accepted`);
          else if (once(p, k) && !namedValueOk(named, p.get(k))) bad('query.named-value', `${k}=${p.get(k)} was accepted; ${typeof named.type === 'string' ? `expected a ${named.type} value` : 'a switch takes no value'}`);
          continue;
        }
        const decl = f && filterDecl(c, f.field);
        if (!f) bad('query.undeclared', `${k} is neither filter[field] nor filter[field][op] and was accepted`);
        else if (!decl) bad('query.undeclared', `the field ${f.field} is not declared in filter and was accepted`);
        else if (!opsOf(decl).includes(f.op)) bad('query.undeclared', `${f.field} does not declare the operator ${f.op} and was accepted`);
      }
    }
    // 9: include only of declared, expandable relationships, up to include_depth, not following past a to-many one.
    if (impl.has('include') && once(p, 'include')) {
      const depth = Number.isInteger(c.include_depth) ? c.include_depth : 1;
      for (const path of p.get('include').split(',')) {
        const segs = path.split('.');
        let cur = c, why = segs.length > depth ? `exceeds include_depth (${depth})` : null;
        for (let i = 0; i < segs.length && !why; i++) {
          const rel = isObject(cur?.relations) ? cur.relations[segs[i]] : undefined;
          if (!isObject(rel)) why = `${segs.slice(0, i + 1).join('.')} is not a declared relation`;
          else if (rel.include !== true) why = `${segs.slice(0, i + 1).join('.')} is not expandable`;
          else if (Array.isArray(rel.to) && i < segs.length - 1) why = `it continues past ${segs[i]}, which goes to several collections`;
          else cur = Array.isArray(rel.to) ? null : disc.collections?.[rel.to];
        }
        if (why) { bad('relations.include', `include=${path} was accepted and ${why}; expected 400 unsupported_parameter`); break; }
      }
    }
    // 9: a dotted path in fields requires its relationship to be in include.
    if (has('relations') && once(p, 'fields')) {
      const inc = new Set((once(p, 'include') ? p.get('include').split(',') : []).flatMap((x) => x.split('.').map((_, i, a) => a.slice(0, i + 1).join('.'))));
      const lost = p.get('fields').split(',').find((f) => f.includes('.') && !(isObject(c.language_maps) && f.split('.')[0] in c.language_maps)
        && !inc.has(f.slice(0, f.lastIndexOf('.'))));
      if (lost) bad('relations.fields', `fields with ${lost} was accepted without include=${lost.slice(0, lost.lastIndexOf('.'))}; expected invalid_parameter`);
    }
    if (impl.has('sort') && once(p, 'sort')) {
      const undeclared = p.get('sort').split(',').map((x) => x.replace(/^-/, '')).filter((f) => f && !c.sort.includes(f));
      if (undeclared.length) bad('query.undeclared', `sort by ${undeclared.join(', ')}, which is not declared, was accepted`);
    }
    return;
  }
  // Rejection, as unsupported, of something declared.
  if (s !== 400 || ex.data?.code !== 'unsupported_parameter' || typeof ex.data.parameter !== 'string') return;
  const k = ex.data.parameter, base = baseName(k);
  if (!impl.has(base) || !p.has(k) || !once(p, k)) return;
  const retired = retiredNames(c);
  if (base === 'filter' && k !== 'filter') {
    const f = parseFilterKey(k), named = f && namedDecl(c, f.field);
    if (named) {
      if (!k.includes('][') && !retired.filter.has(f.field) && namedValueOk(named, p.get(k))) bad('query.declared-rejected', `${k}=${p.get(k)} is a declared named filter and was rejected with unsupported_parameter`);
      return;
    }
    const decl = f && filterDecl(c, f.field);
    if (!decl || !opsOf(decl).includes(f.op) || retired.filter.has(f.field)) return;
    const dupe = keys.filter((x) => { const g = parseFilterKey(x); return g && g.field === f.field && g.op === f.op; }).length > 1;
    if (!dupe && filterValueOk(decl, f.op, p.get(k))) bad('query.declared-rejected', `${k}=${p.get(k)} is declared and was rejected with unsupported_parameter`);
  } else if (base === 'sort' && k === 'sort') {
    const fs = p.get('sort').split(',').map((x) => x.replace(/^-/, ''));
    if (fs.every((f) => f && c.sort.includes(f) && !retired.sort.has(f))) bad('query.declared-rejected', `sort=${p.get('sort')} is declared and was rejected with unsupported_parameter`);
  } else if (k === 'count') {
    if (p.get('count') === 'true' || p.get('count') === 'false') bad('query.declared-rejected', `count=${p.get('count')} with count declared (${c.count}) was rejected with unsupported_parameter`);
  } else if (k === 'limit' || k === 'cursor' || (k === 'fields' && !p.get('fields').includes('.'))) {
    bad('query.declared-rejected', `${k} belongs to query, which the server announces, and was rejected with unsupported_parameter`);
  }
}

function resourceChecks(ex, bad) {
  const r = ex.route, c = r.r.c, p = ex.params, s = ex.status, ok = s >= 200 && s < 300, d = ex.data, m = ex.method;
  const minimal = /(^|[\s,;])return=minimal\b/i.test(ex.reqHeaders.prefer ?? '');
  const declared = r.kind === 'collection' ? c.methods : c.item_methods;

  // 4.3: Allow matches the declared methods.
  if (Array.isArray(declared)) {
    if (s === 405 && ex.resHeaders.allow) {
      const allow = ex.resHeaders.allow.split(',').map((x) => x.trim().toUpperCase()).filter((x) => FOUR.includes(x));
      const missing = declared.filter((x) => !allow.includes(x)), extra = allow.filter((x) => !declared.includes(x));
      if (missing.length || extra.length) bad('allow', `Allow: ${ex.resHeaders.allow}; declared ${declared.join(', ')}`);
    }
    if (s === 405 && declared.includes(m === 'HEAD' ? 'GET' : m)) bad('allow', `${m} is declared and got 405`);
  }

  // 5.1: success statuses.
  if (ok) {
    const want = m === 'GET' || m === 'HEAD' ? [200] : m === 'POST' && r.kind === 'collection' ? [201]
      : m === 'PATCH' && r.kind === 'item' ? (minimal ? [200, 204] : [200]) : m === 'DELETE' && r.kind === 'item' ? [204] : null;
    if (want && !want.includes(s)) bad('status.success', `${m} got ${s}; expected ${want.join(' or ')}`);
  }
  // 5.1: Location of a 201 and the id is assigned by the server.
  if (m === 'POST' && r.kind === 'collection') {
    if (s === 201) {
      const loc = ex.resHeaders.location;
      if (!loc) bad('location', '201 without Location');
      else if (isObject(d) && typeof d.id === 'string') {
        let path = loc;
        try { path = decodeURIComponent(new URL(loc, target).pathname); } catch {}
        const want = `${decodeURIComponent(ex.pathname).replace(/\/$/, '')}/${d.id}`;
        if (path !== want) bad('location', `Location: ${loc}; expected ${want}`);
      }
    }
    // 5.1: who chooses the id is told by id_from (undeclared means "server").
    const from = c.id_from ?? 'server';
    if (ok && isObject(ex.reqJson) && 'id' in ex.reqJson && (from === 'server'))
      bad('id.assigned', `a POST with "id": ${JSON.stringify(ex.reqJson.id)} got ${s}; id_from is ${JSON.stringify(c.id_from)}, expected 422 invalid`);
    if (ok && isObject(ex.reqJson) && !('id' in ex.reqJson) && from === 'client')
      bad('id.assigned', `a POST without id got ${s}; id_from is "client", expected 422 invalid with required at /id`);
  }
  if (m === 'PATCH' && r.kind === 'item' && ok) {
    if (ex.reqJsonParsed && !isObject(ex.reqJson)) bad('patch.object', `a patch ${Array.isArray(ex.reqJson) ? 'that is an array' : 'that is not an object'} got ${s}; expected 422 invalid with a type entry at ""`);
    else if (ex.reqJsonInvalid) bad('patch.object', `a patch that is not JSON got ${s}; expected 400 bad_request`);
    if (isObject(ex.reqJson) && 'id' in ex.reqJson && ex.reqJson.id !== r.id) bad('id.assigned', `a PATCH with "id": ${JSON.stringify(ex.reqJson.id)} to ${r.id} got ${s}; expected 422 invalid`);
  }

  if (!ok || !isObject(d)) return;
  const fields = once(p, 'fields') && has('query') && (m === 'GET' || m === 'HEAD') ? p.get('fields').split(',') : null;
  let items = [];
  if (r.kind === 'collection' && (m === 'GET')) {
    // 5.2: collection shape.
    if (!Array.isArray(d.items) || !('next' in d)) { bad('collection.shape', `the body is not {items, next}${Array.isArray(d.items) ? ': missing next' : ''}`); return; }
    if (!(d.next === null || typeof d.next === 'string')) { bad('collection.shape', `next is ${JSON.stringify(d.next)}, neither a string nor null`); return; }
    items = d.items.filter(isObject);
    // 7.2: an item that admits PATCH or DELETE carries its item ETag in _etag; in a collection
    // that declares sync, on every page and as a MUST.
    if (has('writes') && Array.isArray(c.item_methods) && c.item_methods.some((x) => x === 'PATCH' || x === 'DELETE')) {
      const missing = items.filter((it) => typeof it._etag !== 'string');
      if (missing.length) bad(synced(c) ? 'etag.synced' : 'etag.collection', `${missing.length} of ${items.length} items without _etag (the first, ${JSON.stringify(missing[0].id)}); they allow ${c.item_methods.join(', ')}`);
    }
    if (typeof d.next === 'string') nextChecks(ex, d.next, bad);
    if (has('query')) queryChecks(ex, items, fields, bad);
  } else if (r.kind === 'item' && m !== 'DELETE') items = [d];
  else return;

  // 6.3: fields.
  if (fields) {
    const allowed = new Set(['id', ...fields.map((f) => f.split('.')[0])]);
    for (const it of items) {
      const extra = Object.keys(it).filter((k) => !allowed.has(k) && !k.startsWith('_'));
      if (extra.length) { bad('fields', `fields=${p.get('fields')} and the item ${it.id} also returns ${extra.slice(0, 5).join(', ')}`); break; }
    }
  }
  // 3, 4.2, 11.6: consistency with the discovery document.
  for (const it of items) {
    const problems = itemProblems(c, it, !!fields || p.has('include'));
    if (problems.length) { bad('item.discovery', problems.slice(0, 3).join('; ')); break; }
  }
  // 3 and 9: type on relationships to several collections, href on those that lead to a subcollection.
  for (const it of items) {
    const problems = linkProblems(c, it);
    if (problems.length) { bad('relations.link', problems.slice(0, 3).join('; ')); break; }
  }
  // 11.1: _actions only lists declared actions, item ones and with their method.
  if (has('actions')) for (const it of items) {
    if (!isObject(it._actions)) continue;
    const decl = isObject(c.actions) ? c.actions : {};
    const wrong = Object.entries(it._actions).find(([n, v]) => !isObject(decl[n]) || decl[n].on !== 'item' || (isObject(v) && v.method !== undefined && v.method !== (decl[n].method ?? 'POST')));
    if (wrong) { bad('actions.listed', `the item ${it.id} lists in _actions ${wrong[0]} (${JSON.stringify(wrong[1])}), which ${isObject(decl[wrong[0]]) ? 'is declared differently' : 'is not declared'}`); break; }
  }
}
// §3: a server never writes a leap second (:60) and rejects one in a request body with 422 invalid and a format
// entry. The proxy knows which fields are instants from their filter declarations (type datetime).
function leapChecks(ex, bad) {
  const c = ex.route.r.c, s = ex.status, ok = s >= 200 && s < 300, m = ex.method, d = ex.data;
  // 3: the datetime and localdatetime fields the document declares (in filter or, local date-times, in local_times).
  const fields = [...new Set([...Object.entries(isObject(c.filter) ? c.filter : {})
    .filter(([, x]) => isObject(x) && (x.type === 'datetime' || x.type === 'localdatetime') && x.quantifier === undefined).map(([f]) => f),
  ...Object.keys(isObject(c.local_times) ? c.local_times : {})])];
  if (!fields.length) return;
  const leapIn = (it) => fields.find((f) => isLeap(get(it, f)));
  const items = ok && isObject(d) ? (Array.isArray(d.items) ? d.items.filter(isObject) : [d]) : [];
  for (const it of items) {
    const f = leapIn(it);
    if (f) { bad('leap-second', `the item ${it.id ?? '?'} writes ${f} = ${JSON.stringify(get(it, f))}, with a leap second`); break; }
  }
  // 3 and 5.1: in a POST the field may be one only the server sets, which the POST ignores whatever its value; the
  // proxy cannot tell, so it judges only a PATCH, where such a field with another value gives a read_only entry.
  const write = m === 'PATCH' && ex.route.kind === 'item';
  const f = write && isObject(ex.reqJson) ? leapIn(ex.reqJson) : undefined;
  if (!f) return;
  const v = JSON.stringify(get(ex.reqJson, f));
  if (ok) bad('leap-second', `a ${m} with ${f} = ${v}, a leap second, got ${s}; expected 422 invalid with a format entry`);
  else if (s === 422 && ex.data?.code === 'invalid' && !(Array.isArray(ex.data.errors) && ex.data.errors.some((e) => e?.code === 'format' || e?.code === 'read_only')))
    bad('leap-second', `a ${m} with ${f} = ${v}, a leap second, got 422 invalid without a format entry`);
}

// 3 (council, decision 10): an unpaired surrogate or a noncharacter in a request body. The format entry that reports
// it points at the string that holds it, or at "" when that string is a member name: a pointer to the member would
// have to carry the same code point. The proxy flags an entry that points at such a member.
const BAD_CODE_POINT = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFDD0-\uFDEF\uFFFE\uFFFF]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;
const ptrToken = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');
function ijsonChecks(ex, bad) {
  const d = ex.data;
  if (d?.code !== 'invalid' || !Array.isArray(d.errors)) return;
  const names = new Set(), values = new Set();
  const walk = (v, at) => {
    if (typeof v === 'string') { if (BAD_CODE_POINT.test(v)) values.add(at); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}/${i}`)); return; }
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const here = `${at}/${ptrToken(k)}`;
      if (BAD_CODE_POINT.test(k)) names.add(here);
      walk(x, here);
    }
  };
  walk(ex.reqJson, '');
  const wrong = d.errors.find((e) => e?.code === 'format' && typeof e.pointer === 'string' && names.has(e.pointer) && !values.has(e.pointer));
  if (wrong) bad('i-json', `the format entry points at ${JSON.stringify(wrong.pointer)}, a member whose name holds an unpaired surrogate or a noncharacter; expected ""`);
}

// The discovery collection that is a subcollection (with parent or with a template in path).
const isSub = (name) => { const c = disc?.collections?.[name]; return isObject(c) && (c.parent !== undefined || /[{}]/.test(String(c.path))); };
function linkProblems(c, it) {
  const out = [];
  for (const [rel, decl] of Object.entries(isObject(c.relations) ? c.relations : {})) {
    if (!isObject(decl) || !(rel in it) || it[rel] === null) continue;
    const to = [].concat(decl.to ?? []);
    for (const v of [].concat(it[rel])) {
      if (!isObject(v)) continue;
      const kind = Array.isArray(decl.to) ? v.type : decl.to;
      if (Array.isArray(decl.to) && !to.includes(v.type)) out.push(`${it.id}.${rel} goes to several collections and its link ${v.id} carries no type from ${to.join(', ')}`);
      else if (isSub(kind) && (typeof v.href !== 'string' || !String(v.href).replace(/\/+$/, '').endsWith(`/${v.id}`)))
        out.push(`${it.id}.${rel} links ${v.id}, from the subcollection ${kind}, without an href ending in its id`);
    }
  }
  return out;
}
// 11.1: an action.
function actionChecks(ex, bad) {
  const r = ex.route, s = ex.status, ok = s >= 200 && s < 300, m = ex.method;
  const decl = isObject(r.r.c.actions) ? r.r.c.actions[r.action] : undefined;
  const kind = r.id ? 'item' : 'collection';
  if (ok && (!isObject(decl) || decl.on !== kind)) bad('actions.undeclared', `${r.action} ${isObject(decl) ? `is declared on the other kind of resource (${decl.on})` : 'is not declared'} and got ${s}; expected 404`);
  if (!isObject(decl) || decl.on !== kind) return;
  const method = decl.method ?? 'POST';
  if (ok && m !== method && !(method === 'GET' && m === 'HEAD')) bad('actions.undeclared', `${r.action} is declared with ${method} and ${m} got ${s}; expected 405`);
  if (ok && m === method && m === 'POST') {
    if (![200, 201, 204].includes(s)) bad('actions.response', `${r.action} got ${s}; expected 200, 201 or 204`);
    if (s === 201 && !ex.resHeaders.location) bad('actions.response', `${r.action} got 201 without Location`);
    // 11.1: an unsafe action on a collection has no representation of its own: 201 or 204, never 200.
    if (s === 200 && kind === 'collection' && decl.safe !== true) bad('actions.response', `${r.action}, an unsafe collection action, got 200; expected 201 with Location or 204`);
    // 7.2: a 204 to an action carries no ETag.
    if (s === 204 && ex.resHeaders.etag !== undefined) bad('actions.response', `${r.action} got 204 with ETag ${ex.resHeaders.etag}`);
  }
  // 5.3 and 11.1: a GET action takes only the query parameters its params declare; without params, none. A reserved
  // name follows the general rule of 5.3 (reserved).
  if (method === 'GET' && (m === 'GET' || m === 'HEAD')) {
    const params = isObject(decl.params) ? decl.params : {};
    const extra = [...new Set(ex.params.keys())].filter((k) => !isReservedName(k) && !Object.hasOwn(params, k));
    if (ok && extra.length) bad('actions.params', `${r.action} ${decl.params === undefined ? 'declares no params' : `does not declare ${extra.join(', ')} in params`} and ${m} with ${extra.join(', ')} got ${s}; expected 400 unsupported_parameter`);
    const named = ex.data?.parameter;
    if (s === 400 && ex.data?.code === 'unsupported_parameter' && typeof named === 'string' && Object.hasOwn(params, named) && once(ex.params, named))
      bad('actions.params', `${r.action} declares ${named} in params and rejected it with unsupported_parameter`);
    // 11.1 (council, decision 7): integer and number params, each list element too, follow the grammar of 6.1.
    if (!extra.length) for (const [name, pd] of Object.entries(params)) if (isObject(pd) && ex.params.has(name)) operandJudgement(ex, name, pd.type, pd.list === true, bad, 'parameter');
  }
  // 11.1: a safe action creates nothing, and its result with output is not a representation.
  if (ok && decl.safe === true && s === 201) bad('actions.response', `${r.action}, a safe action, got 201`);
  if (s === 200 && decl.output !== undefined && isObject(ex.data) && ('_etag' in ex.data || '_actions' in ex.data))
    bad('actions.response', `${r.action} declares output and its result carries ${'_etag' in ex.data ? '_etag' : '_actions'}`);
  const empty = !ex.reqBody || ex.reqBody.length === 0;
  if (m === 'POST' && method === 'POST' && empty && (s === 415 || (s === 400 && ex.data?.code === 'bad_request' && !(ex.data.errors ?? []).some((e) => e?.header))))
    bad('actions.empty-body', `${r.action} with an empty body got ${s}; expected it to be treated as {}`);
}

// 6.4: next keeps the parameters and carries a cursor.
function nextChecks(ex, next, bad) {
  if (!(/^[a-z][a-z0-9+.-]*:/i.test(next) || (next.startsWith('/') && !next.startsWith('//')))) {
    bad('links', `next ${next} is neither an absolute URI nor an absolute path`);
    return;
  }
  if (next.startsWith('/') && rootPath !== '/' && !next.startsWith(rootPath)) bad('links', `next ${next} does not include the root path ${rootPath}`);
  // 5.2: in the links it builds, the server percent-encodes [ and ] (RFC 3986, 3.4).
  if (/[[\]]/.test(next.split('?').slice(1).join('?'))) bad('links', `next ${next} carries [ or ] unencoded in its query`);
  if (!has('query') || ex.method === 'QUERY') return;
  let u;
  try { u = new URL(next, target); } catch { return bad('links', `next ${next} is not a URL`); }
  if (!u.searchParams.has('cursor')) bad('next', `next ${next} carries no cursor`);
  const pairs = (sp) => [...sp].filter(([k]) => k !== 'cursor').map(([k, v]) => `${k}=${v}`).sort().join('&');
  const want = pairs(ex.params), got = pairs(u.searchParams);
  if (want !== got) bad('next', `next changes the parameters: "${got || '(none)'}" instead of "${want || '(none)'}"`);
  else if (u.pathname !== ex.pathname) bad('next', `next points to ${u.pathname}, not to ${ex.pathname}`);
}

function queryChecks(ex, items, fields, bad) {
  const c = ex.route.r.c, p = ex.params, d = ex.data;
  const shown = (f) => !fields || fields.some((x) => x.split('.')[0] === f.split('.')[0]);
  // 6.1: each item meets each filter.
  for (const [k, raw] of p) {
    const f = parseFilterKey(k);
    const decl = f && filterDecl(c, f.field);
    if (!decl || !opsOf(decl).includes(f.op) || !shown(f.field) || !filterValueOk(decl, f.op, raw)) continue;
    // 6.1 (council, decision 9): null with quantifier tests the whole list (groupNullChecks).
    if (f.op === 'null' && decl.quantifier !== undefined) { groupNullCheck(ex, items, f.field, decl, raw, bad); continue; }
    // 6.1: a filter with quantifier reads related items the proxy does not see, and prefix or contains with a
    // collation other than code points compare as the server does.
    if (decl.quantifier !== undefined || ((f.op === 'prefix' || f.op === 'contains') && (c.collations?.[f.field] ?? 'codepoint') !== 'codepoint')) continue;
    // 9: an item need not list a relationship's links; without the member the proxy cannot judge it.
    const rel = isObject(c.relations) && isObject(c.relations[f.field]);
    const miss = items.find((it) => !(rel && get(it, f.field) === undefined) && !matches(decl.type, f.op, get(it, f.field), raw));
    if (miss) bad('filter.match', `${k}=${raw} and the item ${miss.id} has ${f.field} = ${JSON.stringify(get(miss, f.field)) ?? '(absent)'}`
      + ((decl.type === 'integer' || decl.type === 'number') && raw.split(',').some(beyondDouble) ? ': an operand outside the range of the field is compared as a number, exactly, never replaced by an infinity or zero' : ''));
  }
  // 6.2: order within the page.
  if (once(p, 'sort') && Array.isArray(c.sort)) {
    const keys = p.get('sort').split(',').map((x) => ({ desc: x.startsWith('-'), f: x.replace(/^-/, '') }));
    if (keys.every((k) => k.f && c.sort.includes(k.f) && shown(k.f))) {
      const types = keys.map((k) => filterDecl(c, k.f)?.type ?? inferType(items, k.f));
      const order = (a, b) => {
        for (let i = 0; i < keys.length; i++) {
          if (!types[i]) return 0; // without a known type it cannot be judged
          const x = get(a, keys[i].f), y = get(b, keys[i].f);
          if (blank(x) && blank(y)) continue;
          if (blank(x) || blank(y)) return blank(x) ? 1 : -1; // without a value, last in both directions
          const nx = norm(types[i], x), ny = norm(types[i], y);
          if (nx === undefined || ny === undefined) return 0;
          const v = cmp(types[i], nx, ny) * (keys[i].desc ? -1 : 1);
          if (v) return v;
        }
        return 0;
      };
      for (let i = 1; i < items.length; i++) {
        if (order(items[i - 1], items[i]) > 0) { bad('sort.order', `sort=${p.get('sort')}: ${items[i - 1].id} comes before ${items[i].id}`); break; }
      }
    }
  }
  // 6.4: limit.
  if (p.has('limit')) {
    const raw = p.get('limit'), n = Number(raw), max = Number.isInteger(c.max_limit) ? c.max_limit : Infinity;
    if (!once(p, 'limit')) bad('limit', 'limit repeated and accepted; expected invalid_parameter');
    else if (!/^\d+$/.test(raw) || n < 1 || n > max) bad('limit', `limit=${raw} outside 1..${c.max_limit ?? '∞'} and accepted; expected invalid_parameter`);
    else if (items.length > n) bad('limit', `limit=${n} and the page returns ${items.length} items`);
  }
  // 6.5: count.
  if (p.get('count') === 'true') {
    if (!c.count) { /* flagged by reserved */ } else if (!(Number.isInteger(d.total) && d.total >= 0)) bad('count', `count=true and total is ${JSON.stringify(d.total) ?? '(absent)'}`);
    else if (c.count === 'exact' && d.total_estimated === true) bad('count', 'count declared exact and the response says total_estimated: true');
  }
}
// 6.1 (council, decisions 8 and 9): null with quantifier tests the whole relationship or list, never each element.
// Alone, true selects the items where it is empty, absent or null; with other filters on the same list field, true
// selects those where no element meets them all at once and false those where some does. The proxy judges a list field it sees whole;
// on a relationship it judges null alone, from the links the item lists, and leaves the rest to the server.
function groupNullCheck(ex, items, field, decl, raw, bad) {
  if (raw !== 'true' && raw !== 'false') return;
  const c = ex.route.r.c, rel = isObject(c.relations) && isObject(c.relations[field]);
  const others = [...ex.params].map(([k, v]) => ({ f: parseFilterKey(k), v })).filter((x) => x.f && x.f.op !== 'null'
    && (x.f.field === field || x.f.field.startsWith(`${field}.`)));
  // 6.1 (council, round 4, decision 5b): with other filters of the group, true selects the items where no element
  // matches all of them at once, and false those where some does.
  if (rel && others.length) return;
  if (others.some((o) => o.f.field !== field || !opsOf(decl).includes(o.f.op) || !filterValueOk(decl, o.f.op, o.v) || ['ne', 'nin'].includes(o.f.op))) return;
  const other = others[0], all = (e) => others.every((o) => matches(decl.type, o.f.op, e, o.v));
  const shownOthers = others.map((o) => `filter[${o.f.field}]${o.f.op === 'eq' ? '' : `[${o.f.op}]`}=${o.v}`).join(' and ');
  for (const it of items) {
    const v = get(it, field);
    if (rel && v === undefined) continue;
    if (!blank(v) && !Array.isArray(v)) continue;
    const elems = Array.isArray(v) ? v : [];
    const want = raw === 'true';
    const got = other ? !elems.some(all) : elems.length === 0;
    if (got !== want) {
      bad('filter.match', `filter[${field}][null]=${raw}${other ? ` with ${shownOthers}` : ''} and the item ${it.id} has ${field} = ${JSON.stringify(v) ?? '(absent)'}`
        + (other ? `: null tests the whole list, so ${want ? 'no' : 'some'} element must match ${others.length > 1 ? 'all the other filters at once' : 'the other filter'}` : ''));
      return;
    }
  }
}
// The type of a sort field not declared in filter, if the values make it clear.
function inferType(items, f) {
  const vals = items.map((it) => get(it, f)).filter((v) => !blank(v));
  if (vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.every((v) => typeof v === 'string') && !vals.every((v) => DECIMAL.test(v))) return 'string';
  return null;
}

// 3, 4.2 and 11.6: what the discovery document says about an item. Inheritance only with the inherit extension
// announced and a known text (§1.2: it is experimental).
function itemProblems(c, it, partial) {
  const out = [];
  const id = it.id ?? '?';
  for (const [f, decl] of Object.entries(isObject(c.filter) ? c.filter : {})) {
    if (!isObject(decl) || !decl.type) continue;
    const v = get(it, f);
    // 6.1: a to-many relationship carries the type of its items' id; a list field, that of its elements.
    if (isObject(c.relations) && isObject(c.relations[f])) continue;
    if (Array.isArray(v) && (decl.quantifier !== undefined || (opsOf(decl).length === 1 && opsOf(decl)[0] === 'null'))) {
      const wrong = v.find((x) => !blank(x) && !fitsType(decl, x));
      if (wrong !== undefined) out.push(`${id}.${f} has the element ${JSON.stringify(wrong)}, which is not of type ${decl.type}`);
      continue;
    }
    if (!blank(v) && !fitsType(decl, v)) out.push(`${id}.${f} = ${JSON.stringify(v)} is not of type ${decl.type}${decl.type === 'enum' && Array.isArray(decl.values) ? ` (${decl.values.join(', ')})` : ''}`);
  }
  for (const f of Object.keys(isObject(c.language_maps) ? c.language_maps : {})) {
    if (!(f in it)) continue;
    const v = it[f];
    if (!isObject(v)) out.push(`${id}.${f} is a language map and its value is ${JSON.stringify(v)}`);
    else for (const [k, s] of Object.entries(v)) if (!TAG.test(k) || typeof s !== 'string') { out.push(`${id}.${f}.${k} is not a valid translation (lowercase tag and string)`); break; }
  }
  for (const [rel, decl] of Object.entries(isObject(c.relations) ? c.relations : {})) {
    if (!(rel in it) || it[rel] === null) continue;
    const v = it[rel], isLink = (x) => isObject(x) && typeof x.id === 'string';
    if (decl?.many ? !(Array.isArray(v) && v.every(isLink)) && !isLink(v) : !isLink(v)) out.push(`${id}.${rel} is a relation and its value is ${JSON.stringify(v).slice(0, 60)}`);
  }
  if (!partial && has('inherit') && knownText) for (const [f, rule] of Object.entries(isObject(c.inherit) ? c.inherit : {})) {
    if (!isObject(rule) || typeof rule.own !== 'string' || (!(f in it) && !(rule.own in it))) continue;
    // 4.2: a declaration with a member this text does not define is not judged (a client treats it as not inherited).
    if (Object.keys(rule).some((k) => !['own', 'from', 'default', 'combine', 'switch', 'description'].includes(k) && !k.startsWith('x-'))) continue;
    if (!(rule.own in it)) { out.push(`${id} returns ${f} but not its own field ${rule.own}`); continue; }
    const own = it[rule.own], eff = it[f];
    // 11.6: with "combine": "fields", each member of the object resolves on its own, one level deep.
    if (rule.combine === 'fields') {
      if (!isObject(own) && !blank(own)) continue;
      const fromOwn = Object.entries(isObject(own) ? own : {}).filter(([, v]) => !blank(v));
      for (const [k, v] of fromOwn) if (!isObject(eff) || canonical(eff[k]) !== canonical(v)) out.push(`${id}.${f}.${k} is ${JSON.stringify(isObject(eff) ? eff[k] : undefined)} but its own value is ${JSON.stringify(v)}`);
      const named = isObject(it._inherited?.[f]?.fields) ? Object.keys(it._inherited[f].fields) : [];
      for (const [k] of fromOwn) if (named.includes(k)) out.push(`${id}._inherited names ${f}.${k}, which has its own value`);
      continue;
    }
    if (rule.combine !== undefined && rule.combine !== 'replace') continue;
    const same = typeof own === 'string' && typeof eff === 'string' && DECIMAL.test(own) && DECIMAL.test(eff) ? cmpDecimal(own, eff) === 0 : canonical(own) === canonical(eff);
    if (!blank(own) && !same) out.push(`${id}.${f} is ${JSON.stringify(eff)} but its own value is ${JSON.stringify(own)}`);
    const why = it._inherited;
    if (isObject(why) && !blank(own) && f in why) out.push(`${id}._inherited names ${f}, which has its own value`);
    if (isObject(why) && blank(own) && f in it && !(f in why)) out.push(`${id}._inherited does not name ${f}, which is inherited`);
  }
  return out;
}

function writesChecks(ex, bad) {
  const r = ex.route, p = ex.params, s = ex.status, ok = s >= 200 && s < 300, m = ex.method, rh = ex.resHeaders, q = ex.reqHeaders, d = ex.data;
  const write = !['GET', 'HEAD', 'QUERY', 'OPTIONS'].includes(m);
  const itemLike = r.kind === 'item' || r.kind === 'singleton';
  // 7.2: item ETag, strong on the full GET without encoding.
  if (itemLike && m === 'GET' && s === 200) {
    const partial = p.has('fields') || p.has('include');
    const encoded = rh['content-encoding'] && rh['content-encoding'].toLowerCase() !== 'identity';
    if (!partial && !encoded) {
      if (!rh.etag) bad('etag', `the GET of the full ${r.kind === 'item' ? 'item' : 'singleton'} carries no ETag`);
      else if (rh.etag.startsWith('W/')) bad('etag', `the item ETag is weak: ${rh.etag}`);
    }
  }
  // 7.2: every response whose body is an item, to a read or a write, carries _etag.
  const oneItem = (itemLike && (m === 'GET' || m === 'PATCH')) || (r.kind === 'collection' && m === 'POST' && s === 201);
  if (oneItem && ok && isObject(d) && typeof d._etag !== 'string')
    bad('etag', `the ${s} response to ${m} is an item and carries no _etag${p.has('fields') ? ' (with fields)' : ''}`);
  // 7.2: 412 and 428 that make sense.
  if (s === 412 && !q['if-match'] && !q['if-none-match'] && !q['if-unmodified-since']) bad('precondition', '412 without any conditional header in the request');
  if (s === 428 && q['if-match']) bad('precondition', `428 to a request that carries If-Match: ${q['if-match']}`);
  if (s === 428 && !write) bad('precondition', `428 to a ${m}, which is not a write`);
  // 7.2 (council, decision 6): only If-None-Match: * (with upsert) meets a required If-Match; a list of tags does not.
  const inm = etagList(q['if-none-match']);
  if (ok && write && !q['if-match'] && inm.length && !inm.includes('*') && ex.pre.requiresIfMatch)
    bad('precondition', `${m} to ${ex.pathname}, which answered 428 to a write without If-Match, got ${s} with If-None-Match: ${q['if-none-match']} and no If-Match; expected 428`);
  // 7.2: If-Match and If-None-Match against the item ETag the proxy has seen.
  const pre = ex.pre;
  // 7.2: a write to a just-deleted item gives 404, whatever the preconditions say.
  if (r.kind === 'item' && (m === 'PATCH' || m === 'DELETE') && s === 412 && pre.deleted && !pre.concurrent && writeSeq.get(ex.pathname) === pre.seq)
    bad('if-match', `${m} to ${ex.pathname}, which the proxy saw deleted, got 412; expected 404`);
  if (itemLike && (m === 'PATCH' || m === 'DELETE') && pre.etag && !pre.concurrent && writeSeq.get(ex.pathname) === pre.seq) {
    const { current, old } = pre.etag;
    if (q['if-match'] && !etagList(q['if-match']).includes('*')) {
      const list = etagList(q['if-match']);
      if (list.includes(current) && s === 412) bad('if-match', `If-Match: ${q['if-match']} contains the current ETag ${current} and got 412`);
      if (!list.includes(current) && list.some((t) => old.has(t)) && ok) bad('if-match', `If-Match: ${q['if-match']} is an old ETag (the current one is ${current}) and got ${s}; expected 412`);
    }
    if (q['if-none-match'] && ok && etagList(q['if-none-match']).some((t) => t === '*' || weakEq(t, current)))
      bad('if-none-match', `If-None-Match: ${q['if-none-match']} matches the current ETag ${current} and the write got ${s}; expected 412`);
  }
  // 7.3: minimal response. The ETag is a MUST (except after a DELETE); Preference-Applied, a SHOULD.
  // Location on a 201 is always required by 5.1 (location).
  if (/(^|[\s,;])return=minimal\b/i.test(q.prefer ?? '') && write && ok && !ex.size && r.kind !== 'action') {
    // 7.3 (council, decision 5): a replayed 201 without a body carries no ETag (idempotency.replay-validators).
    if (m !== 'DELETE' && !rh.etag && !(s === 201 && isReplay(ex))) bad('minimal.etag', `minimal ${s} response to ${m} without ETag`);
    if (!rh['preference-applied']) bad('minimal', `minimal ${s} response without Preference-Applied`);
  }
}

// 7.1: Idempotency-Key.
const SF_STRING = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/;
function idempotencyChecks(ex, bad) {
  const raw = ex.reqHeaders['idempotency-key'];
  if (raw === undefined) return;
  const s = ex.status, ok = s >= 200 && s < 300;
  if (!SF_STRING.test(raw.trim())) {
    if (ok) bad('idempotency.key', `Idempotency-Key: ${raw} is not a Structured Fields string and got ${s}; expected 400 bad_request`);
    return;
  }
  // 11.1: an action declared idempotent does not reject a well-formed key; without credentials and with
  // "anonymous": false, it ignores it. 7.1: with "anonymous": false, a key without credentials gives 400 with no effect.
  const r = ex.route, act = r.kind === 'action' ? (isObject(r.r.c.actions) ? r.r.c.actions[r.action] : undefined) : undefined;
  const idempotentAction = isObject(act) && act.idempotent === true;
  const keyRefused = s === 400 && ex.data?.code === 'bad_request' && (ex.data.errors ?? []).some((e) => String(e?.header ?? '').toLowerCase() === 'idempotency-key');
  if (idempotentAction) {
    if (keyRefused) bad('idempotency.key', `the action ${r.action} is idempotent and rejected a well-formed Idempotency-Key`);
    return;
  }
  const anonymous = !ex.reqHeaders.authorization && !ex.reqHeaders.cookie;
  if (anonymous && isObject(disc?.idempotency) && disc.idempotency.anonymous === false) {
    if (ok) bad('idempotency.key', `"anonymous": false and an Idempotency-Key without credentials got ${s}; expected 400 bad_request`);
    return;
  }
  const prev = ex.pre.idem;
  const known = prev && !prev.pending && prev.status !== undefined && prev.status >= 200 && prev.status < 300;
  if (isReplay(ex)) replayValidatorChecks(ex, known ? prev : null, bad);
  if (!known) return;
  if (ex.pre.idemPrint === prev.print) {
    const body = ex.data !== undefined ? canonical(ex.data) : ex.size ? `bytes:${ex.size}` : '';
    const path = (u) => { try { return new URL(u, target).pathname; } catch { return u; } };
    const loc = ex.resHeaders.location;
    if (s !== prev.status) bad('idempotency.replay', `the replay got ${s}; the first one, ${prev.status}`);
    else if ((loc === undefined) !== (prev.location === undefined) || (loc !== undefined && path(loc) !== path(prev.location)))
      bad('idempotency.replay', `the replay carries Location: ${loc ?? '(none)'}; the first one, ${prev.location ?? '(none)'}`);
    else if (body !== prev.body && !currentRepresentation(ex)) bad('idempotency.replay', 'the replay returns a body that is neither the first one nor the item\'s current representation');
    else if (ex.resHeaders['idempotent-replayed'] !== 'true') bad('idempotency.replayed-header', 'the replay does not carry Idempotent-Replayed: true');
  } else if (ok) bad('idempotency.mismatch', `the same Idempotency-Key with a different request (body or query) got ${s}; expected 422 idempotency_mismatch`);
}

// 7.1: a replay MAY return the item's current representation instead of the stored body. The proxy takes a body as
// such when its ETag and _etag are the item's current ETag; when it does not know that ETag, or a write to the item is
// in progress, it does not judge a body that carries one.
function currentRepresentation(ex) {
  const tags = carriedTags(ex);
  if (!tags.length) return false;
  const at = itemPathOf(ex);
  if (!at) return false;
  const current = etags.get(at)?.current;
  if (!current || (inflight.get(at) ?? 0) > 0) return true;
  return tags.every((t) => t === current);
}
// 7.1: a response is a replay when it says so or when the proxy saw the first one, with the same fingerprint.
const isReplay = (ex) => ex.resHeaders['idempotent-replayed'] === 'true'
  || (ex.pre.idem && !ex.pre.idem.pending && ex.pre.idem.print === ex.pre.idemPrint);
// The path of the item a write's response speaks of: its Content-Location, the item of an item action, or its Location.
function itemPathOf(ex) {
  const rh = ex.resHeaders, path = (u) => { try { return new URL(u, target).pathname; } catch { return null; } };
  if (typeof rh['content-location'] === 'string') return path(rh['content-location']);
  if (ex.route.kind === 'action' && ex.route.id) return ex.pathname.replace(/(?::|%3[aA])[^/:]+$/, '');
  return typeof rh.location === 'string' ? path(rh.location) : null;
}
// The item ETag a response carries in ETag (strong, without a content coding) or in _etag.
function carriedTags(ex) {
  const rh = ex.resHeaders, d = ex.data, out = [];
  const encoded = rh['content-encoding'] && rh['content-encoding'].toLowerCase() !== 'identity';
  if (typeof rh.etag === 'string' && !rh.etag.startsWith('W/') && !encoded) out.push(rh.etag);
  if (isObject(d) && typeof d._etag === 'string') out.push(d._etag);
  return out;
}
// 7.1 and 7.2: a replay whose body is not the item's current representation (the stored body of a 200 to an
// action, after another write to the item) carries no Content-Location, ETag or _etag. The proxy knows the
// current item ETag only from the traffic it forwards, and judges nothing while a write to the item is in progress.
function replayValidatorChecks(ex, prev, bad) {
  const rh = ex.resHeaders, d = ex.data, s = ex.status;
  if (!(s >= 200 && s < 300)) return;
  // 7.3 (council, decision 5): a replayed 201 without a body MUST NOT carry ETag, even if the item still exists; the
  // client reads the item at Location.
  if (s === 201 && !ex.size && rh.etag !== undefined) {
    bad('idempotency.replay-validators', `the replay of a 201 without a body carries ETag ${rh.etag}; expected none (the client reads Location)`);
    return;
  }
  const carried = [rh['content-location'] !== undefined && 'Content-Location', rh.etag !== undefined && 'ETag', isObject(d) && d._etag !== undefined && '_etag'].filter(Boolean);
  if (!carried.length) return;
  const at = itemPathOf(ex);
  if (!at || (inflight.get(at) ?? 0) > 0) return;
  const current = etags.get(at)?.current;
  if (!current) return;
  const stale = carriedTags(ex).find((t) => t !== current);
  const body = d !== undefined ? canonical(d) : ex.size ? `bytes:${ex.size}` : '';
  if (stale) bad('idempotency.replay-validators', `the replay carries ${carried.join(', ')} with ${stale}, and the item's current ETag is ${current}: its body is not the current representation`);
  else if (!carriedTags(ex).length && prev?.tag && prev.tag !== current && body === prev.body)
    bad('idempotency.replay-validators', `the replay returns the stored body (item ETag ${prev.tag}; now ${current}) with ${carried.join(', ')}`);
}

// 5.5: retirements declared in the discovery document. Each kind goes in its place; an unknown one, or one outside
// its place, is not used (4.2).
const KINDS = {
  root: ['version', 'profile', 'extension', 'collection', 'singleton', 'reason'],
  collection: ['field', 'filter', 'operator', 'value', 'sort', 'relation', 'include', 'count', 'max_limit', 'action', 'method', 'item_method'],
  singleton: ['field', 'method'],
};
function deprecationsFor(r) {
  const out = [];
  const add = (list, scope) => { for (const x of Array.isArray(list) ? list : []) if (isObject(x) && KINDS[scope].includes(x.kind)) out.push({ ...x, scope }); };
  add(disc?.deprecations, 'root');
  if (r?.kind === 'singleton') add(r.r.c.deprecations, 'singleton');
  else if (r?.r?.c) add(r.r.c.deprecations, 'collection');
  return out;
}
const passed = (x) => typeof x.sunset === 'string' && Date.parse(x.sunset) <= Date.now();
function retiredNames(c) {
  const out = { filter: new Set(), sort: new Set() };
  for (const x of deprecationsFor({ r: { c } })) if (passed(x) && (x.kind === 'filter' || x.kind === 'sort' || x.kind === 'field')) {
    if (x.kind !== 'sort') out.filter.add(x.name);
    if (x.kind !== 'filter') out.sort.add(x.name);
  }
  return out;
}
function deprecationChecks(ex, bad) {
  const r = ex.route;
  if (!disc || r.kind === 'other' || r.kind === 'events') return;
  const p = ex.params, s = ex.status, ok = s >= 200 && s < 300, d = ex.data;
  const filters = [...p.keys()].map((k) => ({ k, f: parseFilterKey(k) })).filter((x) => x.f);
  const filterFields = filters.map((x) => x.f.field);
  const sortFields = once(p, 'sort') ? p.get('sort').split(',').map((x) => x.replace(/^-/, '')) : [];
  const includes = once(p, 'include') ? p.get('include').split(',').map((x) => x.split('.')[0]) : [];
  const fieldsParam = once(p, 'fields') ? p.get('fields').split(',') : [];
  const named = [...filterFields, ...sortFields, ...includes, ...fieldsParam];
  // A field notice covers the field and the dotted paths that start with it (author.id for author).
  const covers = (name, x) => x === name || String(x).startsWith(`${name}.`);
  const carries = (name) => (isObject(d) && (name in d || (Array.isArray(d.items) && d.items.some((it) => isObject(it) && name in it))));
  const resourceName = r.r?.name;
  const isWhole = (x) => ['version', 'collection', 'singleton', 'action'].includes(x.kind);
  let partialUsed = null, wholeUsed = false;
  for (const x of deprecationsFor(r)) {
    let used;
    switch (x.kind) {
      case 'version': case 'profile': case 'extension': used = true; break;
      case 'collection': used = r.kind !== 'singleton' && r.kind !== 'discovery' && resourceName === x.name; break;
      case 'singleton': used = r.kind === 'singleton' && resourceName === x.name; break;
      case 'reason': used = s >= 400 && d?.reason === x.name; break;
      case 'field': used = carries(x.name) || named.some((n) => covers(x.name, n)); break;
      case 'filter': used = filterFields.includes(x.name); break;
      case 'operator': used = filters.some(({ f }) => f.field === x.name && f.op === x.op); break;
      case 'value': used = filters.some(({ k, f }) => f.field === x.name && ['eq', 'in', 'ne'].includes(f.op) && p.getAll(k).some((v) => v.split(',').includes(String(x.value)))); break;
      case 'sort': used = sortFields.includes(x.name); break;
      case 'relation': used = includes.includes(x.name) || [...filterFields, ...sortFields, ...fieldsParam].some((n) => n.startsWith(`${x.name}.`)); break;
      case 'include': used = includes.includes(x.name); break;
      case 'count': used = p.has('count'); break;
      case 'max_limit': used = Number.isInteger(x.value) && /^\d+$/.test(p.get('limit') ?? '') && Number(p.get('limit')) > x.value; break;
      case 'action': used = r.kind === 'action' && r.action === x.name; break;
      case 'method': used = x.scope === 'singleton' ? ex.method === x.name : r.kind === 'collection' && ex.method === x.name; break;
      case 'item_method': used = r.kind === 'item' && ex.method === x.name; break;
      default: used = false;
    }
    if (!used) continue;
    const what = `${x.kind}${x.name !== undefined ? ` ${x.name}` : ''}${x.op ? ` ${x.op}` : ''}${x.value !== undefined ? ` (${x.value})` : ''}`;
    const whole = isWhole(x);
    if (!passed(x)) {
      // 5.5: only a notice that retires a resource whole puts headers on its responses; one that retires part of a
      // resource, a profile or an extension goes in deprecations only (RFC 9745, 2.1).
      if (!whole) { partialUsed ??= what; continue; }
      wholeUsed = true;
      if (!ok) continue;
      const announced = Date.parse(x.announced ?? '');
      if (!ex.resHeaders.deprecation) bad('deprecation', `uses ${what}, deprecated in the discovery document, and the response carries no Deprecation`);
      else if (!linkTargets(ex.resHeaders.link, 'deprecation').length) bad('deprecation', `uses ${what} and carries Deprecation, but no Link with rel="deprecation"`);
      else if (!Number.isNaN(announced) && ex.resHeaders.deprecation.trim() !== `@${Math.floor(announced / 1000)}`)
        bad('deprecation', `uses ${what}: Deprecation is ${ex.resHeaders.deprecation}, not the notice's announced instant (@${Math.floor(announced / 1000)})`);
      else if (x.sunset && !ex.resHeaders.sunset) bad('deprecation', `uses ${what}, with sunset date ${x.sunset}, and the response carries no Sunset`);
    } else if (ok && !['profile', 'extension', 'field', 'reason'].includes(x.kind)) {
      const want = whole ? '410 retired' : x.kind.endsWith('method') ? '405' : ['value', 'max_limit'].includes(x.kind) ? '400 invalid_parameter' : '400 unsupported_parameter';
      bad('deprecation', `uses ${what}, retired on ${x.sunset}, and got ${s}; expected ${want}`);
    } else if (x.kind === 'reason') bad('deprecation', `the reason ${x.name} was retired on ${x.sunset} and is still returned`);
    else if (x.kind === 'field' && ok && carries(x.name)) bad('deprecation', `the field ${x.name} was retired on ${x.sunset} and is still in the response`);
  }
  if (partialUsed && !wholeUsed && (ex.resHeaders.deprecation !== undefined || ex.resHeaders.sunset !== undefined))
    bad('deprecation', `uses ${partialUsed}, a notice that retires part of a resource, and carries ${ex.resHeaders.deprecation !== undefined ? 'Deprecation' : 'Sunset'}; only a resource retired whole does`);
}

// ── State learned from traffic ─────────────────────────────────────────
function prepare(ex) {
  const write = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(ex.method);
  const e = etags.get(ex.pathname);
  ex.pre = { etag: e ? { current: e.current, old: new Set(e.old) } : null, concurrent: (inflight.get(ex.pathname) ?? 0) > 0, deleted: deleted.has(ex.pathname),
    requiresIfMatch: requireIfMatch.has(`${ex.method} ${ex.pathname}`) };
  if (write) {
    ex.pre.seq = (writeSeq.get(ex.pathname) ?? 0) + 1;
    writeSeq.set(ex.pathname, ex.pre.seq);
    inflight.set(ex.pathname, (inflight.get(ex.pathname) ?? 0) + 1);
    ex.isWrite = true;
  }
}
// Called when the whole request body has arrived.
function prepareBody(ex) {
  if (ex.reqBody && ex.reqBody.length) {
    try { ex.reqJson = JSON.parse(ex.reqBody.toString('utf8')); ex.reqJsonParsed = true; } catch { ex.reqJsonInvalid = isJsonType(mediaType(ex.reqHeaders['content-type'])); }
  }
  const raw = ex.reqHeaders['idempotency-key'];
  if (ex.method !== 'POST' || raw === undefined || !SF_STRING.test(raw.trim())) return;
  // 7.1: the key belongs to the principal and the target (method and path, without the query); the query and the body
  // decide whether it is "the same request".
  let path = ex.pathname;
  try { path = decodeURIComponent(path); } catch {}
  const scope = `${hash(ex.reqHeaders.authorization ?? '')} ${ex.method} ${path} ${raw.trim()}`;
  ex.idemScope = scope;
  // 7.1: the order of distinct names does not count; that of repeated values of one name does.
  const byName = new Map();
  for (const [k, v] of ex.params) byName.set(k, [...(byName.get(k) ?? []), v]);
  const query = [...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  ex.pre.idemPrint = hash(canonical([query, ex.reqJsonParsed ? canonical(ex.reqJson) : (ex.reqBody ?? Buffer.alloc(0)).toString('base64')]));
  const saved = idem.get(scope);
  const live = saved && (saved.pending || saved.expires > Date.now()) ? saved : null;
  ex.pre.idem = live ? { ...live } : null;
  if (!live) idem.set(scope, { pending: true, print: ex.pre.idemPrint, owner: ex });
}
function learn(ex) {
  const r = ex.route, s = ex.status, ok = s >= 200 && s < 300, d = ex.data, rh = ex.resHeaders;
  if (ex.isWrite) inflight.set(ex.pathname, Math.max(0, (inflight.get(ex.pathname) ?? 1) - 1));
  // Discovery document passing through the proxy.
  if (r.kind === 'discovery' && ex.method === 'GET' && s === 200 && isObject(d) && typeof d.restep === 'string' && restep1(d)) setDiscovery(d);
  // ETags de elemento (7.2).
  const setTag = (path, tag) => {
    if (typeof tag !== 'string' || tag.startsWith('W/')) return;
    const e = etags.get(path) ?? { current: null, old: new Set() };
    if (e.current && e.current !== tag) e.old.add(e.current);
    e.old.delete(tag);
    e.current = tag;
    etags.set(path, e);
  };
  // 7.2: a write that answers 428 without If-Match (and without If-None-Match: *) is to a resource that requires it.
  if (ex.isWrite && s === 428 && !ex.reqHeaders['if-match'] && !etagList(ex.reqHeaders['if-none-match']).includes('*'))
    requireIfMatch.add(`${ex.method} ${ex.pathname}`);
  if (r.kind === 'item' && ok && ex.method === 'DELETE') deleted.add(ex.pathname);
  else if (r.kind === 'item' && ok) deleted.delete(ex.pathname);
  if ((r.kind === 'item' || r.kind === 'singleton') && ok) {
    const partial = ex.params.has('fields') || ex.params.has('include');
    const encoded = rh['content-encoding'] && rh['content-encoding'].toLowerCase() !== 'identity';
    if (ex.method === 'DELETE') etags.delete(ex.pathname);
    else if (isObject(d) && typeof d._etag === 'string') setTag(ex.pathname, d._etag);
    else if ((ex.method === 'GET' && !partial && !encoded) || ex.method === 'PATCH') setTag(ex.pathname, rh.etag);
  }
  if (r.kind === 'collection' && ex.method === 'POST' && s === 201 && rh.location) {
    const tag = isObject(d) && typeof d._etag === 'string' ? d._etag : rh.etag;
    try { const at = new URL(rh.location, target).pathname; deleted.delete(at); if (tag) setTag(at, tag); } catch {}
  }
  // 7.2: a 200 to an action that changed the item carries Content-Location and its new item ETag; a replay's
  // validators are what the proxy judges, so it learns nothing from one.
  if (r.kind === 'action' && r.id && ex.method === 'POST' && s === 200 && typeof rh['content-location'] === 'string' && !isReplay(ex)) {
    const at = itemPathOf(ex), tag = carriedTags(ex)[0];
    if (at && tag) { deleted.delete(at); setTag(at, tag); }
  }
  if (r.kind === 'collection' && ex.method === 'GET' && ok && Array.isArray(d?.items))
    for (const it of d.items) if (isObject(it) && typeof it._etag === 'string' && typeof it.id === 'string') setTag(`${ex.pathname.replace(/\/$/, '')}/${encodeURIComponent(it.id)}`, it._etag);
  // Idempotency-Key (7.1): only what had an effect is stored.
  if (ex.idemScope) {
    const saved = idem.get(ex.idemScope);
    if (saved?.owner === ex) {
      if (ok) {
        const ttl = Number.isFinite(disc?.idempotency?.ttl) ? disc.idempotency.ttl : 86400;
        idem.set(ex.idemScope, { print: saved.print, status: s, body: d !== undefined ? canonical(d) : ex.size ? `bytes:${ex.size}` : '', tag: carriedTags(ex)[0], location: rh.location, expires: Date.now() + ttl * 1000 });
      } else idem.delete(ex.idemScope); // a rejection MAY not be stored: it does not spend the key
    }
  }
}

// ── El proxy ──────────────────────────────────────────────────────────────────
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function hopByHop(connection) { // RFC 9110, 7.6.1: also those named by Connection
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
    else if (enc && enc !== 'identity') return; // unknown encoding: the body is not analyzed
  } catch { ex.bodyError = `the body cannot be decompressed (Content-Encoding: ${enc})`; return; }
  ex.size = buf.length;
  const t = mediaType(ex.resHeaders['content-type']);
  if (!buf.length || !isJsonType(t)) return;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    try { ex.data = JSON.parse(text); } catch { ex.bodyError = 'the body is not JSON'; }
  } catch { ex.bodyError = 'the body is not UTF-8'; }
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
    console.error(`restep-proxy: internal error analysing ${ex.method} ${ex.url}: ${e.stack ?? e}`);
  } finally {
    try { learn(ex); } catch (e) { console.error(`restep-proxy: internal error: ${e.stack ?? e}`); }
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
    try { prepareBody(ex); } catch (e) { console.error(`restep-proxy: internal error: ${e.stack ?? e}`); }
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
    if (!opts.quiet) console.error(`${clock()} restep-proxy: could not reach ${target.origin} (${req.method} ${req.url}): ${e.code ?? e.message}`);
    sendProblem(res, 502, 'bad_gateway', 'The proxy could not reach the API', `${target.origin}: ${e.code ?? e.message}`);
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
}

function onResponse(ex, req, res, upres) {
  ex.status = upres.statusCode;
  ex.resHeaders = upres.headers;
  const raw = responseHeaders(upres);
  // A stream (SSE) is neither stored nor analyzed inside: it is forwarded as it arrives.
  const streaming = mediaType(upres.headers['content-type']) === 'text/event-stream';
  if (!opts.strict || streaming) {
    res.writeHead(upres.statusCode, upres.statusMessage, raw);
    const chunks = [];
    let size = 0, big = false;
    if (!streaming) upres.on('data', (c) => { if (big) return; size += c.length; if (size > opts.maxBody) { big = true; chunks.length = 0; } else chunks.push(c); });
    // The response is ended after analyzing it, so that what was learned (ETag, Idempotency-Key)
    // is up to date before the client can send the next request.
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
  // --strict: the whole response is stored before deciding whether to deliver it.
  const chunks = [];
  let size = 0, flushed = false;
  upres.on('data', (c) => {
    if (flushed) return;
    chunks.push(c);
    size += c.length;
    if (size > opts.maxBody) { // too large to store: delivered without analyzing the body
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
    const must = findings.filter((f) => CHECKS[f.id][1] === 'MUST');
    if (res.destroyed) return;
    if (!must.length) { res.writeHead(upres.statusCode, upres.statusMessage, raw); res.end(ex.resRaw); return; }
    stats.replaced++;
    sendProblem(res, 502, 'bad_gateway', 'The API response breaks Restep',
      `restep-proxy --strict: ${must.length} violation(s) in the ${ex.status} response to ${ex.method} ${ex.url}: ${must.map((f) => `${f.id}: ${f.msg}`).join(' | ')}`,
      { upstream_status: ex.status, violations: must.map((f) => ({ check: f.id, section: CHECKS[f.id][0], spec: sectionUrl(CHECKS[f.id][0], f.id), message: f.msg })) });
  });
}

// ── Summary page ─────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
function servePage(req, res, json) {
  req.resume();
  if (json) {
    const body = JSON.stringify(report(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  const t = totals(), rep = report();
  const rows = rep.groups.map((g) => `<tr class="${g.level === 'MUST' ? 'must' : 'should'}"><td>${g.level === 'MUST' ? 'Violation' : 'Warning'}</td>` +
    `<td><code>${esc(g.check)}</code><br><a href="${esc(g.spec)}">§${esc(g.section)}</a></td><td><code>${esc(g.method)} ${esc(g.route)}</code></td>` +
    `<td class="n">${g.count}</td><td>${esc(g.description)}<br><span class="ex"><code>${esc(g.first.request)}</code> → ${esc(g.first.status)}: ${esc(g.first.message)}</span></td></tr>`).join('\n');
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
<p class="meta">Watching <code>${esc(target.href)}</code> since ${esc(rep.started)}${opts.strict ? ' · strict mode' : ''} · ${disc ? `profiles: ${esc(announced.join(', '))}` : 'no discovery document (core only)'} · <a href="/_restep-proxy.json">JSON</a></p>
<div class="totals"><div><b>${rep.exchanges}</b>exchanges</div><div><b>${t.violations}</b>violations</div><div><b>${t.warnings}</b>warnings</div><div><b>${groups.size}</b>groups</div>${opts.strict ? `<div><b>${stats.replaced}</b>responses replaced</div>` : ''}</div>
${rows ? `<div class="wrap"><table><thead><tr><th>Level</th><th>Check</th><th>Route</th><th>Count</th><th>What the specification requires · first case</th></tr></thead><tbody>
${rows}
</tbody></table></div>` : '<p>No violations or warnings so far.</p>'}
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ── Resumen y salida ──────────────────────────────────────────────────────────
function printSummary() {
  const t = totals();
  console.log(`\nrestep-proxy · summary (${target.href})`);
  console.log(`${stats.exchanges} exchanges, ${stats.analysed} analysed${stats.upstreamErrors ? `, ${stats.upstreamErrors} errors reaching the API` : ''}${opts.strict ? `, ${stats.replaced} responses replaced` : ''}`);
  for (const g of sortedGroups()) {
    const label = g.level === 'MUST' ? paint('1;31', 'VIOLATION') : paint(33, 'WARNING  ');
    console.log(`  ${label} ${String(g.count).padStart(5)}×  ${g.check} (${g.section})  ${g.method} ${g.route}`);
    console.log(`  ${' '.repeat(17)}${g.first.request} → ${g.first.status}: ${g.first.message}`);
  }
  console.log(`${t.violations} violations in ${[...groups.values()].filter((g) => g.level === 'MUST').length} groups, ${t.warnings} warnings`);
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
    if (r.ok && isObject(d) && typeof d.restep === 'string' && !restep1(d)) return `the root declares "restep": ${JSON.stringify(d.restep)}, which is not Restep 1 (§1.1): core only until a Restep 1 discovery document passes through`;
    if (r.ok && isObject(d) && typeof d.restep === 'string') { setDiscovery(d); return `discovery document read (${d.restep}${knownText ? '' : ', its experimental parts not judged'}): ${announced.join(', ')}; ${routes.length} collections, ${singletonRoutes.size} singletons`; }
    return `the root answered ${r.status} with no discovery document: core only until one passes through the proxy`;
  } catch (e) {
    return `could not read the discovery document (${e.cause?.code ?? e.message}): core only until one passes through the proxy`;
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
  server.on('error', (e) => { console.error(`restep-proxy: cannot listen on ${opts.host}:${opts.port}: ${e.code ?? e.message}`); process.exit(2); });
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`restep-proxy ${VERSION} on http://${opts.host}:${port}/ → ${target.href}${opts.strict ? ' (strict)' : ''}`);
    console.log(`${note}. Summary at http://${opts.host}:${port}/_restep-proxy`);
  });
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    server.close();
    server.closeAllConnections?.();
    printSummary();
    try { writeReport(); } catch (e) { console.error(`restep-proxy: could not write ${opts.report}: ${e.message}`); }
    process.exit(totals().violations ? 1 : 0);
  };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
