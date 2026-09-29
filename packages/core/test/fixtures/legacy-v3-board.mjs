/**
 * A pre-cutover Antonina v3 board, in the exact on-disk shape the immutable
 * materialized-snapshot model wrote.
 *
 * This is a fixture of the *old format*, not of a board that a test happened to
 * build: the refs are head-named (`meta:<head>`, `snapshots:<number>:<head>`,
 * `comments:<number>:<head>:<page>`, `directory:<head>:<page>`, `open:<head>:<page>`,
 * `feed:<head>:<page>`), the shards carry a `revision` field, and the comment feed
 * entries carry a `commentRef` into the comment page. Every one of those is a
 * property the current format does not have, which is what makes this a real
 * import source rather than a renamed copy of the new one.
 *
 * The board is deliberately awkward in the ways a production board is:
 *
 *   - issue 3 is **closed**, so the closed list page and the closed ordering exist;
 *   - issue 4 was **deleted** before the snapshot was taken, so its comments are
 *     only reachable through the feed -- exactly the case the old commentRef form
 *     existed for, and the one the import has to resolve rather than copy;
 *   - issues 1 and 2 carry **multi-page comment threads** (more than 50 comments),
 *     so comment paging is exercised;
 *   - the feed is longer than one page, so feed paging and cursor order are
 *     exercised;
 *   - the catalog carries a resource, a target and a dispatch, so the catalog is
 *     not trivially empty;
 *   - timestamps and authors vary per comment, so the import cannot pass by
 *     dropping them.
 *
 * The ids are fixed so a test can name a specific comment, and `buildLegacyBoard`
 * returns the object map plus the head and the refs a test needs to assert against.
 */

import { createHash } from 'node:crypto';

const HEAD = 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOARD_ID = 'board-fixture-legacy-v3';
const ROOT_KEY_ID = 'ed25519:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

/**
 * A comment whose timestamp is strictly increasing in `index`.
 *
 * The board model requires a thread to be chronological, so the fixture has to
 * produce one that is: a per-issue counter that wraps at 60 would produce an
 * out-of-order thread and the import would be refused by the canonical parser
 * for a reason that has nothing to do with the migration.
 */
function comment(index, issue, minute) {
  return {
    id: `sha256:${String(index).padStart(43, '0')}`,
    author: `author-${index % 3}`,
    body: `comment body ${index} on issue ${issue}`,
    createdAt: timestamp(minute),
  };
}

/**
 * Minutes past 2026-09-20T00:00:00Z, as an ISO timestamp.
 *
 * Rolled into real days rather than clamped to 24 hours, because a fixture whose
 * timestamps are not real timestamps fails the board's own canonical parser, and
 * the resulting error would be about the fixture rather than about the import.
 */
function timestamp(minute) {
  const day = 20 + Math.floor(minute / 1440);
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `2026-09-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:`
    + `${String(minutes).padStart(2, '0')}:00.000Z`;
}

function messageIdFor(index) {
  return `sha256:${String(index).padStart(43, '0')}`;
}

export const LEGACY_FIXTURE = {
  head: HEAD,
  boardId: BOARD_ID,
  rootKeyId: ROOT_KEY_ID,
  /** Issue numbers, in directory order, with their state and message counts. */
  issues: [
    { number: 1, state: 'open', messages: 60, body: 'issue one body' },
    { number: 2, state: 'open', messages: 51, body: 'issue two body' },
    { number: 3, state: 'closed', messages: 3, body: 'issue three body' },
    { number: 5, state: 'open', messages: 1, body: 'issue five body' },
  ],
  /** An issue deleted before the snapshot; only its comments survive, in the feed. */
  deletedIssue: { number: 4, messages: 2 },
  feedEntries: 130,
  resources: 1,
  targets: 1,
  dispatches: 1,
};

const V3_ISSUE_PAGE_SIZE = 50;
const V3_COMMENT_PAGE_SIZE = 50;
const V3_FEED_PAGE_SIZE = 50;

/**
 * The whole pre-cutover board as a map of Skrynia key to stored object.
 *
 * Keys are the storage keys, computed the way the store computed them, so a test
 * can read the fixture through a real `ShardedBoardStore` rather than reaching
 * into its internals. `capability` is supplied because the locator is derived from
 * it.
 */
export function buildLegacyBoard(capability, identity = {}) {
  const { head } = LEGACY_FIXTURE;
  // The board identity comes from the credential that will read it, because a
  // real pre-cutover board's pointer and its credential always agree. A fixture
  // with its own board id would be refused by the trust check, which is correct
  // behaviour and would make this fixture untestable.
  const BOARD_ID = identity.boardId ?? LEGACY_FIXTURE.boardId;
  const ROOT_KEY_ID = identity.rootKeyId ?? LEGACY_FIXTURE.rootKeyId;
  const objects = new Map();
  const put = (key, value, mode = 'immutable') => {
    objects.set(locate(capability, key), { value, mode, capability: null, revision: 1 });
    return key;
  };
  const keyOf = (name) => locate(capability, name);

  const directoryRefs = [];
  const issueRefs = new Map();
  const commentRefsByIssue = new Map();
  let minute = 0;

  for (const summary of LEGACY_FIXTURE.issues) {
    const messages = [];
    for (let index = 0; index < summary.messages; index += 1) {
      messages.push(comment(index, summary.number, ++minute));
    }
    const refs = [];
    for (let offset = 0; offset < messages.length; offset += V3_COMMENT_PAGE_SIZE) {
      const pageNumber = Math.floor(offset / V3_COMMENT_PAGE_SIZE) + 1;
      const key = `comments:${summary.number}:${head}:${String(pageNumber).padStart(9, '0')}`;
      put(key, {
        schemaVersion: 2,
        boardId: BOARD_ID,
        number: summary.number,
        page: pageNumber,
        revision: 7,
        messages: messages.slice(offset, offset + V3_COMMENT_PAGE_SIZE),
      });
      refs.push(key);
    }
    commentRefsByIssue.set(summary.number, refs);
    const key = `snapshots:${summary.number}:${head}`;
    put(key, {
      schemaVersion: 2,
      boardId: BOARD_ID,
      number: summary.number,
      revision: 7,
      issue: {
        number: summary.number,
        title: `Issue ${summary.number}`,
        body: summary.body,
        state: summary.state,
        createdAt: '2026-09-20T09:00:00.000Z',
        updatedAt: timestamp(minute),
      },
      closedAt: summary.state === 'closed' ? '2026-09-20T11:30:00.000Z' : null,
      messageCount: messages.length,
      commentRefs: refs,
    });
    issueRefs.set(summary.number, key);
  }

  // Directory pages, one per 50 issue numbers, as the old model wrote them.
  const maxIssue = Math.max(...LEGACY_FIXTURE.issues.map((issue) => issue.number));
  for (let page = 1; page <= Math.ceil(maxIssue / V3_ISSUE_PAGE_SIZE); page += 1) {
    const entries = LEGACY_FIXTURE.issues
      .filter((issue) => Math.floor((issue.number - 1) / V3_ISSUE_PAGE_SIZE) + 1 === page)
      .map((issue) => ({ number: issue.number, ref: issueRefs.get(issue.number) }));
    const key = `directory:${head}:${String(page).padStart(9, '0')}`;
    put(key, { schemaVersion: 2, boardId: BOARD_ID, page, revision: 7, entries });
    directoryRefs.push(key);
  }

  const summariesFor = (state) => LEGACY_FIXTURE.issues
    .filter((issue) => issue.state === state)
    .map((issue) => ({
      number: issue.number,
      title: `Issue ${issue.number}`,
      state: issue.state,
      createdAt: '2026-09-20T09:00:00.000Z',
      updatedAt: timestamp(minute),
      closedAt: issue.state === 'closed' ? '2026-09-21T11:30:00.000Z' : null,
      messageCount: issue.messages,
      hasBody: issue.body.length > 0,
    }));
  const openPageRefs = [];
  const openSummaries = summariesFor('open');
  for (let index = 0; index * V3_ISSUE_PAGE_SIZE < openSummaries.length; index += 1) {
    const key = `open:${head}:${String(index + 1).padStart(9, '0')}`;
    put(key, {
      schemaVersion: 2,
      boardId: BOARD_ID,
      state: 'open',
      page: index + 1,
      revision: 7,
      total: openSummaries.length,
      entries: openSummaries.slice(index * V3_ISSUE_PAGE_SIZE, (index + 1) * V3_ISSUE_PAGE_SIZE),
    });
    openPageRefs.push(key);
  }
  const closedPageRefs = [];
  const closedSummaries = summariesFor('closed');
  for (let index = 0; index * V3_ISSUE_PAGE_SIZE < closedSummaries.length; index += 1) {
    const key = `closed:${head}:${String(index + 1).padStart(9, '0')}`;
    put(key, {
      schemaVersion: 2,
      boardId: BOARD_ID,
      state: 'closed',
      page: index + 1,
      revision: 7,
      total: closedSummaries.length,
      entries: closedSummaries.slice(index * V3_ISSUE_PAGE_SIZE, (index + 1) * V3_ISSUE_PAGE_SIZE),
    });
    closedPageRefs.push(key);
  }

  const queueRef = put('queue', {
    schemaVersion: 2,
    boardId: BOARD_ID,
    revision: 7,
    numbers: [1, 2, 5],
  });
  const catalogRef = put('catalog', {
    schemaVersion: 2,
    boardId: BOARD_ID,
    revision: 7,
    resources: [{
      host: 'lubko://gpu-02',
      path: '/srv/legacy',
      issueNumbers: [1],
      createdAt: '2026-09-20T09:30:00.000Z',
      updatedAt: '2026-09-20T09:30:00.000Z',
    }],
    targets: [{
      id: 'legacy-target',
      backend: 'lubko',
      kind: 'persistent-host',
      status: 'available',
      capabilities: ['persistent-filesystem'],
      address: 'lubko://gpu-02',
      description: 'a legacy target',
      limitations: ['no more than one job at a time'],
      guidance: ['docs/skills/resources.md'],
      createdAt: '2026-09-20T09:40:00.000Z',
      updatedAt: '2026-09-20T09:40:00.000Z',
    }],
    dispatches: [{
      issueNumber: 1,
      targetId: 'legacy-target',
      rationale: 'the only target',
      recordedAt: '2026-09-20T09:50:00.000Z',
    }],
  });

  // The feed: every issue event, plus the deleted issue's two comments, whose
  // entries carry a `commentRef` into a page that the old model wrote. The deleted
  // issue's comment pages exist in the store but nothing else points at them, so
  // resolving those entries is exactly what the import must do.
  const deletedRef = put(`comments:${LEGACY_FIXTURE.deletedIssue.number}:${head}:000000001`, {
    schemaVersion: 2,
    boardId: BOARD_ID,
    number: LEGACY_FIXTURE.deletedIssue.number,
    page: 1,
    revision: 7,
    messages: [0, 1].map((index) => comment(
      9000 + index,
      LEGACY_FIXTURE.deletedIssue.number,
      1000 + index,
    )),
  });

  const feedEntries = [];
  let position = 0;
  for (const summary of LEGACY_FIXTURE.issues) {
    feedEntries.push({
      id: `sha256:ev${String(position).padStart(41, '0')}`,
      kind: 'issue-created',
      at: '2026-09-20T09:00:00.000Z',
      position,
      issueNumber: summary.number,
      title: `Issue ${summary.number}`,
      state: 'open',
      messageId: null,
      author: null,
      body: null,
    });
    position += 1;
    const refs = commentRefsByIssue.get(summary.number);
    for (let index = 0; index < summary.messages; index += 1) {
      feedEntries.push({
        id: messageIdIndex(index),
        kind: 'comment-added',
        at: timestamp(index + 1),
        position,
        issueNumber: summary.number,
        title: `Issue ${summary.number}`,
        state: summary.state,
        messageId: messageIdIndex(index),
        // The pre-cutover form: a reference into the comment page.
        commentRef: refs[Math.floor(index / V3_COMMENT_PAGE_SIZE)],
      });
      position += 1;
    }
  }
  for (let index = 0; index < LEGACY_FIXTURE.deletedIssue.messages; index += 1) {
    feedEntries.push({
      id: `sha256:ev${String(position).padStart(41, '0')}`,
      kind: 'comment-added',
      at: timestamp(1000 + index),
      position,
      issueNumber: LEGACY_FIXTURE.deletedIssue.number,
      title: `Issue ${LEGACY_FIXTURE.deletedIssue.number}`,
      state: 'open',
      messageId: messageIdIndex(9000 + index),
      commentRef: deletedRef,
    });
    position += 1;
  }
  // Pad to the declared length so feed paging and cursor ordering are exercised.
  while (feedEntries.length < LEGACY_FIXTURE.feedEntries) {
    feedEntries.push({
      id: `sha256:ev${String(position).padStart(41, '0')}`,
      kind: 'issue-edited',
      at: timestamp(2000),
      position,
      issueNumber: 1,
      title: 'Issue 1',
      state: 'open',
      messageId: null,
      author: null,
      body: null,
    });
    position += 1;
  }

  const feedPageRefs = [];
  for (let index = 0; index * V3_FEED_PAGE_SIZE < feedEntries.length; index += 1) {
    const key = `feed:${head}:${String(index + 1).padStart(9, '0')}`;
    put(key, {
      schemaVersion: 2,
      boardId: BOARD_ID,
      page: index + 1,
      revision: 7,
      entries: feedEntries.slice(index * V3_FEED_PAGE_SIZE, (index + 1) * V3_FEED_PAGE_SIZE),
    });
    feedPageRefs.push(key);
  }

  const metaRef = put(`meta:${head}`, {
    schemaVersion: 2,
    boardId: BOARD_ID,
    rootKeyId: ROOT_KEY_ID,
    head,
    revision: 7,
    updatedAt: timestamp(2000),
    migratedFrom: null,
    nextIssueNumber: 6,
    issueCount: LEGACY_FIXTURE.issues.length,
    openIssueCount: LEGACY_FIXTURE.issues.filter((issue) => issue.state === 'open').length,
    closedIssueCount: LEGACY_FIXTURE.issues.filter((issue) => issue.state === 'closed').length,
    directoryRefs,
    openPageRefs,
    closedPageRefs,
    queueRef,
    catalogRef,
    feedPageRefs,
    feedCount: feedEntries.length,
    deleted: false,
  });

  objects.set('board-v2', {
    value: {
      schemaVersion: 3,
      // The pre-cutover pointer format. A pointer carrying the current format is
      // served; this one is an import source.
      format: 'materialized-snapshots',
      boardId: BOARD_ID,
      rootKeyId: ROOT_KEY_ID,
      head,
      revision: 7,
      metaRef,
    },
    mode: 'capability-write',
    capability: null,
    revision: 1,
  });

  return {
    objects,
    head,
    metaRef,
    feedEntryCount: feedEntries.length,
    /** The comment ids the deleted issue's feed entries name, for assertions. */
    deletedIssueMessageIds: [0, 1].map((index) => messageIdIndex(9000 + index)),
    keys: {
      directory: directoryRefs.map(keyOf),
      openPages: openPageRefs.map(keyOf),
      closedPages: closedPageRefs.map(keyOf),
      queue: keyOf(queueRef),
      catalog: keyOf(catalogRef),
      feedPages: feedPageRefs.map(keyOf),
      meta: keyOf(metaRef),
      issues: [...issueRefs.entries()].map(([number, ref]) => [number, keyOf(ref)]),
    },
  };
}

function messageIdIndex(index) {
  return `sha256:${String(index).padStart(43, '0')}`;
}

/**
 * The storage key for a logical ref, the way the store derives it.
 *
 * The store hashes `capability + ':' + ref` and prefixes `board-v3-`, so a
 * fixture built this way is readable by a real store and not only by a test that
 * knows the fixture's internals.
 */
export function locate(capability, ref) {
  const digest = createHash('sha256')
    .update(capability + ':' + ref)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'board-v3-' + digest;
}
