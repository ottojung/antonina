/**
 * The migration gate.
 *
 * Persisted Antonina state is a signed operation log, and the one versioned
 * object inside it is the board carried by the first operation's payload. Every
 * path that turns persisted state into a usable board goes through here, so a
 * caller cannot forget to migrate: there is one function that opens a board, it
 * runs this gate, and there is no exported shortcut around it.
 *
 * ## The trust-preserving mechanism, chosen once and explicitly
 *
 * A board format transition takes the first of these two mechanisms, and this
 * build uses the first for v2 -> v3:
 *
 * 1. **Verify the legacy signed representation exactly as persisted, then lift
 *    it into the current in-memory representation.** The migration is a
 *    replay-time projection. The stored log keeps its v2 `board.initialize`
 *    payload and its signature forever; the migrated board exists only inside
 *    this process.
 * 2. **Append an explicitly signed migration/checkpoint operation.** This is
 *    for the case where the *persisted* bytes themselves must change, and it
 *    costs a signer: a checkpoint is an operation like any other, so it can
 *    only be written by a key holding the capability that authorizes it.
 *
 * v2 -> v3 needs no checkpoint, and adding one would be strictly worse. The
 * transition adds two collections (`targets`, `dispatches`) that the old format
 * did not have, so every old board lifts to the same value: the v2 board with
 * two empty collections. There is no operator decision, no timestamp, and no
 * re-signing to record, so there is nothing for a checkpoint operation to say.
 * It would also make migration require a *write*, which is exactly what an
 * ordinary board open must not do, and would break read-only opens.
 *
 * The rule that makes this safe is: **the migration is never allowed to feed
 * back into what is verified or what is stored.** A migration may only produce
 * the current in-memory board. It may not rewrite a payload, so a signature
 * that covered the legacy bytes still covers exactly the bytes it signed, and
 * tampering with legacy signed state stays a signature failure rather than
 * becoming a silently accepted rewrite.
 */
import {
  BOARD_SCHEMA_VERSION,
  LEGACY_BOARD_SCHEMA_VERSION,
  PERSISTED_BOARD_VERSIONS,
  parseBoard,
  parseLegacyBoardV2,
  type Board,
  type LegacyBoardV2,
  type PersistedBoardVersion,
} from './model.js';

export type { PersistedBoardVersion } from './model.js';

/**
 * The persisted format this build writes. It is the version the gate migrates
 * everything to, and the only one that needs no migration.
 */
export const CURRENT_PERSISTED_BOARD_VERSION = BOARD_SCHEMA_VERSION;

/**
 * Every persisted board version this build can read, oldest first.
 *
 * This is not a second list: it is {@link PERSISTED_BOARD_VERSIONS} under the
 * name this module has always published, re-exported so existing consumers and
 * this module's own refusals read the one declaration in `model.ts`. That
 * declaration is also the key set of the parser table `parsePersistedBoard`
 * dispatches on, so declaring a readable version here cannot outrun the ability
 * to read it.
 */
export const SUPPORTED_PERSISTED_BOARD_VERSIONS = PERSISTED_BOARD_VERSIONS;

/** A supported version that is not the current one, and therefore needs a migration. */
export type SupersededPersistedBoardVersion = Exclude<
  PersistedBoardVersion,
  typeof CURRENT_PERSISTED_BOARD_VERSION
>;

/**
 * One registered step of a migration chain, from one persisted version to
 * another. A step reads the old representation exactly as persisted and returns
 * the next representation; it must not validate away the old bytes, because the
 * bytes it is given are the ones a signature covers.
 */
export interface PersistedBoardMigration {
  readonly from: SupersededPersistedBoardVersion;
  readonly to: PersistedBoardVersion;
  /** What this step adds or renames, for an operator reading a failure. */
  readonly summary: string;
  migrate(value: unknown): unknown;
}

/**
 * The registry of migrations. The type is a mapped type over every superseded
 * supported version, so declaring a version in
 * {@link SUPPORTED_PERSISTED_BOARD_VERSIONS} without registering its migration
 * is a typecheck failure rather than a runtime surprise: a version bump cannot
 * merge with no way to read what the previous release wrote.
 *
 * The registry is the only dispatch of *migration steps*: {@link migrationFrom}
 * is the single place a superseded version is turned into a step, and it reads
 * this map. A second, hand-written branch over version constants here would
 * leave the mapped type checking a table the gate never consults, which is how
 * a registered v3 migration could be refused at runtime on a green build.
 *
 * It is not the only place a version is recognised, and this comment does not
 * claim it is. `parsePersistedBoard` in `model.ts` dispatches on the same
 * declared list, over the parser table keyed by it, and that dispatch is a
 * mapped type as well. The two obligations are the same declaration read twice:
 * a version cannot be added to {@link PERSISTED_BOARD_VERSIONS} without both a
 * parser to read it and, if it is superseded, a step to migrate it. What would
 * break that is a version branch written against a constant *outside* that list
 * — a hand-written `if (schemaVersion === SOME_CONSTANT)` in either module,
 * which no mapped type can see.
 */
const PERSISTED_BOARD_MIGRATIONS: { [V in SupersededPersistedBoardVersion]: PersistedBoardMigration } = {
  [LEGACY_BOARD_SCHEMA_VERSION]: {
    from: LEGACY_BOARD_SCHEMA_VERSION,
    to: BOARD_SCHEMA_VERSION,
    summary: 'adds the execution-target catalog and the dispatch records v3 introduced, both empty',
    /**
     * The whole of the v2 -> v3 transition: the v2 board with the two
     * collections v3 added. Every v2 board lifts to the same value, which is
     * why no operator decision and therefore no signed checkpoint is involved.
     * The v2 fields are carried over untouched and unreordered.
     */
    migrate(value: unknown): Record<string, unknown> {
      const legacy = parseLegacyBoardV2(value);
      return { ...legacy, schemaVersion: BOARD_SCHEMA_VERSION, targets: [], dispatches: [] };
    },
  },
};

export class PersistedBoardMigrationError extends Error {
  /** The persisted version the gate was reading, when it could be read at all. */
  readonly persistedVersion: number | null;

  constructor(message: string, persistedVersion: number | null = null) {
    super(message);
    this.persistedVersion = persistedVersion;
  }
}

/** The stored board was written by a newer Antonina than this one. */
export class UnsupportedPersistedBoardVersionError extends PersistedBoardMigrationError {
  constructor(persistedVersion: number) {
    super(
      `Antonina cannot open a board persisted at format version ${persistedVersion}: `
        + `this build reads ${SUPPORTED_PERSISTED_BOARD_VERSIONS.join(', ')} `
        + `and writes version ${CURRENT_PERSISTED_BOARD_VERSION}. Upgrade Antonina; the board is untouched.`,
      persistedVersion,
    );
  }
}

/** The stored board is older than this build, and no registered migration reaches the current version. */
export class NoPersistedBoardMigrationPathError extends PersistedBoardMigrationError {
  constructor(persistedVersion: number) {
    super(
      `Antonina has no migration from persisted board format version ${persistedVersion} `
        + `to version ${CURRENT_PERSISTED_BOARD_VERSION}; refusing to open the board rather than `
        + 'exposing state this build cannot vouch for. The board is untouched.',
      persistedVersion,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A version this build reads that is not the one it writes, and therefore has
 * a registered step. This is the same test as the one
 * {@link everySupersededVersionHasAMigration} applies, narrowed so the
 * registry can be indexed by it.
 */
function isSupersededPersistedBoardVersion(version: number): version is SupersededPersistedBoardVersion {
  return version !== CURRENT_PERSISTED_BOARD_VERSION
    && (SUPPORTED_PERSISTED_BOARD_VERSIONS as readonly number[]).includes(version);
}

/**
 * The registered step out of `version`, or `undefined` when the version is
 * neither current nor a key of the registry. The registry is the dispatch, so
 * registering a step is what makes the gate use it.
 */
function migrationFrom(version: number): PersistedBoardMigration | undefined {
  if (!isSupersededPersistedBoardVersion(version)) return undefined;
  return PERSISTED_BOARD_MIGRATIONS[version];
}

/**
 * Every migration step from `from` to {@link CURRENT_PERSISTED_BOARD_VERSION},
 * in order, or a refusal. An empty chain means the stored board is already
 * current. The walk is bounded by the number of registered steps, so a registry
 * with a cycle fails loudly instead of hanging.
 */
export function persistedBoardMigrationChain(from: number): PersistedBoardMigration[] {
  if (!Number.isSafeInteger(from)) {
    throw new PersistedBoardMigrationError(
      `Persisted board format version ${String(from)} is not a version Antonina can read`,
    );
  }
  if (from > CURRENT_PERSISTED_BOARD_VERSION) {
    throw new UnsupportedPersistedBoardVersionError(from);
  }
  const chain: PersistedBoardMigration[] = [];
  const visited = new Set<number>([from]);
  let version = from;
  while (version !== CURRENT_PERSISTED_BOARD_VERSION) {
    const migration = migrationFrom(version);
    if (!migration) throw new NoPersistedBoardMigrationPathError(from);
    if (visited.has(migration.to)) {
      throw new PersistedBoardMigrationError(
        `The registered migration chain for board format version ${from} is cyclic`,
        from,
      );
    }
    visited.add(migration.to);
    chain.push(migration);
    version = migration.to;
  }
  if (chain.length > Object.keys(PERSISTED_BOARD_MIGRATIONS).length) {
    throw new PersistedBoardMigrationError('The registered board migration registry is inconsistent', from);
  }
  return chain;
}

/** The `schemaVersion` of a board-shaped value, or `null` when it carries none. */
export function persistedBoardVersionOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return typeof value.schemaVersion === 'number' ? value.schemaVersion : null;
}

/**
 * The persisted board version of a stored operation log, read without parsing
 * the log, or `null` when the log does not declare one.
 *
 * This exists so the gate can refuse an unreadable or too-new board *before*
 * anything parses the log for detail. A log that declares no version at all is
 * malformed rather than migrated, and is left to the parser to explain.
 */
export function persistedBoardVersionInLog(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.operations) || value.operations.length === 0) return null;
  const first = value.operations[0];
  if (!isRecord(first) || !isRecord(first.payload)) return null;
  return persistedBoardVersionOf(first.payload.board);
}

export interface MigratedPersistedBoard {
  /** The current in-memory board. The legacy bytes it came from are untouched. */
  board: Board;
  /** The version the board was stored at, which is the current one when no migration ran. */
  fromVersion: number;
  /** The versions the chain stepped through, in order. Empty when already current. */
  throughVersions: number[];
  /** One line per applied step, for a caller that wants to report what happened. */
  summary: string[];
}

/**
 * The gate every board open runs: read the stored version, select the migration
 * chain automatically, apply it, and validate the result as a current board.
 *
 * Deterministic and safe to repeat. An already-current board is not migrated
 * and not changed, and a board that cannot be migrated throws without producing
 * a board, so a failure can never be mistaken for a migrated one. Nothing here
 * writes: the returned board is a projection of persisted state, and the
 * persisted log still holds the version it was written at.
 */
export function migratePersistedBoard(value: unknown): MigratedPersistedBoard {
  const fromVersion = persistedBoardVersionOf(value);
  if (fromVersion === null) {
    throw new PersistedBoardMigrationError('Persisted board carries no format version to migrate from');
  }
  const chain = persistedBoardMigrationChain(fromVersion);
  let current: unknown = value;
  for (const migration of chain) current = migration.migrate(current);
  return {
    board: parseBoard(current),
    fromVersion,
    throughVersions: chain.map((migration) => migration.to),
    summary: chain.map((migration) => `${migration.from} -> ${migration.to}: ${migration.summary}`),
  };
}

/**
 * The gate's pre-parse half: refuse a stored board this build has no way to
 * open before any parsing work happens, so the failure names the version rather
 * than a parse symptom.
 *
 * Returns the stored version when one is declared, and `null` when the log
 * declares none, which leaves the malformed-shape reporting to the parser.
 */
export function requirePersistedBoardCompatibility(log: unknown): number | null {
  const version = persistedBoardVersionInLog(log);
  if (version === null) return null;
  persistedBoardMigrationChain(version);
  return version;
}

/**
 * Every supported version except the current one has a registered migration.
 * The mapped type above makes this a typecheck obligation; this is the runtime
 * half, and it is what a test asserts, so a registry edited to be incomplete
 * cannot pass unnoticed.
 *
 * The comparison is over the registry's *keys*, not over the `from` each entry
 * restates, so an entry whose `from` contradicts its own key cannot make an
 * unregistered version look covered.
 */
export function everySupersededVersionHasAMigration(): boolean {
  const superseded = SUPPORTED_PERSISTED_BOARD_VERSIONS
    .filter((version) => isSupersededPersistedBoardVersion(version))
    .slice()
    .sort((left, right) => left - right);
  const registered = Object.keys(PERSISTED_BOARD_MIGRATIONS)
    .map(Number)
    .sort((left, right) => left - right);
  return superseded.length === registered.length
    && superseded.every((version, index) => version === registered[index]);
}
