import { BlobStore, BlobNotFoundError } from './BlobStore.js';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Helper: create an isolated BlobStore backed by a temp directory.
 * The returned `cleanup` function removes everything after the test.
 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'nileskv-test-'));
  const dbRoot = join(dir, '.db');
  const store = new BlobStore(dbRoot);
  await store.init();
  return {
    store,
    dbRoot,
    objectsDir: join(dbRoot, 'objects'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe('BlobStore.init()', () => {
  test('creates the .db/objects directory hierarchy', async () => {
    const { store, objectsDir, cleanup } = await makeStore();
    try {
      // If readdir doesn't throw, the directory exists.
      await expect(readdir(objectsDir)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test('is idempotent — calling init() twice does not throw', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await expect(store.init()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// save()
// ---------------------------------------------------------------------------

describe('BlobStore.save()', () => {
  test('returns a 64-character hex string (SHA-256)', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const hash = await store.save({ name: 'Alice', age: 30 });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await cleanup();
    }
  });

  test('writes exactly one file to the objects directory', async () => {
    const { store, objectsDir, cleanup } = await makeStore();
    try {
      const hash = await store.save({ foo: 'bar' });
      const files = await readdir(objectsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(hash);
    } finally {
      await cleanup();
    }
  });

  // The critical key-order invariant
  test('{"z":1,"a":2} and {"a":2,"z":1} produce the same hash', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const hashA = await store.save({ z: 1, a: 2 });
      const hashB = await store.save({ a: 2, z: 1 });
      expect(hashA).toBe(hashB);
    } finally {
      await cleanup();
    }
  });

  test('saving the same object twice does not duplicate files on disk', async () => {
    const { store, objectsDir, cleanup } = await makeStore();
    try {
      await store.save({ z: 1, a: 2 });
      await store.save({ a: 2, z: 1 });
      const files = await readdir(objectsDir);
      expect(files).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test('deeply nested objects with different key orders hash identically', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const objA = { outer: { z: 99, a: 1 }, id: 'x' };
      const objB = { id: 'x', outer: { a: 1, z: 99 } };
      const hashA = await store.save(objA);
      const hashB = await store.save(objB);
      expect(hashA).toBe(hashB);
    } finally {
      await cleanup();
    }
  });

  test('objects with different values produce different hashes', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const h1 = await store.save({ value: 1 });
      const h2 = await store.save({ value: 2 });
      expect(h1).not.toBe(h2);
    } finally {
      await cleanup();
    }
  });

  test('array values are preserved and order-sensitive', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const h1 = await store.save({ items: [1, 2, 3] });
      const h2 = await store.save({ items: [3, 2, 1] });
      expect(h1).not.toBe(h2);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError when passed a non-object primitive', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await expect(store.save('string')).rejects.toThrow(TypeError);
      await expect(store.save(42)).rejects.toThrow(TypeError);
      await expect(store.save(null)).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });

  test('multiple distinct objects each get their own file', async () => {
    const { store, objectsDir, cleanup } = await makeStore();
    try {
      await store.save({ a: 1 });
      await store.save({ b: 2 });
      await store.save({ c: 3 });
      const files = await readdir(objectsDir);
      expect(files).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe('BlobStore.read()', () => {
  test('returns the original object after a save/read round-trip', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const original = { name: 'Bob', score: 100, active: true };
      const hash = await store.save(original);
      const retrieved = await store.read(hash);
      // Keys will be in sorted order after normalization — compare values.
      expect(retrieved).toEqual(original);
    } finally {
      await cleanup();
    }
  });

  test('reading an object saved with unsorted keys reflects sorted storage', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const hash = await store.save({ z: 9, a: 1 });
      const retrieved = await store.read(hash);
      expect(Object.keys(retrieved)).toEqual(['a', 'z']);
    } finally {
      await cleanup();
    }
  });

  test('throws BlobNotFoundError for an unknown hash', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const fakeHash = 'a'.repeat(64);
      await expect(store.read(fakeHash)).rejects.toThrow(BlobNotFoundError);
    } finally {
      await cleanup();
    }
  });

  test('BlobNotFoundError carries the queried hash', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const fakeHash = 'b'.repeat(64);
      let caught;
      try {
        await store.read(fakeHash);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BlobNotFoundError);
      expect(caught.hash).toBe(fakeHash);
      expect(caught.name).toBe('BlobNotFoundError');
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for a hash that is not 64 hex chars', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await expect(store.read('tooshort')).rejects.toThrow(TypeError);
      await expect(store.read('')).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });

  test('read after two key-order variants returns the same data', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const h1 = await store.save({ z: 1, a: 2 });
      const h2 = await store.save({ a: 2, z: 1 });
      const result1 = await store.read(h1);
      const result2 = await store.read(h2);
      expect(result1).toEqual(result2);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// BlobNotFoundError
// ---------------------------------------------------------------------------

describe('BlobNotFoundError', () => {
  test('is an instance of Error', () => {
    const err = new BlobNotFoundError('abc');
    expect(err).toBeInstanceOf(Error);
  });

  test('message includes the hash', () => {
    const err = new BlobNotFoundError('deadbeef');
    expect(err.message).toContain('deadbeef');
  });
});
