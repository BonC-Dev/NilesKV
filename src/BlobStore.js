import { createHash } from 'crypto';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';

/**
 * Thrown when a requested blob hash does not exist in the object store.
 */
export class BlobNotFoundError extends Error {
  /**
   * @param {string} hash - The SHA-256 hash that was not found.
   */
  constructor(hash) {
    super(`Blob not found: ${hash}`);
    this.name = 'BlobNotFoundError';
    this.hash = hash;
  }
}

/**
 * Recursively sorts an object's keys alphabetically at all nesting depths,
 * producing a deterministic structure regardless of insertion order.
 *
 * @param {unknown} value - The value to normalize.
 * @returns {unknown} The normalized value with sorted keys.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Content-Addressable Storage layer for JSON objects.
 *
 * Objects are serialized deterministically (sorted keys), hashed with SHA-256,
 * and persisted to `.db/objects/<hash>`. Identical objects always map to the
 * same file on disk — no duplicate storage, no hash collisions for equal data.
 *
 * @example
 * const store = new BlobStore('/project/.db');
 * await store.init();
 * const hash = await store.save({ z: 1, a: 2 });
 * const obj  = await store.read(hash);
 */
export class BlobStore {
  /**
   * @param {string} [dbRoot='.db'] - Path to the root database directory.
   */
  constructor(dbRoot = '.db') {
    this.dbRoot = dbRoot;
    this.objectsDir = join(dbRoot, 'objects');
  }

  /**
   * Ensures the `.db/objects` directory hierarchy exists.
   * Safe to call multiple times (idempotent).
   *
   * @returns {Promise<void>}
   */
  async init() {
    await mkdir(this.objectsDir, { recursive: true });
  }

  /**
   * Deterministically serializes `data`, computes its SHA-256 hash, writes the
   * blob to disk (if not already present), and returns the hash.
   *
   * Keys are sorted alphabetically at every nesting level so that logically
   * identical objects always produce the same hash regardless of insertion order.
   *
   * @param {object} data - A JSON-serializable object to persist.
   * @returns {Promise<string>} The SHA-256 hex digest that identifies this blob.
   * @throws {TypeError} If `data` is not a plain object or array.
   */
  /**
   * Computes the SHA-256 hash for `data` using the same deterministic
   * serialisation as `save()`, without performing any disk I/O.
   *
   * Useful for comparing in-memory document state against committed blob
   * hashes (e.g., in a diff/status operation) without writing to disk.
   *
   * @param {object} data - A JSON-serializable object or array.
   * @returns {string} 64-character SHA-256 hex digest.
   * @throws {TypeError} If `data` is not a non-null object or array.
   */
  computeHash(data) {
    if (data === null || typeof data !== 'object') {
      throw new TypeError('BlobStore.computeHash: data must be a non-null object or array');
    }
    const normalized = sortKeysDeep(data);
    const serialized = JSON.stringify(normalized);
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  async save(data) {
    if (data === null || typeof data !== 'object') {
      throw new TypeError('BlobStore.save: data must be a non-null object or array');
    }

    const normalized = sortKeysDeep(data);
    const serialized = JSON.stringify(normalized);
    const hash = createHash('sha256').update(serialized, 'utf8').digest('hex');
    const filePath = join(this.objectsDir, hash);

    // Only write if the blob does not already exist — avoids redundant I/O and
    // preserves the immutability guarantee of content-addressable storage.
    const exists = await access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      await writeFile(filePath, serialized, 'utf8');
    }

    return hash;
  }

  /**
   * Reads and parses the blob identified by `hash`.
   *
   * @param {string} hash - The SHA-256 hex digest of the blob to retrieve.
   * @returns {Promise<object>} The deserialized JSON object stored at `hash`.
   * @throws {BlobNotFoundError} If no blob exists for the given hash.
   * @throws {SyntaxError} If the stored file contains invalid JSON (indicates
   *   store corruption — should never occur under normal operation).
   */
  async read(hash) {
    if (typeof hash !== 'string' || hash.length !== 64) {
      throw new TypeError(`BlobStore.read: hash must be a 64-character hex string, got: ${JSON.stringify(hash)}`);
    }

    const filePath = join(this.objectsDir, hash);

    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new BlobNotFoundError(hash);
      }
      throw err;
    }

    return JSON.parse(raw);
  }
}
