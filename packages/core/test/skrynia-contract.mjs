/**
 * A conformance double for the Skrynia storage contract, as reported by the
 * independent review of board 125.
 *
 * THIS IS NOT A LIVE DEPLOYED TEST. No request here has been made to a running
 * Skrynia, and nothing in this repository can make one. It is a transcription of
 * the contract as described to this front, and its value is that it is
 * *independent of the double the rest of the suite uses*: the tests in
 * `fake-skrynia.mjs` and this one are written from two different descriptions of
 * the same server, so a client that satisfies both is not relying on a single
 * assumption twice.
 *
 * The reported contract, and the clauses this file encodes:
 *
 *  1. `POST` with `X-Skrynia-Mode: capability-write` **mints a fresh per-object
 *     capability**, returns it once in the response body, and retains only its
 *     hash. It does **not** adopt the caller's `X-Skrynia-Capability`.
 *  2. `handleDelete` allows `DELETE` for `public-write` **without** a capability,
 *     and checks a capability only for `capability-write`.
 *  3. `handleDelete` refuses **nothing** on the grounds of `immutable`: there is no
 *     `immutable` branch in it at all. `immutable` is a mode that can no longer be
 *     *created*; the objects it left on disk are deliberately deletable, so that
 *     superseded storage is reclaimable.
 *  4. An inbound `X-Skrynia-Capability` on POST is **ignored silently** in both
 *     modes: never rejected, never honoured.
 *  5. **`public-write` objects are anonymously overwritable.** A `PUT` with no
 *     capability is accepted and replaces the body. `If-Match` is honoured when
 *     supplied and is **optional**.
 *  6. `If-Match` is read in `handlePut` only. `handleDelete` never reads it, so a
 *     conditional DELETE is accepted unconditionally and no 412 is reachable there.
 *
 * Clause 3 was originally written here as "`DELETE` is refused for `immutable`",
 * and clause 2's `handleDelete` was given a 403 for it. That modelled a server
 * revision in which the refusal existed, and it was found false against
 * `ottojung/skrynia@0b5adde:src/server.js:281-287`, whose `handleDelete` has no
 * `immutable` branch and whose own comment reads "Legacy immutable objects are
 * deletable so superseded storage is reclaimable". A double that encodes the
 * behaviour under dispute is worse than no double: it launders a false claim into
 * a green suite, and it contradicted the corrected prose in
 * `board-v3-store.ts` inside one package. It is recorded here rather than silently
 * dropped so that a later reader does not reintroduce it.
 *
 * Clause 2 is what the whole reclamation design rests on, and clause 1 is what
 * made the first attempt at this fix a production no-op. Clause 5 is the one
 * that invalidates an assumption the store's comments used to make: shards are
 * NOT immutable at the storage layer, so "no reader can observe a shard change"
 * is a statement about Antonina's write discipline and locator secrecy, never
 * about Skrynia. Modelling it here is deliberate -- a double that refused the
 * overwrite would let that claim survive in a test suite.
 *
 * These were observed against the deployed server on 2026-09-29. They are a
 * dated observation of one deployment, not a specification, and the front that
 * probed them did not establish durability, cross-node visibility of the DELETE,
 * or any of the races below.
 */
import { createHash } from 'node:crypto';

const capabilityHash = (value) => createHash('sha256').update(value).digest('hex');

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

export function contractSkrynia() {
  const objects = new Map();
  const requests = [];
  let minted = 0;

  const keyOf = (url) => decodeURIComponent(String(url).split('/').at(-1));
  const etagOf = (entry) => `"v${entry.revision}"`;
  const boardEntry = () => objects.get('board-v2');

  return {
    objects,
    requests,
    /** The capability Skrynia minted for an object, as its POST response reported it. */
    capabilityOf(key) {
      for (const [name, entry] of objects) {
        if (name === key && entry.issued !== undefined) return entry.issued;
      }
      return null;
    },
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
        // An existing pointer keeps the capability it was created with, which is
        // what `board-v2` does in production: created once, guarded forever by
        // the value that creation returned.
        capabilityHash: current?.capabilityHash ?? null,
        issued: current?.issued,
        revision: (current?.revision ?? 0) + 1,
      });
    },
    get revision() { return boardEntry()?.revision ?? 0; },
    clearRequests() { requests.length = 0; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const key = keyOf(url);
      const body = init.body === undefined ? null : JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      requests.push({ method, key, mode: headers.get('X-Skrynia-Mode'), hasCapability: headers.has('X-Skrynia-Capability') });
      const current = objects.get(key);

      if (method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : jsonResponse(current.value, 200, etagOf(current));
      }

      if (method === 'POST') {
        if (current !== undefined) return new Response(null, { status: 409 });
        const mode = headers.get('X-Skrynia-Mode') ?? 'capability-write';
        if (!['capability-write', 'public-write', 'immutable'].includes(mode)) {
          return jsonResponse({ error: 'invalid_mode' }, 400);
        }
        // Clauses 1 and 4: a fresh capability per object, and the caller's header
        // is read by nothing here and changes nothing about the response.
        const issued = capabilityHash(`contract-minted:${key}:${++minted}`);
        objects.set(key, {
          value: body,
          mode,
          capabilityHash: mode === 'capability-write' ? capabilityHash(issued) : null,
          issued: mode === 'capability-write' ? issued : undefined,
          revision: 1,
        });
        return jsonResponse(
          mode === 'capability-write' ? { mode, capability: issued } : { mode },
          201,
        );
      }

      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        // A capability is checked only for capability-write, and it is the
        // object's own minted value that counts. Clause 5: a public-write object
        // is overwitable by anyone who can address it, so this branch is
        // deliberately NOT guarded -- a double that refused it would be lying
        // about the server this design runs on.
        if (current.mode === 'capability-write'
            && capabilityHash(headers.get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        const match = headers.get('If-Match');
        if (match !== null && match !== etagOf(current)) {
          return jsonResponse({ error: 'etag_mismatch' }, 412);
        }
        current.value = body;
        current.revision += 1;
        return jsonResponse({ ok: true }, 200);
      }

      if (method === 'DELETE') {
        if (current === undefined) return new Response(null, { status: 404 });
        // Clause 3: there is deliberately NO immutable refusal here. `immutable`
        // is a mode that can no longer be created; the objects it left on disk
        // are deletable on purpose, so that superseded storage is reclaimable.
        // Modelling a 403 for them would be encoding the behaviour under dispute.
        // Clause 6: `handleDelete` does not read `If-Match` either, so a
        // conditional DELETE is accepted unconditionally. That is modelled by
        // simply not looking at the header below.
        // Clause 2: the capability is checked for capability-write only. A
        // public-write object is deletable with no capability presented at all.
        if (current.mode === 'capability-write'
            && capabilityHash(headers.get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        objects.delete(key);
        return jsonResponse({ ok: true }, 200);
      }

      return new Response(null, { status: 405 });
    },
  };
}
