/**
 * Deterministic stand-in embedding for the test `RecordingAi` stub ONLY (`tests/mocks/bindings.ts`).
 *
 * Why it exists: the test stub must answer vectors without a platform, and needs these properties
 * from a fake vector:
 *
 * - pure and synchronous — the same text always yields the same vector, in every test;
 * - `EMBEDDING_DIM` wide and L2-normalised, so it fits `chunks.embedding vector(1024)` and cosine
 *   distance (`<=>`) is well defined;
 * - NEVER the zero vector — `<=>` on a zero vector is NaN and poisons every ranking it touches.
 *
 * The shape is a hashed bag of words (each lower-cased alphanumeric token hashed to a bucket and a
 * sign): passages sharing words with a query rank closest — but ONLY when the query is embedded
 * the same way, which is the case in tests. It is not a semantic embedding and must never be mixed
 * with real ones.
 */
import { EMBEDDING_DIM } from '@launch/shared/ai/config'

export const DETERMINISTIC_EMBEDDING_MODEL = 'seed:deterministic'

/** FNV-1a over UTF-16 code units, 32-bit. Enough spread for bucketing; not cryptographic. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The unit vector for `text`. Identical texts → identical vectors; texts sharing words → a smaller
 * cosine distance; empty or symbol-only text → a single non-zero component derived from the raw
 * string, so the result is a unit vector in every case.
 */
export function deterministicEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0)
  for (const token of tokens(text)) {
    const hash = fnv1a(token)
    const bucket = hash % dim
    const sign = (hash >>> 31) & 1 ? -1 : 1
    vector[bucket] = (vector[bucket] ?? 0) + sign
  }
  let norm = 0
  for (const v of vector) norm += v * v
  if (norm === 0) {
    vector[fnv1a(text, 0x9747b28c) % dim] = 1
    return vector
  }
  const scale = 1 / Math.sqrt(norm)
  return vector.map(v => v * scale)
}
