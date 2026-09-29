import { createHash } from 'node:crypto';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

/**
 * Skrynia mints a fresh capability for a `capability-write` object at POST,
 * returns it once in the response body, and keeps only its hash. It does *not*
 * adopt whatever the caller put in `X-Skrynia-Capability`, so a later PUT or
 * DELETE of that object must present the value the creating response returned.
 * Modelling that is the point of this double: an earlier version adopted the
 * caller's header, which made a shard written with one capability look
 * deletable by any other client, and hid a production-only 403.
 */
function capabilityHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  const objects = new Map();
  const requests = [];
  const issued = new Map();
  let beforePut = null;
  let minted = 0;

  function keyOf(url) {
    const parts = String(url).split('/');
    return decodeURIComponent(parts.at(-1));
  }

  function etag(entry) {
    return `"v${entry.revision}"`;
  }

  function authorized(entry, headers) {
    if (entry.capabilityHash === null) return true;
    return capabilityHash(headers.get('X-Skrynia-Capability') ?? '') === entry.capabilityHash;
  }

  function boardEntry() {
    return objects.get('board-v2');
  }

  return {
    capability,
    objects,
    requests,
    get signed() { return boardEntry()?.value ?? null; },
    set signed(value) {
      if (value === null) {
        objects.delete('board-v2');
        return;
      }
      const current = boardEntry();
      objects.set('board-v2', {
        value,
        mode: 'capability-write',
        capabilityHash: capabilityHash(capability),
        revision: (current?.revision ?? 0) + 1,
      });
    },
    get revision() { return boardEntry()?.revision ?? 0; },
    set beforePut(value) { beforePut = value; },
    /**
     * The capability Skrynia issued for an object, as its creating response
     * reported it. A test that needs to act on a `capability-write` object uses
     * this rather than the ambient `capability`, because those are not the same
     * value and pretending they are is what this double exists to prevent.
     */
    capabilityOf(key) { return issued.get(key) ?? null; },
    bump(value) {
      const current = boardEntry();
      objects.set('board-v2', {
        value: structuredClone(value),
        mode: 'capability-write',
        capabilityHash: capabilityHash(capability),
        revision: (current?.revision ?? 0) + 1,
      });
    },
    clearRequests() { requests.length = 0; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const key = keyOf(url);
      const body = init.body === undefined ? null : JSON.parse(String(init.body));
      requests.push({ method, key, body });
      const current = objects.get(key);

      if (method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : jsonResponse(current.value, 200, etag(current));
      }

      if (method === 'POST') {
        if (current !== undefined) return new Response(null, { status: 409 });
        const headers = new Headers(init.headers);
        const mode = headers.get('X-Skrynia-Mode') ?? 'capability-write';
        if (!['capability-write', 'public-write', 'immutable'].includes(mode)) {
          return jsonResponse({ error: 'invalid_mode' }, 400);
        }
        // Fresh per object, and deliberately not the caller's header.
        const mintedCapability = capabilityHash(`skrynia-minted:${key}:${++minted}`);
        const entry = {
          value: body,
          mode,
          capabilityHash: mode === 'capability-write' ? capabilityHash(mintedCapability) : null,
          revision: 1,
        };
        objects.set(key, entry);
        if (mode === 'capability-write') issued.set(key, mintedCapability);
        return jsonResponse(
          mode === 'capability-write' ? { mode, capability: mintedCapability } : { mode },
          201,
        );
      }

      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        const headers = new Headers(init.headers);
        if (!authorized(current, headers)) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        if (key === 'board-v2' && beforePut) {
          const hook = beforePut;
          beforePut = null;
          await hook();
        }
        const match = headers.get('If-Match');
        if (match !== null && match !== etag(current)) {
          return jsonResponse({ error: 'etag_mismatch' }, 412);
        }
        current.value = body;
        current.revision += 1;
        return jsonResponse({ ok: true }, 200);
      }

      if (method === 'DELETE') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        if (!authorized(current, new Headers(init.headers))) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        objects.delete(key);
        return jsonResponse({ ok: true }, 200);
      }

      return new Response(null, { status: 405 });
    },
  };
}
