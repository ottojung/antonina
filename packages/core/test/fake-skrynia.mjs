function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

export function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  const objects = new Map();
  const requests = [];
  let beforePut = null;

  function keyOf(url) {
    const parts = String(url).split('/');
    return decodeURIComponent(parts.at(-1));
  }

  function etag(entry) {
    return `"v${entry.revision}"`;
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
        capability,
        revision: (current?.revision ?? 0) + 1,
      });
    },
    get revision() { return boardEntry()?.revision ?? 0; },
    set beforePut(value) { beforePut = value; },
    bump(value) {
      const current = boardEntry();
      objects.set('board-v2', {
        value: structuredClone(value),
        mode: 'capability-write',
        capability,
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
        const entry = {
          value: body,
          mode,
          capability: mode === 'capability-write' ? capability : null,
          revision: 1,
        };
        objects.set(key, entry);
        return jsonResponse(
          mode === 'capability-write' ? { mode, capability } : { mode },
          201,
        );
      }

      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        const headers = new Headers(init.headers);
        if (current.mode === 'capability-write'
            && headers.get('X-Skrynia-Capability') !== current.capability) {
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
        const headers = new Headers(init.headers);
        if (current.mode === 'capability-write'
            && headers.get('X-Skrynia-Capability') !== current.capability) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        objects.delete(key);
        return jsonResponse({ ok: true }, 200);
      }

      return new Response(null, { status: 405 });
    },
  };
}
