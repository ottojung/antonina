# Antonina public object identifiers (issue #320)

**Current invariant (2026-10-20):** Antonina has exactly one identity per board issue and per managed agent, represented everywhere outside persisted-wire adapters as a case-sensitive, opaque string. Old issue `320` is the string `"320"` when consumed; a new ID such as `7Ka9mQ2xP4vT8nB3cR5dH1-otter` is just another string. No consumer distinguishes them, validates the generator's spelling, casts the ID to an integer, parses the word, or introduces a separate public and private issue identity. Only the generator knows the construction. The board issue object's historically named `number` field contains that string ID. Sequence counters in stored legacy metadata are **not** new identity allocators. Old signed numeric wire payloads are verified in their original representation, then adapted to string IDs *after* signature verification. In the CLI, `board create --json` returns a complete issue object (`number` is its ID), whereas `agent new --json` returns an object containing `id`.


$id-320-random-word-ids
title: New persistent entity identities are independent random base62-word IDs
date: 2026/10/19
source: issue-320
kind: requirement

A newly created managed agent or board issue is assigned its own identity by Antonina's shared core. Callers cannot supply that ID at creation. The canonical generated identifier is exactly 22 independent random characters from the base62 alphabet `0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`, followed by a hyphen and one independently random common, easy-to-pronounce, lowercase English word from Antonina's curated dictionary. The full string is the identity. Words may repeat; a word alone never identifies an object and is not a valid CLI reference. The prefix and word are independently selected and generation does not consult or mutate any globally shared identifier counter, rotating word queue, or remote allocation service. Use OS-provided secure randomness as an inexpensive source of random bytes; identifiers are public labels, not authentication tokens.

New identifiers must be accepted unchanged by all relevant CLI commands, the web app, and storage paths. Existing agent hex IDs and existing numeric board issue identifiers remain valid and unchanged. Never rewrite or re-sign historical operations simply to change their identifiers. Existing cryptographic content addresses (including signed operation hashes already used for comments and feed entries) remain content-derived; do not replace them with arbitrary random strings. Other sequence numbers may continue to order records, but never stand in for generated public identities. A failed creation exits nonzero, reports diagnostic text on stderr, and must not print a successfully created ID.

Creation commands print only the complete new identifier followed by a newline on normal stdout. `--json` requests structured output including the same `id`. For example, `agent_id=$(antonina agent new --cwd /workspace/project)`, then `antonina agent run --id "$agent_id" --prompt ...`. The same principle applies to `antonina board create`.
