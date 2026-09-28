/**
 * Why a persisted board could not be read, as data rather than as a sentence.
 *
 * The generic message this replaces could not be acted on. During the
 * 0.1.0 -> 0.1.1 rollout a schemaVersion 2 board met a build that expected 3,
 * and both the browser and the CLI said only that the board was "incompatible
 * or malformed", which names neither the version found nor the version
 * expected nor the field at fault. An operator needs to be told which of these
 * materially different failures happened.
 *
 * Two properties hold for everything this module produces, and both are load
 * bearing rather than stylistic.
 *
 * **It never makes a reader more permissive.** `describeBoardDefect` only ever
 * *explains* a board that a predicate has already refused. The predicates in
 * `model.ts` remain the sole authority on what is acceptable, so adding
 * diagnostics cannot admit an input that was rejected before.
 *
 * **It never prints a payload.** A board is operator- and repository-derived
 * data that can carry a credential that was wrongly written into it, so a
 * diagnostic describes the *shape* of what it found — its type, its key names,
 * an index — and not its contents. The single value that ever appears is
 * `schemaVersion`, and `readSchemaVersion` only echoes it when it is a small
 * non-negative integer or a short opaque token; anything else is reported as
 * `a value that is not a schema version`.
 */

/**
 * The materially distinct ways a board can be unreadable, kept apart so a
 * caller can act on the kind rather than pattern-match on prose.
 *
 * - `not-a-record`: the value is not a JSON object at all (a string, a number,
 *   `null`, an array, a truncated file).
 * - `schema-version-mismatch`: a well-formed object carrying a schemaVersion
 *   other than the one this build reads. This is the rollout incident, and it
 *   is distinct from corrupt data: the board is not broken, this reader is
 *   older or newer than the board.
 * - `key-set`: a record with the wrong top-level keys — one missing, one extra,
 *   or both. A board written by another build shows up here when the extra keys
 *   arrive before the version does.
 * - `field`: a top-level field is present but malformed.
 * - `element`: a record nested inside an array is malformed. Carries the index
 *   so the offending record can be found without reading the whole board.
 * - `corrupt`: the individual records are each well formed but disagree with
 *   each other — a duplicated identity, a counter that contradicts its issues,
 *   a dispatch naming an unregistered target.
 */
export type BoardDefectKind =
  | 'not-a-record'
  | 'schema-version-mismatch'
  | 'key-set'
  | 'field'
  | 'element'
  | 'corrupt';

export interface BoardDefect {
  readonly kind: BoardDefectKind;
  /** Which object the defect is in: `board`, `board.issues`, `board.targets`. */
  readonly subject: string;
  /** The field at fault, or `''` for a defect in the object as a whole. */
  readonly field: string;
  /**
   * What was found, described rather than quoted. This is a type name, an array
   * length, or a bounded identifier — never a field's value.
   */
  readonly found: string;
  /** What the reader requires, in the same descriptive style as `found`. */
  readonly expected: string;
  /**
   * Which top-level keys were missing and which were unexpected, for
   * `key-set` defects. Key names are drawn from the schema, not from the
   * payload, except for the unexpected ones, which are bounded and redacted
   * by `readKeyName`.
   */
  readonly missingKeys: readonly string[];
  readonly unexpectedKeys: readonly string[];
  /**
   * A verdict this module does not phrase, for the cross-record failures whose
   * existing wording already reads precisely. The defect still carries its
   * `kind` and its `subject`/`field`, so a caller can classify one; the
   * sentence is not re-derived here.
   */
  readonly message?: string;
}

/**
 * The key-set half of a diagnostic: which required keys are absent and which
 * present keys are not permitted. Key names only, and the unexpected ones have
 * already been bounded and redacted by {@link readKeyName}.
 */
function keyParts(defect: BoardDefect): string {
  const parts: string[] = [];
  if (defect.missingKeys.length > 0) parts.push('missing ' + defect.missingKeys.join(', '));
  if (defect.unexpectedKeys.length > 0) {
    parts.push('unexpected ' + defect.unexpectedKeys.map((key) => `'${key}'`).join(', '));
  }
  return parts.join('; ');
}

function sentence(defect: BoardDefect): string {
  if (defect.message !== undefined) return defect.message;
  const where = defect.subject;
  switch (defect.kind) {
    case 'not-a-record':
      return `Antonina board is not a JSON object: found ${defect.found}, expected an object`;
    case 'schema-version-mismatch':
      return `Antonina board schema version is ${defect.found}, but this build reads schema version ${defect.expected}; `
        + 'the board was written by a different Antonina version than this one';
    case 'key-set':
      return `Antonina ${where} has the wrong keys (${keyParts(defect)}), `
        + `expected exactly ${defect.expected}`;
    case 'field':
    case 'element':
      // A nested record can fail on its key set rather than on one field, and
      // naming the offending key is the whole point, so that case is phrased
      // the same way whichever level the record sits at.
      if (defect.missingKeys.length > 0 || defect.unexpectedKeys.length > 0) {
        return `Antonina ${where} has the wrong keys (${keyParts(defect)}), `
          + `expected exactly ${defect.expected}`;
      }
      return defect.field === ''
        ? `Antonina ${where} is malformed: found ${defect.found}, expected ${defect.expected}`
        : `Antonina ${where} has a malformed field ${defect.field}: `
          + `found ${defect.found}, expected ${defect.expected}`;
    case 'corrupt':
      return `Antonina board is internally inconsistent: ${where} ${defect.found}`;
  }
}

/**
 * The error a board read throws. `message` is the whole diagnostic, because the
 * CLI prints `error.message` and the browser shows the same string: a caller
 * that never inspects the fields still names the failing field.
 */
export class BoardIncompatibilityError extends Error {
  readonly defect: BoardDefect;

  constructor(defect: BoardDefect, options?: { cause?: unknown }) {
    super(sentence(defect), options);
    this.name = 'BoardIncompatibilityError';
    this.defect = defect;
  }
}

export function isBoardIncompatibilityError(value: unknown): value is BoardIncompatibilityError {
  return value instanceof BoardIncompatibilityError;
}

/**
 * The name of a value's type, and nothing more. This is the whole of what a
 * malformed-field diagnostic is allowed to say about the value itself, so a
 * credential that ended up in the wrong field is described by its type and not
 * reproduced in a log, a terminal or a browser.
 */
export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'undefined': return 'no value';
    case 'string': return 'a string';
    case 'number': return 'a number';
    case 'boolean': return 'a boolean';
    case 'bigint': return 'a bigint';
    case 'symbol': return 'a symbol';
    case 'function': return 'a function';
    case 'object': return 'an object';
    default: return 'a value of another type';
  }
}

/**
 * The count of a collection, so "an array of 4 entries, 2 of which are not
 * objects" is reportable without listing the entries.
 */
export function describeArray(value: readonly unknown[], expected: string): string {
  return `an array of ${value.length} ${value.length === 1 ? 'entry' : 'entries'}, expected ${expected}`;
}

/**
 * A schemaVersion, echoed only when it is one this reader could plausibly have
 * written: a small non-negative integer, or a short opaque token. A
 * `schemaVersion` carrying a credential, a JSON document or a paragraph is
 * reported as an unnamed value instead.
 */
export function readSchemaVersion(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1_000_000) {
    return String(value);
  }
  if (typeof value === 'string' && value.length > 0 && value.length <= 32 && /^[A-Za-z0-9._-]+$/.test(value)) {
    return `'${value}'`;
  }
  return 'a value that is not a schema version';
}

/**
 * A key name is echoed only when it looks like an identifier this codebase
 * writes: letters, digits, underscore and dash, at most 64 characters, not
 * starting with a digit. Dots are excluded on purpose, so a credential-shaped
 * key — anything with `a.b.c` structure — is described instead of quoted. An
 * unexpected key arriving from an untrusted payload is a shape report, not a
 * quotation of the payload.
 */
const KEY_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const UNREADABLE_KEY_NAME = 'a key name that is not a plain identifier';
export function readKeyName(key: string): string {
  return KEY_NAME.test(key) ? key : UNREADABLE_KEY_NAME;
}

/** One named expectation, checked in the order the schema states it. */
export interface DefectCheck {
  readonly field: string;
  readonly expected: string;
  readonly ok: boolean;
  /** The value the check read, reported by type only when it fails. */
  readonly value?: unknown;
  /** Overrides the type report when the diagnosis knows better. */
  readonly found?: string | undefined;
}

/**
 * The first unmet check, or `null` when all of them hold.
 *
 * The checks are supplied in exactly the order the corresponding boolean
 * predicate evaluated them, so a defect names the first reason the reader
 * refused rather than a reason chosen after the fact.
 */
export function firstDefect(subject: string, checks: readonly DefectCheck[]): BoardDefect | null {
  for (const check of checks) {
    if (check.ok) continue;
    return {
      kind: 'field',
      subject,
      field: check.field,
      found: check.found ?? describeType(check.value),
      expected: check.expected,
      missingKeys: [],
      unexpectedKeys: [],
    };
  }
  return null;
}

export function fieldDefect(
  subject: string,
  field: string,
  value: unknown,
  expected: string,
  kind: 'field' | 'element' = 'field',
): BoardDefect {
  return {
    kind,
    subject,
    field,
    found: describeType(value),
    expected,
    missingKeys: [],
    unexpectedKeys: [],
  };
}

export function elementDefect(
  subject: string,
  field: string,
  index: number,
  found: string,
  expected: string,
): BoardDefect {
  return {
    kind: 'element',
    subject: `${subject}.${field}`,
    field: `index ${index}`,
    found,
    expected,
    missingKeys: [],
    unexpectedKeys: [],
  };
}

export function keySetDefect(
  subject: string,
  required: readonly string[],
  actual: Record<string, unknown>,
): BoardDefect {
  const missing = required.filter((key) => !Object.hasOwn(actual, key));
  const unexpected = Object.keys(actual).filter((key) => !required.includes(key));
  return {
    kind: 'key-set',
    subject,
    field: '',
    found: 'a different set of keys',
    expected: required.join(', '),
    missingKeys: missing,
    unexpectedKeys: unexpected.map(readKeyName),
  };
}

export function versionDefect(found: unknown, expected: number): BoardDefect {
  return {
    kind: 'schema-version-mismatch',
    subject: 'board',
    field: 'schemaVersion',
    found: readSchemaVersion(found),
    expected: String(expected),
    missingKeys: [],
    unexpectedKeys: [],
  };
}

/**
 * The defect reported when an element is refused but no named field explains
 * it. This is a deliberately uninformative fallback rather than a guess: it
 * names the collection and the index and nothing else, so a predicate that
 * learns a new condition it does not yet explain narrows the diagnostic to
 * "look here" instead of quoting a record it does not understand.
 */
export function unclassifiedElementDefect(subject: string, index: number): BoardDefect {
  return {
    kind: 'element',
    subject,
    field: `index ${index}`,
    found: 'a record this build does not accept, for a reason it does not name',
    expected: `a valid entry of ${subject}`,
    missingKeys: [],
    unexpectedKeys: [],
  };
}

export function notARecordDefect(subject: string, value: unknown): BoardDefect {
  return {
    kind: 'not-a-record',
    subject,
    field: '',
    found: describeType(value),
    expected: 'a JSON object',
    missingKeys: [],
    unexpectedKeys: [],
  };
}

/**
 * A cross-record inconsistency. The board is readable field by field and
 * incoherent as a whole, which is a different failure from a version mismatch
 * and is reported as its own kind rather than folded into "malformed".
 */
export function corruptDefect(
  subject: string,
  field: string,
  found: string,
  message: string,
): BoardDefect {
  return {
    kind: 'corrupt',
    subject,
    field,
    found,
    expected: '',
    missingKeys: [],
    unexpectedKeys: [],
    message,
  };
}
