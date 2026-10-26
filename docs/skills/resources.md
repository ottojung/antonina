# Work continuity: prose, not host registration

The Antonina board stores issues, conversation, priority queue, and temporary issue work claims. It does **not** register machines, filesystem locations, project ownership, deployment targets, or garbage-collection eligibility.

Agents may describe any execution context, local paths, deployment details, prerequisites, or handoff directions in **ordinary issue descriptions and comments**. Antonina treats this as opaque text. No parser, prefix, first-line syntax, schema field, or command gives such wording machine-enforced meaning.

A shared temporary scheduler claim coordinates logical work using an issue identifier, an agent identifier, a random token, and expiration. A claim neither establishes permanent ownership nor encodes execution location. Agents independently reason about overlapping work and the instructions in the issue text.

## Handoffs

When leaving work for another agent, write what remains to do, the relevant changes and artifacts, and any context needed to resume in a normal issue comment. The receiving agent reads it as text and determines the next useful action. Do not create a machine registry or a second structured routing channel.

## Cleanup

There are no `antonina board resource` or `antonina board collect` commands. Closing an issue or releasing a claim never authorizes deleting a directory. Filesystem cleanup is a separately authorized local action, and must not infer deletion authority from board state or task wording alone.

This document replaces the historical resource-registry instructions. Historical signed events remain verifiable but have no effect on the current board's execution or deletion semantics.
