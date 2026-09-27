# Chunked content-addressed board state for bounded lazy loading

- **Status:** Proposed (design only; nothing here is implemented)
- **Date:** 2026-09-27
- **Related issue:** #70
- **Base commit:** `0c96127` (`origin/release/2026-09-27`, identical to `origin/main`)
- **Related issue:** #73 (migration framework) — see §7 and §8, this document
  is written to be consistent with its stated security constraint and says so
  where it is not.

## What this document is

This is the design answer to #70. It specifies a bounded-chunk primitive, the
three collection shapes the body requires, the canonical encoding and hash, how
the primitive composes with the existing signed operation log rather than
replacing it, the write path, and migration from the currently persisted board.

It is not an implementation plan and it does not restate the issue intent. Where
the design is incomplete or where I believe the issue body's picture of the
current code is wrong, §9 says so with a file citation.

Every claim below about how the current implementation works cites a file I read
at `0c96127`. Where I did not read something, I say so rather than assert it.

---

## 0. First: the current format, read from the code

The issue body describes the current format as: "`board-v2` stores the complete
signed operation log as one object." That is **correct**, and worth stating
precisely because the name is misleading in a way that matters for migration.

There are three independent version axes, not one:

| axis | value | defined at |
|---|---|---|
| Skrynia storage key name | `board-v2` | `packages/core/src/board-store.ts:26` (`SIGNED_BOARD_KEY`), namespace `antonina` at `:25` |
| operation-log schema version | `1` | `packages/core/src/operations.ts:22` (`OPLOG_SCHEMA_VERSION`) |
| nested board schema version | `3`, legacy `2` readable | `packages/core/src/model.ts:1-2` |

The object at `GET /store/antonina/board-v2` is a `BoardOperationLog`
(`operations.ts`, `parseOperationLog`) — a single JSON document holding
`{schemaVersion, boardId, rootKeyId, head, operations[]}` where every element of
`operations[]` is a fully signed operation. The `Board` (the materialized view)
is *not* the stored object; it is recovered by replaying the log. A legacy
`schemaVersion: 2` board can appear nested inside the very first operation's
`board.initialize` payload, and `upgradePersistedBoard` (`model.ts`) promotes it
to version 3 **in memory only** — it splices `schemaVersion: 3` with empty
`targets`/`dispatches` and re-parses. Nothing persists that promotion.

The body also says "the current client is board-v3". That conflates the storage
key name with the nested board schema version. They are different axes and they
move independently.

The storage contract Antonina actually depends on, as exercised by the in-memory
fake in `web/src/api.test.ts:32-59`:

- `GET` → `200` + `ETag`, or `404`.
- `POST` → `201` + `{mode, capability}`; `409` if the key exists. This is
  create-only, and the create *returns the storage capability*.
- `PUT` → requires `X-Skrynia-Capability` and `If-Match: <etag>`; `412` on
  mismatch, `403` on bad capability, `200` on success.
- Any other key → `404`.

So Skrynia is a flat namespace/key generic store with per-key ETag compare-and-set
and one opaque write capability. `docs/intent-records/board.md` ("Skrynia is
Antonina's only backend") describes that capability as "generic write authority
over the storage it guards", i.e. namespace-scoped. **I did not read Skrynia's
implementation** — it is a different repository and off limits for this front — so
namespace scope is an assumption, recorded in §9.

Replay cost today is worse than the body states. `applyBoardMutation`
(`operations.ts`) does `structuredClone(board)` and then `parseBoard(candidate)`
on **every** operation, and `parseBoard` (`model.ts`) deep-validates and re-sorts
the whole board. So one verified read is `O(operations × boardSize)`, not
`O(operations + boardSize)`.

The write path in `SignedBoardStore.append` (`board-store.ts`) is, per append:
full `GET` + full verify; `structuredClone` of the entire log; **full
re-verification of the entire candidate log**; whole-object `PUT`; then another
full `GET` + full verify. Three whole-object transfers and two whole-log
replays per operation. Again, the body is accurate.

---

## 1. The chunk abstraction

### 1.1 Node kinds

One encoding, five node kinds, one hash. Kinds are a closed set and are
distinguished by a required `kind` field.

```
root      the board's top-level object; named by digest from a signed operation
map-branch  keyed map interior
map-leaf    keyed map entries, <= B entries
seq-branch  ordered sequence interior
seq-leaf    ordered sequence elements, <= B elements
blob-run    one fixed-size run of one oversized value
```

`root` is not a special type; it is a `map-branch`/`seq-branch`-shaped node whose
child *field names* are fixed. That is what keeps it `O(1)` (§3.3).

A `blob-run` is deliberately a distinct kind rather than a `seq-leaf` of bytes:
it is the only node that carries a raw byte payload, it has no children, and its
payload length is a fixed constant (§1.4), so it is the only node whose encoding
is *not* JSON-of-values.

### 1.2 Value = InlineValue | Ref<Hash>

A `Ref<Hash>` is a string of the form `sha256:<43 base64url chars>` — exactly the
form `isOperationId` already validates in `operations.ts`
(`/^sha256:[A-Za-z0-9_-]{43}$/`). Reusing the identifier shape means one regex and
one id concept serve both the signed log and the chunk store, and it makes a
chunk digest impossible to confuse with an operation id by form. §4.3 makes them
impossible to confuse by content too.

Where a `Ref` may appear, it appears in a field whose declared type is
`InlineValue | Ref<Hash>`:

- a `map-leaf` entry's value;
- a `seq-leaf` element that has been pushed out of line;
- a `root` field that names a collection;
- an operation payload field (this is the composition point, §5).

Concretely, an issue record is a `map-leaf` entry whose value is a small inline
object plus one `Ref` to the issue's message sequence:

```json
{
  "number": 70,
  "title": "Design chunked content-addressed board state",
  "state": "open",
  "createdAt": "2026-09-27T05:51:05.065Z",
  "updatedAt": "2026-09-27T05:51:05.065Z",
  "body": "See docs/chunked-content-addressed-board-state.md",
  "messages": "sha256:7Qk2r0m1sVxT0n5bWd8cQaZr4YyH1pJf3KgNc6Ee0A"
}
```

`messages` is a digest, not an array. The digest names a `seq-branch`/`seq-leaf`
subtree — the *same* node kinds used for the top-level issues map and for the
operation history (§1.6).

### 1.3 What a branch may contain, and the routing metadata

A branch contains child *references*, never child values. A child reference is
exactly:

```json
{ "h": "sha256:…", "n": 128, "k": "0000000000000070" }
```

- `h` — the child's digest. The only field that is not derivable from the other
  two.
- `n` — the number of logical elements in the child's whole subtree.
- `k` — routing key, interpreted per shape (below).

`seq-branch`: children are ordered by absolute position. Routing key is the
child's first absolute index, rendered as a fixed-width decimal string so
lexicographic order equals numeric order. Additionally **every node, branch or
leaf, carries its own absolute `base`** (the absolute index of its first
element). That is what makes a chunk interpretable when fetched on its own: a
reader holding only a `seq-leaf` digest can range-scan it without having retained
its parent, and can check `child.base === node.base + sum(preceding siblings' n)`.

`map-branch`: children are ordered by key ascending. Routing key `k` is the
child's first key. To find key `q` I binary-search for the last child with
`k <= q` and descend. To enumerate a key range `[a,b]` I take the maximal run of
children whose key-spans intersect it.

The canonical key encoding is a *code-unit* byte-string, never a locale
comparison. See §9.1 — this is a prerequisite, and the existing resource sort
violates it.

### 1.4 The bound, and where it is enforced

Two independent bounds, and conflating them is how designs like this go wrong.

**Structural bound `B` — the fanout.** `|children| <= B`. This is what makes the
tree finite in *shape*; it is a syntactic property of a branch and is what
forbids the "unbounded child array one level lower" failure.

**Byte bound `MAXBYTES` — the encoded size.** `|canonicalBytes(chunk)| <=
MAXBYTES`. This is what makes a leaf bounded in *content*; it is what forbids an
unbounded payload from hiding inside a small fanout.

Both are enforced **on write and on read**, and the two directions are not
redundant:

- **On write** the encoder is the only thing that can maintain the bound, because
  content addressing gives an encoder the right to publish any bytes it likes.
  The encoder accumulates entries/elements into a leaf while the encoded leaf
  stays `<= MAXBYTES`; it then splits. A branch whose child count would exceed
  `B` is split. An encoder that cannot make a node fit **throws** rather than
  emitting an oversized node.
- **On read** the bound is the reader's protection, and this is the half that is
  easy to omit. A signed root may legitimately name a 4 GiB chunk. A reader that
  parses it before checking its size has already lost. So the reader checks
  `|bytes| <= MAXBYTES` on the raw response **before** JSON.parse, and checks
  `|children| <= B` and `depth <= MAXDEPTH` immediately after parse and before
  descending. The bound is not a property Skrynia enforces and not a property the
  signer was trusted to honour; it is a client obligation, and it is the only
  thing that forces a writer's hand.

`MAXBYTES` must be at or below Skrynia's maximum object size, which I have not
read. Until that is known, `MAXBYTES` is a parameter and the design does not fix
it (§9.3). For the worked numbers below I use `B = 32` and `MAXBYTES = 64 KiB`,
both explicitly provisional.

### 1.5 What happens when a single logical value exceeds the bound

This is the third required shape and it must be *deterministic*, not
writer-dependent, or two importers disagree.

Rule, in order:

1. Try to encode the value inline. If it fits in an otherwise empty leaf,
   it is inline.
2. If it does not fit, and its type admits a chunked form, replace it with its
   digest and store the chunked form. Concretely:
   - an oversized **string/blob** becomes a chain of `blob-run` chunks (§2.3);
   - an oversized **array or object** becomes a `seq` or `map` subtree, and the
     field holds that subtree's digest.
3. If it admits no chunked form, the write is **refused** with a named error. The
   encoder never emits an over-bound node.

A `seq-leaf` therefore holds either a small inline element or a digest. It never
holds a raw oversized element. The substitution is a pure function of the encoded
element and `MAXBYTES`, so it is reproducible.

### 1.6 Reuse: one primitive, four instantiations

The body requires this be recursive and generic, and specifically that a future
per-issue append-only log reuse the same primitive. Here are the four
instantiations, all of the same five node kinds, the same encoder, the same
hasher, the same bound:

| collection | shape | key | where it hangs |
|---|---|---|---|
| issues, resources, targets, dispatches, authorities | `map` | stable string key | field of `root` |
| the queue | `seq` | absolute position | field of `root` |
| an issue's messages | `seq` | absolute position | field of the issue's inline record (§1.2) |
| the signed operation history | `seq` | log position | `historyRoot` in a signed `board.checkpoint` payload (§5.4) |
| a future per-issue event log | `seq` | per-issue sequence number | field of the issue's inline record, beside `messages` |

A future `issue.event` operation therefore needs **no new architecture**: it
appends one element to a `seq` subtree hanging off the issue record, exactly as
`issue.comment` appends to `messages` today. The only new work is a new operation
kind in `BOARD_OPERATION_KINDS` (`operations.ts`) and a capability in
`BOARD_CAPABILITIES`.

The security state deserves a mention. `verifyAndReplayOperationLog` derives
`authorities` incrementally from `authority.delegate` / `authority.revoke`
operations, so a client that starts from a checkpoint rather than from operation
zero cannot decide whether a later signer is authorized. The authority set is
therefore a `map` keyed by `ed25519:…` key id, referenced from `root`, and the
checkpoint carries its digest — see §5.4.

---

## 2. The three required collection shapes

Notation: `n` logical elements, `k` requested, `B` fanout (32), `d = ceil(log_B n)`
depth, `s` average encoded bytes per element. All bounds are *both* `O(d)`
sequential chunk fetches and the byte cost stated.

### 2.1 Ordered/keyed map with direct lookup

Operations claimed: `get(key)`, `put(key, value)`, `delete(key)`, `scan(from, to)`,
`count()`.

| op | chunk traversals | bytes | note |
|---|---|---|---|
| `get(q)` | `d` | `O(d · B · refbytes)` | one binary search per level over a resident `children` array of `<= B` refs; `refbytes` ~ 90, so a level is ~2.9 KiB and the whole path is ~12 KiB at `d=4` |
| `put` | `d` | `O(d · MAXBYTES)` written | new leaf + `d` ancestors |
| `delete` | `d` | `O(d · MAXBYTES)` | same |
| `scan(a,b)` returning `k` elements | `d + k/B` | `O(k·s)` | descends both edges, then walks siblings |
| `count()` | `0` | `O(1)` | the root's `n` field |

`d = 4` at `n = 10^6, B = 32`. `get` is four dependent HTTP GETs. That is the
whole cost, and it is the cost that makes §9.4 (latency) a real concern.

Structural sharing: an update rewrites only the `d` nodes on one path. Every
other chunk is reused *by digest* — the writer does not re-encode it, does not
re-upload it, and cannot corrupt it. That is the "extra persistent space for one
bounded update is `O(d)`" target from the body, and it is exact rather than
asymptotic.

### 2.2 Ordered sequence with append and range traversal

Operations claimed: `append(element)`, `range(from, to)`, `length()`.

| op | chunk traversals | bytes |
|---|---|---|
| `append(e)` | `d` | `O(d · MAXBYTES)` written |
| `range(a,b)` → `k` elements | `d + k/B` | `O(k·s)` |
| `length()` | `0` | `O(1)` |

Append is cheap for a structural reason worth stating, because it is the reason
a B+-tree and not a balanced B-tree is the right shape here: **appends only ever
split the rightmost leaf.** No other node changes except its ancestors' `n` fields,
and an ancestor's `n` is a count, not a re-encode of its children. So an append
of one small message into a 10^6-message issue rewrites `d` chunks and nothing
else.

Sequences are also the shape that makes the body's lazy-loading examples work:
`range(from, to)` is what the board feed's cursor needs, and the feed cursor
(`feed.ts`, `cursorOf`) is already `[at, position]` — a log position. A chunked
sequence makes that cursor a subtree-relative index, so a feed page is `d + k/B`
fetches instead of a full-log download followed by an in-memory slice, which is
exactly what `boardFeed` does today (`feed.ts`: it calls `feedEntries(log)` which
materializes and sorts every entry before slicing).

### 2.3 A single oversized value

Operations claimed: `whole()`, `range(byteFrom, byteTo)`, `length()`.

A blob is a chain (not a tree) of `blob-run` chunks, each carrying exactly
`runBytes` of payload plus a fixed 6-byte header, so `blob of L bytes` is
`ceil(L / runBytes)` chunks.

| op | chunk fetches | bytes |
|---|---|---|
| `whole()` | `L / runBytes` | `L` |
| `range(a,b)` → `k` bytes | `k / runBytes` | `k` |
| `length()` | `0` | `O(1)` |

This is linear, and it is linear *necessarily*. I am not going to claim otherwise:
a single opaque value has no internal structure to index, so bounded *access* is
unavailable for it. What the shape does guarantee is the invariant — no single
node exceeds `MAXBYTES`, and the chain's links are digests, so any tampering is
detected at the first mismatching run. If a future board field is both opaque and
large (an issue body of 10 MB, say), §9.5 records this as an open product
question rather than pretending a blob chain solves the UX.

---

## 3. Bounded means bounded

### 3.1 The invariant

> **Bounded Node.** For every chunk `c` reachable from a digest named by a
> verified signed operation:
> 1. `|canonicalBytes(c)| <= MAXBYTES`;
> 2. `|children(c)| <= B`;
> 3. `c.depth <= MAXDEPTH`, and `c.depth == 0` iff `c.kind` is `map-leaf`,
>    `seq-leaf` or `blob-run`;
> 4. for `map-branch`: children are strictly ascending and non-overlapping by
>    routing key, and `sum(child.n) == c.n`;
> 5. for `seq-branch`: children are contiguous by `base`, and
>    `sum(child.n) == c.n`;
> 6. for `blob-run`: `|payload| == runBytes`;
> 7. every child reference carries a 32-byte digest.

Consequences, by induction from the root downward:

- **Finiteness.** `n` is bounded at every node by clause 4/5, and each `n` is a
  safe integer (§4.1), so no node can claim to contain more than `2^53 - 1`
  elements.
- **Depth is logarithmic in `n`.** This is *not* free from clauses 1-2. A tree with
  `B = 32` and no minimum fill can be a 32-ary list of depth `n`, which satisfies
  clauses 1-4 and has *no* logarithmic access path. So the invariant needs one
  more clause, and this is the clause that makes §2's `O(log_B n)` claims true
  rather than aspirational:
  > **8. Minimum fill.** Every `map-branch`/`seq-branch` except the rightmost has
  > `>= ceil(B/2)` children, and every non-root `map-branch`/`seq-branch` has
  > `>= ceil(B/2)` children.

  Clause 8 is what stops a hostile or merely naive writer from producing a
  degenerate tree, and therefore what makes clause 3's `MAXDEPTH` a formality
  rather than the only defence. It is also why a writer must not be trusted to
  "just build it however": a *valid* chunk stream is not the same as a *balanced*
  one, and only clause 8 separates them.
- **No unbounded child array, at any level.** Clause 2 is a syntactic check
  applied by the reader before descending, on every node. There is no level at
  which a node can hold an unbounded number of children, because the check is
  applied at every level rather than only at the root. This is the direct answer
  to the body's requirement.

### 3.2 The invariant holds for all three shapes — and one honest gap

**Ordered sequence — holds.** A `seq-leaf` holds at most `B` elements, and each
element is either an inline value that fit or a digest (§1.5 rule 2). So a
`seq-leaf` is `<= MAXBYTES` by the encoder's own accumulation rule and the
reader's check. A `seq-branch` holds at most `B` child refs, each ~90 bytes, so a
branch is `<= B · 90 + overhead`, far below `MAXBYTES` at `B = 32`; branch size
is bounded by clause 2 alone. No gap.

**Oversized value — holds.** Clause 6 is exact: a `blob-run`'s payload is
`runBytes`, a constant, by construction. No gap in boundedness. The gap is in
*access*, stated in §2.3: a blob has no sub-linear random access, and no chunked
representation can give it one. That is a property of opaque data, not a defect
in this design.

**Ordered/keyed map — holds with one real gap, in the key, not the structure.**
The fanout and byte bounds hold exactly as for a sequence. The gap is that a map
*key* is not covered by either bound, because the two bounds constrain the
container, not the key's length. This is not hypothetical in this repository:
`canonicalTargetId` caps a target id at 63 characters via the `TARGET_ID` regex
(`model.ts`), so targets are safe by construction — but `isValidHost`
(`/^lubko:\/\/[^/\s?#\\]+$/`) and `pathFormDefect` impose **no length bound at
all**, so a resource key `(host, path)` is an unbounded string. A single hostile
or merely enormous resource can make a single map entry exceed `MAXBYTES`, and
the map then has no way to store it.

There are exactly two ways out, and I am not going to pick silently:

- **Refuse.** A key that cannot be encoded within the leaf bound is a rejected
  write, surfaced as a named error. Simple, honest, and it moves the bound into
  the product's validation layer — which means `model.ts` needs a length cap on
  host and path. That is a change to existing code and therefore out of scope for
  this design issue, but it is a **prerequisite**, and §9.6 records it.
- **Indirect keys.** The map stores `sha256(key)` as the routing key and puts the
  key's bytes in a blob. This preserves boundedness with no product change, but
  it destroys direct lookup by a human-supplied key: finding resource
  `(lubko://h, /a/b)` becomes a scan, `O(n/B)`, because you must hash candidates
  you cannot enumerate. For the issues map the key is a small integer and this is
  clearly the wrong trade; for the resources map it is defensible.

My recommendation is *refuse*, because the resource key is operator-supplied
rather than attacker-supplied, and because a length cap on a host and a path is
obviously correct independent of this design. But the choice is a product call
and this document does not pretend otherwise.

### 3.3 The root is bounded by schema, and that is a real argument

`root` is the one node that could reintroduce unboundedness, because it names one
child per top-level collection. It is bounded because that set is a **fixed,
closed field set**: `Board` in `model.ts` has exactly five collections plus
`nextIssueNumber`, and the canonical form requires exact keys. A `root` with a
sixth collection is a schema change, not growth, and it is rejected by the
exact-key check like any other malformed value.

The rule this implies, stated so it survives future features: **the root's field
set is closed and may not grow with the number of anything.** Any collection that
grows per user, per host, or per issue is a `map` keyed by that dimension,
referenced from the root by one digest. `root` is then `O(1)` forever.

---

## 4. Canonical encoding and hashing

### 4.1 The encoding is the existing one

Reuse `canonicalJson` / `canonicalBytes` from `packages/core/src/canonical.ts`
verbatim, as the *only* encoder for chunk bodies. Do not invent a binary format.

What that buys, from reading the existing code:

- **Determinism.** `canonicalize` sorts object keys with `Object.keys(value).sort()`
  and emits `JSON.stringify` for scalars. Same value → same string, always.
- **Key-order independence.** Object key order cannot affect the encoding, so a
  re-serialized chunk is byte-identical.
- **No float ambiguity, for free.** `canonicalize` throws unless
  `Number.isSafeInteger`. Every `n`, `base`, `depth`, `number` and `nextIssueNumber`
  field is therefore a safe integer by construction, and there is no float, no
  `-0`, no exponent-form and no bignum class of encoding ambiguity. This also
  composes with the existing guard that refuses to exhaust the issue number space
  (`operations.ts`, `applyBoardMutation` / `issue.create`).
- **Reuse of the id form.** `opId` is `sha256Id('sha256', canonicalBytes(unsigned))`
  (`operations.ts`, `operationId` / `signBoardOperation`). A chunk digest uses
  the identical construction, so `isOperationId`'s existing regex validates both.

### 4.2 What is hashed, and over what

```
digest(c) = "sha256:" + base64url( SHA-256( canonicalBytes(c) ) )
```

The whole chunk object is hashed, including its `kind`, its `v`, its `count`,
its `depth`, its `base`, and every child reference `h`/`n`/`k`. A parent
therefore commits to its children's *digests and routing metadata*, which is the
ordinary Merkle construction: a change to a leaf changes every ancestor's bytes
and therefore every ancestor's digest, up to the root, whose digest is inside
signed bytes.

Two consequences that must hold for the tree to be reproducible:

- **Routing metadata must be a pure function of the child.** `n` and `k` are
  derived from the child's own decoded content, never from the writer's local
  bookkeeping, or two correct encoders emit different bytes for the same tree.
  The reader re-derives and checks them anyway (clauses 4/5, §3.1), so a
  violation is caught rather than merely avoided.
- **Domain separation is a field, not a byte prefix.** `canonicalJson` has no
  prefix facility, and the repository already has the pattern: the credential
  self-check puts `purpose: 'antonina-board-credential-self-check-v1'` *inside*
  the canonical object it hashes (`credential.ts`, `verifyBoardCredential`). So
  each chunk carries `"domain": "antonina-chunk-v1"` as a hashed field. This means
  no chunk's canonical bytes can ever equal any signed operation's canonical
  bytes, so a chunk can never be presented as an operation and a digest can never
  be ambiguous between the two id spaces — even though both are
  `sha256:<43 chars>`.

### 4.3 The three classic traps

**Hash-of-a-hash vs hash-of-content.** A parent hashes the *encoded bytes that
contain the child digest strings*, not the child digest alone. Both are
"hash-of-content" in the Merkle sense, but the distinction that matters here is
that the parent's preimage is a full canonical encoding, so two different child
*sets* cannot produce the same parent preimage: the encoding is JSON with sorted
keys, so the child array is syntactically delimited and order-significant. A
digest is never treated as the content it stands for anywhere in the scheme; a
digest is only ever a *name* that a verifier resolves and then re-hashes.

**Leaf/branch ambiguity.** Impossible here, on two independent levels. (i) `kind`
is a required field, dispatch is on it, and the exact-key check rejects any node
with a missing or extra key. (ii) Even with `kind` deleted from the picture, the
two node classes are in different syntactic classes: a `map-leaf` has a `entries`
key and no `children` key, a `map-branch` has `children` and no `entries`, and
canonical JSON has no optional or defaulted keys, so no byte string is a valid
encoding of both. A reader that decodes a node must dispatch on `kind` and must
reject a node whose `kind` disagrees with which key it carries.

**Two byte strings, one meaning.** This is the trap the existing code is one
line short of closing, and the fix is a **canonical round-trip check on read**:

> Decode with `JSON.parse`, validate, then re-encode with `canonicalBytes` and
> require the result to be **byte-identical to the bytes received**. If it is not,
> the chunk is non-canonical and is rejected.

Why it is load-bearing rather than pedantic: `JSON.parse` silently keeps the
*last* of a set of duplicate keys, so `{"a":1,"a":2}` and `{"a":2}` mean the same
thing and would hash differently — the same logical chunk would get two digests
and dedup, identity and the "same board, same root" claim would all break. The
round-trip check rejects it. Note the check is on **bytes received**, before
anything is trusted, and it happens after the size check of §1.4.

One residual the round-trip check does **not** close, stated because it is real:
`TextEncoder.encode` replaces unpaired surrogates with `U+FFFD`, so two distinct
JS strings can encode to identical bytes, and a decode-then-re-encode comparison
will not detect it (the lossy decode already happened). Therefore the chunk
schema must additionally **reject any string containing an unpaired surrogate at
parse time**. Without that rule, two distinct byte strings with the same meaning
remain reachable, which is exactly the trap. This is not a hypothetical: it is a
property of the exact encoder the repository already uses.

---

## 5. Composition with the signed log

This is the section the body calls load-bearing, so I will be precise about
bytes.

### 5.1 What is signed today, exactly

From `operations.ts`:

```
unsigned = { schemaVersion, boardId, previous, signerKeyId, timestamp, nonce, kind, payload }
bytes    = canonicalBytes(unsigned)
opId     = "sha256:" + base64url(SHA-256(bytes))
signature = Ed25519(signerKey, bytes)
```

`verifyAndReplayOperationLog` reconstructs `bytes` from the re-parsed operation,
checks `opId === SHA-256(bytes)`, and checks `verifyBytes(publicKey, signature, bytes)`.

So the signature covers, verbatim: the board id, the predecessor opId, the signer
key id, the timestamp, the nonce, the operation kind, and **the payload with all
its nested content inline**. It does not cover `log.head` (which is separately
checked to equal the last opId), `log.rootKeyId` (checked against the anchor), the
opId (derived), or the signature itself.

### 5.2 The answer: the content hash is not a redundant second layer

Under this design a payload may hold a digest instead of an inline value, so the
signature commits to 43 characters rather than to the bytes. Three properties the
signature then supplies that the content hash cannot, and one the content hash
supplies that the signature then cannot:

**The signature supplies identity, order and authority; the hash supplies
inclusion.** The signature is what makes an operation *real* (a known, non-revoked
signer held the right capability) and *ordered* (`previous` chains it, `nonce`
and `timestamp` are in the preimage). No amount of hashing establishes that. The
content hash is what makes the operation's *named content* checkable without
fetching it.

**This is not a weakening of tamper detection; it is a change of what is
transitively covered, and the propagation is by hash chain.** Concretely, for the
question the body asks — *what happens if a chunk is swapped for another chunk of
the same length but different content?*

1. The two chunks have different digests, because the digest is over content.
2. The parent `map-leaf`/`map-branch` that referenced chunk X contains `X`'s digest
   string in its canonical bytes. Substituting Y changes those bytes.
3. So the parent's digest changes, and by §4.2 so does every ancestor's digest.
4. The root's digest changes.
5. The root's digest is a field of a **signed operation payload** (§5.4). That
   operation's signature no longer verifies, because the signed preimage changed.

The length of the substitute is irrelevant at every step, because nothing in the
chain is a function of length — `n` is a *count* and `k` is a *key*, and a swapped
chunk with the same element count and a different key would be caught by clause 4
or 5 even before the digest changed. So "the signature still covers it" is true,
but only in this precise sense: **the signature covers the root digest, and the
root digest transitively covers every descendant's content through the Merkle
chain, and the chain is broken at the first substituted chunk.** The important
architectural consequence is that this requires the root digest to be *inside*
signed bytes. It cannot be a sibling Skrynia key. That is why §5.4 puts it in an
operation payload.

**Without the substitution, the whole design does not work**, so it is worth being
blunt about the cost: a signed payload that names a subtree means a malicious
signer can commit to an arbitrarily large tree. What bounds the victim is not the
signer's honesty and not Skrynia — it is clauses 1-2 of §3.1 being checked by the
*reader* before parsing. The bound is a client obligation.

### 5.3 What a verifier has to fetch

Three distinct questions, three distinct costs:

| question | what must be fetched | cost |
|---|---|---|
| is this operation authentic and authorized? | the operation record alone | `O(1)` |
| what is the state after the checkpoint? | the `board.checkpoint` operation, then the chunks on the path to what you want | `O(d + k/B)` |
| prove the chunked state is *the* log, from operation zero | the whole chain, one record at a time | `O(h)` — this is the deliberate audit path, and it is unchanged |

This is the concrete form of the body's target "verification for one lazy
operation: proportional to fetched bytes/chunks, not whole board size."

The first two rows are only available because the payload carries a digest. If
the signature covered the message bodies inline, row 2 would be `O(total bytes)`
and the entire design would be pointless. **That is the load-bearing reason the
content hash earns its place.**

### 5.4 The head, the checkpoint, and what must be signed

The single mutable object is the head key, and it is exactly one small signed
operation:

```
kind:    "board.checkpoint"
payload: {
  stateRoot:    "sha256:…",   // the `root` chunk of §3.3
  historyRoot:  "sha256:…",   // a `seq` subtree over log positions
  historyCount: <safe int>,
  historyIndex: "sha256:…",   // a `map` chunk: opId -> position
  authorities:  "sha256:…",   // a `map` chunk: keyId -> {publicKey, parentKeyId, capabilities, revoked}
  headOpId:     "sha256:…",   // the last operation this checkpoint covers
  previous:     "sha256:…"    // the previous head object, so heads chain too
}
```

`headOpId` and `previous` chain the head objects themselves, so the head key
remains a single ETag-CAS'd object and rollback of the head key is detectable
through the `previous` chain exactly as it is today for the log.

**`authorities` is the field that makes truncation safe.** `verifyAndReplayOperationLog`
derives the authority set incrementally from `delegate`/`revoke` operations, so a
client starting at a checkpoint cannot decide whether a later operation's signer
is a live authority unless the checkpoint carries that state. Carrying it is what
makes "simply truncating history" unacceptable, as the body requires, while still
letting archived segments drop off the hot path. It is a `map` chunk rather than
an inline array precisely because the delegation set is not something I can bound
today — if it ever grew past `MAXBYTES` the payload would carry a digest and
nothing else would change.

**`historyIndex` preserves rollback protection.** Today `verifyAndReplayOperationLog`
refuses a log that does not contain `previouslyAcceptedHead`
(`options.previouslyAcceptedHead`, checked against the `seen` set). With history
chunked, "contains" must not become `O(h)` again, or §1's entire benefit is lost
on the very first read of every session. The checkpoint therefore commits to an
`opId -> position` map chunk, and the membership test is a keyed lookup:
`O(log_B h)`. If that index is not covered by the checkpoint's signed digests, an
attacker could simply omit the entry and defeat the check — so it is a signed
field, not a convenience.

### 5.5 Startup

```
GET head key                        O(1) bytes, one ETag
verify the head operation's signature                   O(1)
walk `previous` head chain while headOpId is unknown to this client   bounded by trust depth
descend stateRoot for the queue slice / the issue / the feed page      O(d + k/B)
fetch the bounded recent tail from historyRoot                          O(t)
```

Independent of `h` except for `t`, and independent of `n` except for the
requested slice. `t` is a writer policy (how many operations to leave outside a
checkpoint), and it is a *retention* parameter, not a storage-format parameter —
it is written into the checkpoint's `historyCount`/`historyRoot` boundary and is
not a page size, so it does not violate the "persistence stays generic"
constraint. §9.7 notes the tension honestly anyway.

---

## 6. The write path

Content addressing is easy for reads and hard for appends. Here is the cost,
stated as a protocol.

### 6.1 What replaces the whole-object PUT

Today, per operation: `GET` whole log → verify whole log → `structuredClone`
whole log → re-verify whole candidate → `PUT` whole candidate → `GET` whole log →
verify whole log. Five `O(total bytes)` steps.

After: per operation,

1. **Read the head** (`GET` head key) and verify its signature. `O(1)`.
2. **Build** the new operation. Its payload holds digests, not bodies.
   `O(payload)`.
3. **Encode the changed path bottom-up.** New leaf, then each ancestor, each
   hashed as it is produced. A parent is built from the digest its child *just
   returned*, never from a digest the writer remembered.
4. **Publish the new chunks** before the head: `POST` each new chunk.
   Create-only, `O(d)` requests, `O(d · MAXBYTES)` bytes.
5. **Commit**: `PUT` the new head operation with `If-Match: <head etag>`.
   `O(1)` bytes, one request. This is the only commit point.
6. **Accept** the new head as `previouslyAcceptedHead`.

### 6.2 What an append costs

`O(d)` chunk writes plus one small CAS. For an `issue.comment` on a board with
`10^6` issues: `d = 4`, so ~5 `POST`s of at most 64 KiB each, plus one `PUT` of a
few hundred bytes. The root chunk is the largest fixed cost at
`B · ~90 bytes ≈ 2.9 KiB`.

This is `O(log_B n)` newly written path chunks and `O(1)` publication. It is
**not** `O(size of the collection)`, and the difference is the entire point.

Because a sequence append only splits the rightmost leaf (§2.2) and a map append
only touches the rightmost path, no append ever rewrites a subtree it did not
change, and no append re-uploads an existing chunk at all.

### 6.3 How an inconsistent tree is prevented

This is the question the brief singles out, and content addressing answers it
cleanly enough to state as a rule:

> **Publication is a single small CAS over one head object, and every chunk is
> immutable and named by its own content.** Therefore a partially completed write
> is *always* safe: the chunks written so far are unreferenced, and the old head
> still names the old root over chunks that were never touched.

There is no window in which a reader can observe a mixture, because there is no
moment at which any *referenced* chunk has changed. This is stronger than a
transaction and it is not something I have to defend with a rollback log.

The complementary obligation, which is where writers actually go wrong:

> **A chunk is never published from memory.** The writer must compute the
> digest, publish the child, take the child's digest *from the publish result*,
> and build the parent from that. A writer that cannot complete a path must
> publish nothing — and cannot, because the head CAS is the only thing that makes
> a chunk reachable.

Two protocol details that follow:

- **Idempotent re-publication.** Content addressing means a `POST` of an already
  present key is not an error condition, it is a confirmation. The rule: on `409`,
  `GET` the existing object and require that its canonical bytes hash to the
  digest you intended. If they do, continue; if they do not, that is a
  corruption or a hash collision and the write must abort. Silently treating
  `409` as success without the check would accept a corrupted store.
- **CAS retry.** On `412`, re-read the head, re-derive, re-build. The existing
  retry loop in `SignedBoardStore.append` (`DEFAULT_MAX_ATTEMPTS = 6`) carries
  over unchanged, and it carries the rollback check with it, because
  `previouslyAcceptedHead` is re-asserted on every retry.

### 6.4 The worst case, honestly

The worst case is not the chunk tree. It is the **history replay**, and this
design does not by itself fix it. A client that must verify from operation zero —
`audit`, or a first-time trust of a board whose head chain it does not trust —
pays `O(h)`, and after this design it would additionally pay a `GET` per history
chunk. The design reduces that cost for the *normal* path (§5.5) and leaves the
audit path linear, which is the honest outcome: an append-only signed log cannot
be verified faster than its own length without trusting something.

The other honest worst case is the one in §9.4: the *common* path gets **worse**,
from one GET to `d` dependent GETs. At Antonina's current board size `d = 1` and
it is one extra round trip. The design is a bet that boards grow, and at today's
size the bet has not paid yet.

---

## 7. Migration

### 7.1 What is *not* being migrated

`antonina/board-v2` is not mutated, rewritten, or replaced. It stays readable
forever. Its key keeps its name, its object keeps its bytes, and every signature
in it keeps verifying against exactly the bytes it signed.

This is the constraint from board issue 73 — *a migration must not silently
rewrite previously signed objects and then pretend the old signature covered the
rewritten value* — and it is honoured structurally rather than by policy.

### 7.2 The chunked board is a new board, linked by a signed claim

The chunked board is a **new board with a new `boardId`, a new root key, and a new
trust anchor**, at new Skrynia keys. Its genesis is a new operation kind,
`board.import`, signed by the new root:

```json
{
  "schemaVersion": 1,
  "boardId": "<new board id>",
  "previous": null,
  "signerKeyId": "ed25519:…",
  "timestamp": "…",
  "nonce": "…",
  "kind": "board.import",
  "payload": {
    "sourceBoardId": "<old board id>",
    "sourceRootKeyId": "ed25519:…",
    "sourceHeadOpId": "sha256:…",
    "sourceStateDigest": "sha256:…",
    "stateRoot": "sha256:…",
    "authorities": [{ "keyId": "…", "publicKey": "…", "capabilities": [...] }]
  }
}
```

The load-bearing field is `sourceHeadOpId`. Because `opId` is by construction the
hash of the exact bytes the old signature covers (§5.1), naming it asserts
precisely: *"I have read and verified the old board under that trust anchor up to
and including this operation, whose identity is this digest."* It asserts nothing
about the new bytes. The new root's signature covers the new payload; the old
signature covers the old bytes; neither pretends to cover the other. That is
exactly the distinction issue 73's constraint draws.

### 7.3 The cost of that honesty, stated plainly

**The new board does not transitively verify the old board's signature chain.**
A client that trusts only the new anchor learns a *claim* about an opId, not the
chain. Anyone who needs the old chain verified must verify it themselves against
the old anchor. This is a real reduction in the "one log is the whole truth"
property, and it is a consequence of the constraint, not an oversight.

The default should therefore be: the importer **does** verify the entire old chain
before signing `board.import`, and records that it did. That is `O(h)` once, at
import, and it is the right trade — it is a one-time cost on a board that
migration happens to anyway. Whether the importer's assertion is *recorded* as
trustworthy is a trust-model question I am deliberately not answering here, because
it is a change to what a `boardId` means and issue 73 owns that.

### 7.4 One-time persisted, not lazy

The conversion is a **one-time persisted migration**, and it cannot be lazy. The
reason is not conservatism: a digest in a signed payload must be resolvable by any
verifier holding nothing but the head and the trust anchor. If chunks were
materialized lazily, a verifier that had not materialized them could not check the
state it was served, and the signature would be covering something unfetchable.
Chunks must be published *before* the head CAS — which §6.3 already requires as a
general rule and which here is not negotiable.

What *is* optional: the archived history segments. The new board can begin with
`historyCount = t` and no older segments, provided `board.checkpoint` carries
`authorities` and `headOpId` (§5.4), and provided the old `board-v2` remains
readable as the archive. Deferring the bulk history conversion to a background
task is legitimate; deferring the *state* conversion is not.

### 7.5 Determinism is a hard requirement of the conversion

Two independent importers of the same board must produce byte-identical chunks,
or the second one's `stateRoot` will not match the first's and the import is not
reproducible. This is where the existing code is not ready, and it is the most
important finding in this document.

**`parseCanonicalBoard` sorts `resources` with `localeCompare`**
(`model.ts`):

```ts
resources: [...board.resources].sort((left, right) =>
  left.host.localeCompare(right.host) || left.path.localeCompare(right.path)),
```

`localeCompare` is ICU- and locale-dependent. The same file sorts `targets` with a
code-unit comparator whose own comment says *"Code-unit comparison, so ordering
never depends on a locale"*, and `operations.ts` sorts delegated keys and target
ids by code unit for the same reason. The resource sort is the odd one out.

Today that is a latent inconsistency: the same board can serialize in a different
order on two machines. Under content addressing it becomes fatal — an importer on
a machine with a different ICU locale produces different chunk bytes, a different
`stateRoot`, and an import whose `stateRoot` does not reproduce. It is also not
something this design can route around: the resource order is *inside* the value
being chunked, and the legacy v2→v3 promotion in `upgradePersistedBoard` is
applied to the same value.

**Replacing `localeCompare` with code-unit comparison in anything reachable from
a hashed value is a prerequisite for this design, and it is a change to existing
code that this design issue does not make.** §9.1.

Everything else the conversion depends on is already deterministic: the v2→v3
promotion is a pure splice plus `parseCanonicalBoard`, `parseCapabilityList`
enforces sorted-and-duplicate-free delegation capabilities, and canonical JSON is a
function of the parsed value.

---

## 8. What would make this wrong

### 8.1 Load-bearing assumptions

1. **Skrynia's storage capability is namespace-scoped, not per-key.** If the
   capability guards only `antonina/board-v2`, chunk objects are unwritable and
   the design is dead. The intent record `docs/intent-records/board.md` says the
   capability is "generic write authority over the storage it guards", which
   reads as namespace-scoped, and `web/src/api.test.ts`'s fake treats it as an
   opaque single value. **I did not read Skrynia's source.** This is assumption
   one, and it is the one to check first.
2. **Skrynia's maximum object size is at least `MAXBYTES`.** Unverified. If it is
   small, `B` and `MAXBYTES` both shrink and `d` grows, which makes assumption 3
   worse, not better.
3. **Latency, not bandwidth, is the scarce resource.** The design trades one
   request for `d = log_B n` dependent requests. See §8.2.
4. **Boards will actually grow.** Antonina's board is at ~70 issues today. At that
   size `d = 1`: the chunked design is one extra dependent round trip and a
   considerable amount of new format for no benefit. **This design is a bet on
   growth, and the bet has not paid yet.**
5. **Readers honour the bound checks.** §1.4's read-side enforcement is a client
   obligation with no storage-side backstop. A client that parses before checking
   is exploitable by a malicious signer. There is no way to make this
   storage-enforced without adding Antonina logic to Skrynia, which the body
   forbids.
6. **Minimum fill (clause 8) is genuinely enforced.** A valid-but-unbalanced tree
   is a denial-of-service shape, not a correctness bug, and it is the easiest
   thing for an implementer to leave out.

### 8.2 Where the design is worse than what we have

- **Latency on the common path.** Today `board show 70` is one `GET`. After, it
  is `1 + d` dependent `GET`s. At 50 ms RTT and `d = 4` that is 250 ms instead of
  50 ms. Real, and it lands on the most-used command.
- **Garbage collection becomes mandatory and is currently impossible.**
  Content addressing orphans `O(d)` chunks on *every single append* — today's
  garbage is one key, and deleting it is a single delete. The brief correctly says
  GC is a separate concern, but I want to be blunt: this design does not make GC
  harder to schedule, it makes it *necessary for correctness of cost*, and Antonina
  does not appear to use any Skrynia listing API (`web/src/api.test.ts` only ever
  addresses one known key, and returns `404` for everything else). Without a
  listing primitive, unreachable chunks are unreachable garbage forever.
  **I would treat "Skrynia can enumerate a namespace" as a co-requisite.**
- **Write amplification in request count.** ~5 `POST`s per append instead of one
  `PUT`. Against a store with no batching, that is a 5x round-trip regression on
  the write path. If Skrynia gains any multi-key write, that changes.

### 8.3 What I did not resolve

- **`B` and `MAXBYTES`.** Provisional at 32 and 64 KiB. They are a joint function
  of Skrynia's limits, request latency, and the element-size distribution. I have
  no measurements and I did not run any.
- **Whether `board.import` is a new operation kind or a flag on
  `board.initialize`.** `BOARD_CAPABILITIES` has no import capability. Adding one
  is a change to the trust model — who is allowed to migrate a board — and that
  is issue 73's call, not this document's.
- **Whether `queue.reorder` should move to a digest payload.** Its payload is
  `{numbers: number[]}` and `exactOpenIssueQueue` requires it to name *every open
  issue exactly once*, so the signed payload is `O(open issues)` and the body
  does not fix this by chunking state. Chunking the reorder list behind a digest
  would fix it, but it changes the meaning of a capability-scoped signed
  operation, so it needs 73's blessing. Flagged, not decided.
- **Blobs for large issue bodies.** A 10 MB issue body becomes an opaque 320-chunk
  chain with no sub-linear access (§2.3). Whether that is acceptable, or whether a
  large body should simply be refused, is a product call.
- **The locale-dependent resource sort** (§7.5) and the **unbounded resource
  key length** (§3.2) are both pre-existing defects in `model.ts` that this
  design exposes but cannot fix. They probably deserve their own issues.

### 8.4 Where the body's constraints bind the answer

- *"Skrynia remains generic/dumb storage; no Antonina application server."* —
  Respected. Everything here is a client-side encoding over a flat key/value store
  with existing GET/POST/PUT-with-`If-Match`. The one place this gets uncomfortable
  is GC, which wants a listing API — but a *generic* listing API is not
  Antonina-specific logic, so asking Skrynia for it stays inside the constraint.
  I am not proposing anything Skrynia must understand about boards, Merkle trees
  or issues.
- *"Clients must cryptographically verify the state they consume."* — Respected
  and strengthened by §5: verification becomes proportional to bytes fetched
  rather than proportional to the board.
- *"State is loadable lazily and incrementally."* — This is the design.
- *"Persistence stays generic; no UI pagination or page size in storage."* —
  Respected. `B` and `MAXBYTES` are format constants. The feed cursor stays a log
  position (`feed.ts` already encodes `[at, position]`), and the checkpoint's
  `historyCount` is a *retention boundary*, not a page size — the store does not
  know or care that a UI shows 50 at a time.

Nothing in the constraints made the design infeasible. The one genuine tension I
found is GC, and it is a gap in the *storage contract*, not in the constraints.

---

## 9. Disagreements between the issue body and the code

Recorded because a design built on the body's description rather than the code
would be built on the wrong foundation.

1. **The body conflates two version axes.** "`board-v2` stores the complete
   signed operation log" is right, but "the live persisted board is `board-v2`
   and the current client is `board-v3`" treats the Skrynia key name
   `board-v2` (`board-store.ts:26`) as if it were a schema version. It is not.
   The stored object is a `BoardOperationLog` at oplog schema version `1`
   (`operations.ts:22`); the *nested* board is schema version `3` with legacy `2`
   readable (`model.ts:1-2`). Three axes, not two, and they move independently.
   Migration has to be specified against all three.
2. **Replay is worse than "reads download and replay the complete history."**
   `applyBoardMutation` does a `structuredClone` **and** a full `parseBoard` on
   every operation (`operations.ts`), so a verified read is
   `O(operations × boardSize)`, not `O(operations + boardSize)`. A design that
   assumes linear replay will understate the win.
3. **The body's monolithic-state claim is slightly incomplete.**
   `BoardIssue.messages` and `BoardResource.issueNumbers` are unbounded, but so is
   the `queue.reorder` **signed payload** — `exactOpenIssueQueue` requires it to
   name every open issue exactly once. Chunking the materialized state does not
   fix that; the signed bytes are still `O(open issues)`. It needs a digest
   payload, which is a separate change (§8.3).
4. **The body says "a future append-only per-issue log" as if it were a new
   thing.** It already exists in the form of the operation log plus the feed
   projection (`feed.ts`), and §1.6 shows the per-issue event log is the same
   primitive with a different key. The body's instinct is right; the framing
   slightly undersells it.
5. **Nothing in the body anticipates the locale-dependent sort** (§7.5), which is
   a prerequisite for any content-addressed encoding of the current board. This is
   the one finding that would actually break an implementer who followed the body
   faithfully.

---

## 10. Honesty table

| § | Topic | Status | Why |
|---|---|---|---|
| 1 | Chunk abstraction: node kinds, contents, bound, enforcement, oversized values, recursive reuse | **ANSWERED** | Five kinds, two bounds, write+read enforcement, deterministic splitting, four instantiations shown in the same encoding |
| 2 | Three shapes with operation sets and costs | **ANSWERED** | Per-op chunk traversals and byte costs stated with `B`, `s`, `MAXBYTES`; the one linear case (blobs) is called linear |
| 3 | Boundedness proof | **ANSWERED, with one named gap** | Invariant stated with 8 clauses incl. minimum fill; holds for sequences and blobs without qualification; the keyed map has a real gap in unbounded *keys* (§3.2, `isValidHost`/`pathFormDefect` impose no length cap) with two resolutions, neither silently chosen |
| 4 | Canonical encoding and hashing | **ANSWERED** | Reuses `canonical.ts`; domain-separation field; all three traps addressed, incl. the unpaired-surrogate case that a round-trip byte check does **not** close |
| 5 | Composition with the signed log | **ANSWERED** | Exact signed bytes named; same-length substitution traced step by step to the failing signature; three fetch costs; `authorities` and `historyIndex` fields specified for safe truncation and rollback |
| 6 | Write path | **ANSWERED** | Six-step protocol, `O(d)` writes + `O(1)` CAS, the partial-write safety argument, the never-publish-from-memory obligation, `409` handling, and the replay worst case that the design does *not* fix |
| 7 | Migration | **ANSWERED** | New board + new anchor, `board.import` carrying `sourceHeadOpId`; consistent with issue 73's constraint; one-time persisted, not lazy, with the reason; the transitive-verification cost stated |
| 8 | What would make this wrong | **ANSWERED** | 6 load-bearing assumptions, 3 places it is worse than today, 5 unresolved questions |
| 9 | Body-vs-code disagreements | **ANSWERED** | 5 findings, each with a file citation |

Not answered anywhere, deliberately: actual `B`/`MAXBYTES` values (need
measurements I was not permitted to take), Skrynia's real limits and listing
support (different repository), and the trust-model question of what a migrated
board's `boardId` asserts (issue 73's).
