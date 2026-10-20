/**
 * Shared entity-id generator (board issue 320).
 *
 * An entity id is two independently drawn parts joined by a hyphen:
 *
 *   - a 22-character random suffix drawn uniformly from the 62-character
 *     alphabet `[0-9A-Za-z]`, which carries the entropy; and
 *   - one word drawn uniformly from a curated list of short, common, easy to
 *     pronounce English words, which exists only so a human can tell two ids
 *     apart at a glance.
 *
 * The word is never the whole id, and an id is never looked up by its word
 * alone: two ids can share a word and remain distinct, and the random suffix is
 * always present. That is what "no word-only lookups" means here -- the word is
 * a readability aid, not an identifier.
 *
 * ## Randomness
 *
 * Bytes come from `globalThis.crypto.getRandomValues`, which is the platform's
 * cryptographically secure generator in Node (>= 19) and in browsers alike, so
 * this module stays importable from `packages/core` by both the CLI and the web
 * app. Each character and the word are selected by rejection sampling against
 * the largest multiple of the alphabet size that fits in a byte, so no symbol
 * is over- or under-represented by more than the generator's own error. The
 * function keeps no module-level state and each call draws fresh bytes, so two
 * calls cannot influence one another.
 *
 * ## Compatibility
 *
 * This generator only ever mints new ids. The legacy managed-agent id space --
 * lowercase hexadecimal -- is a different shape and is not produced here; it is
 * recognised by the agent runtime's id normalizer, which accepts both shapes so
 * that existing agent records keep working. See
 * `packages/agent-runtime/src/process.ts`.
 */

const RANDOM_LENGTH = 22;

/**
 * 10 digits, 26 uppercase and 26 lowercase: 62 symbols.
 * The hyphen appears only once as the separator before the word.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Short, common, easy-to-pronounce English words, curated in Antonina rather
 * than imported from any dictionary package. Every entry is a single lowercase
 * word with no ambiguous spelling, so it survives being read aloud and retyped.
 */
const WORDS: readonly string[] = [
  'acorn', 'amber', 'anchor', 'apple', 'archer', 'autumn', 'badger', 'baker',
  'balloon', 'banjo', 'barley', 'basket', 'beacon', 'beaver', 'bishop', 'bottle',
  'branch', 'breeze', 'bridge', 'bronze', 'bubble', 'bucket', 'burger', 'button',
  'cabin', 'cactus', 'camel', 'camera', 'candle', 'canyon', 'carbon', 'carpet',
  'castle', 'cedar', 'cherry', 'circle', 'citrus', 'clover', 'cobalt', 'coffee',
  'comet', 'copper', 'coral', 'cotton', 'cricket', 'crystal', 'daisy', 'dancer',
  'denim', 'desert', 'diamond', 'dolphin', 'donkey', 'dragon', 'eagle', 'ember',
  'engine', 'falcon', 'feather', 'fiddle', 'firefly', 'flint', 'forest', 'fossil',
  'fountain', 'galaxy', 'garden', 'gentle', 'ginger', 'glacier', 'granite', 'grape',
  'gravel', 'guitar', 'hammer', 'harbor', 'harvest', 'hazel', 'helmet', 'heron',
  'honey', 'hunter', 'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jungle',
  'kernel', 'kettle', 'kitten', 'ladder', 'lantern', 'lemon', 'lilac', 'linen',
  'lion', 'lizard', 'lobster', 'lotus', 'magnet', 'mango', 'maple', 'marble',
  'meadow', 'melon', 'mermaid', 'meteor', 'mirror', 'monkey', 'mountain', 'muffin',
  'mustard', 'nebula', 'nickel', 'noodle', 'oasis', 'ocean', 'olive', 'onion',
  'orange', 'orchid', 'otter', 'oyster', 'paddle', 'palace', 'panda', 'panther',
  'papaya', 'parrot', 'pebble', 'pelican', 'pepper', 'phoenix', 'piano', 'pigeon',
  'pillow', 'pilot', 'planet', 'plum', 'pocket', 'polar', 'poppy', 'prairie',
  'pretzel', 'pumpkin', 'purple', 'quartz', 'quiver', 'rabbit', 'radar', 'rainbow',
  'ranger', 'raven', 'ribbon', 'river', 'robin', 'rocket', 'rooster', 'rubber',
  'ruby', 'sailor', 'salmon', 'sapphire', 'scarlet', 'shadow', 'shark', 'shelter',
  'silver', 'skipper', 'socket', 'sparrow', 'spider', 'spiral', 'sponge', 'spring',
  'sprout', 'squirrel', 'stable', 'station', 'statue', 'stellar', 'stone', 'storm',
  'stream', 'summit', 'sunset', 'swallow', 'table', 'talon', 'temple', 'thunder',
  'tiger', 'timber', 'toffee', 'tomato', 'topaz', 'tortoise', 'trail', 'tulip',
  'tundra', 'turtle', 'umbrella', 'valley', 'velvet', 'violet', 'violin', 'walnut',
  'walrus', 'warden', 'whale', 'wheat', 'willow', 'window', 'winter', 'wizard',
  'wombat', 'wonder', 'yellow', 'zebra', 'zephyr',
];

/**
 * A source of uniformly random bytes, batched so a whole id costs one
 * `getRandomValues` call rather than one per symbol. Created per call and never
 * shared, so there is no global state and no cross-call correlation.
 */
function byteSource(): () => number {
  let buffer = new Uint8Array(0);
  let cursor = 0;
  return () => {
    if (cursor >= buffer.length) {
      buffer = new Uint8Array(64);
      globalThis.crypto.getRandomValues(buffer);
      cursor = 0;
    }
    return buffer[cursor++]!;
  };
}

/**
 * A uniformly distributed index in `[0, bound)` from a byte source.
 *
 * Rejection sampling: bytes at or above `256 - (256 % bound)` are discarded, so
 * every accepted byte maps to exactly `floor(256 / bound)` indices. The result
 * is bias-free up to the generator's own quality, not merely "close enough".
 */
function pickIndex(next: () => number, bound: number): number {
  const limit = 256 - (256 % bound);
  for (;;) {
    const byte = next();
    if (byte < limit) return byte % bound;
  }
}

/**
 * A fresh entity id. Draws the 22-character random suffix and the word from
 * independent byte draws; keeps no state between calls.
 */
export function newEntityId(): string {
  const next = byteSource();
  let suffix = '';
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    suffix += ALPHABET[pickIndex(next, ALPHABET.length)]!;
  }
  return `${suffix}-${WORDS[pickIndex(next, WORDS.length)]!}`;
}

/**
 * Whether a value is exactly one generated entity id: a 22-character suffix
 * over the id alphabet, a hyphen, and a lowercase word. Structural rather than
 * dictionary-checked so a word retired from {@link WORDS} later still validates
 * the ids that were minted while it was in use.
 *
 * This is the new id space only. Legacy hexadecimal managed-agent ids are
 * deliberately not accepted here -- the agent runtime's normalizer is the one
 * place that recognises both shapes.
 */
const ENTITY_ID = new RegExp(`^[0-9A-Za-z]{${RANDOM_LENGTH}}-[a-z]+$`);

export function isEntityId(value: unknown): boolean {
  return typeof value === 'string' && ENTITY_ID.test(value);
}

/** Alias used by board stores when validating newly generated opaque IDs. */
export const isOpaqueEntityId = isEntityId;
