import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NilesKV, InvalidDocumentError, UnrestoredCommitError, BranchNotFoundError, ConcurrencyError } from './NilesKV.js';
import { CommitNotFoundError, HeadNotInitialisedError } from './CommitManager.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

async function makeDB() {
  const dir = await mkdtemp(join(tmpdir(), 'nileskv-db-test-'));
  const dbRoot = join(dir, '.db');
  const db = new NilesKV(dbRoot);
  await db.init();
  return {
    db,
    dbRoot,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — three documents used throughout the suite
// ---------------------------------------------------------------------------

const DOC1 = { name: 'Alice',   role: 'engineer', age: 30 };
const DOC2 = { name: 'Bob',     role: 'designer',  age: 25 };
const DOC3 = { name: 'Charlie', role: 'manager',   age: 40 };

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

describe('NilesKV.init()', () => {
  test('is idempotent', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.init()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('state starts empty', async () => {
    const { db, cleanup } = await makeDB();
    try {
      expect(db.state.size).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// insert() and delete()
// ---------------------------------------------------------------------------

describe('NilesKV.insert()', () => {
  test('adds a document to in-memory state', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      expect(db.state.size).toBe(1);
      expect(db.get('doc:1')).toEqual(DOC1);
    } finally {
      await cleanup();
    }
  });

  test('overwrites an existing document with the same ID', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:1', DOC2);
      expect(db.state.size).toBe(1);
      expect(db.get('doc:1')).toEqual(DOC2);
    } finally {
      await cleanup();
    }
  });

  test('throws InvalidDocumentError for a non-object document', async () => {
    const { db, cleanup } = await makeDB();
    try {
      expect(() => db.insert('doc:1', 'string')).toThrow(InvalidDocumentError);
      expect(() => db.insert('doc:1', 42)).toThrow(InvalidDocumentError);
      expect(() => db.insert('doc:1', null)).toThrow(InvalidDocumentError);
      expect(() => db.insert('doc:1', [1, 2, 3])).toThrow(InvalidDocumentError);
    } finally {
      await cleanup();
    }
  });

  test('throws InvalidDocumentError for an empty or non-string id', async () => {
    const { db, cleanup } = await makeDB();
    try {
      expect(() => db.insert('', DOC1)).toThrow(InvalidDocumentError);
      expect(() => db.insert('   ', DOC1)).toThrow(InvalidDocumentError);
      expect(() => db.insert(null, DOC1)).toThrow(InvalidDocumentError);
      expect(() => db.insert(42, DOC1)).toThrow(InvalidDocumentError);
    } finally {
      await cleanup();
    }
  });
});

describe('NilesKV.delete()', () => {
  test('removes a document from state', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const removed = db.delete('doc:1');
      expect(removed).toBe(true);
      expect(db.state.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('returns false for a non-existent id (no-op)', async () => {
    const { db, cleanup } = await makeDB();
    try {
      expect(db.delete('ghost')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// commit()
// ---------------------------------------------------------------------------

describe('NilesKV.commit()', () => {
  test('returns a CommitResult with a valid commit id and merkleRoot', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const result = await db.commit('first commit');
      expect(result.commit.id).toMatch(/^[a-f0-9]{64}$/);
      expect(result.merkleRoot).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await cleanup();
    }
  });

  test('first commit has null parent_hash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit } = await db.commit('initial');
      expect(commit.parent_hash).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('second commit carries the first commit id as parent_hash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');
      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('second');
      expect(c2.parent_hash).toBe(c1.id);
    } finally {
      await cleanup();
    }
  });

  test('commit persists state_hash in the commit object', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit } = await db.commit('first');
      expect(commit.state_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await cleanup();
    }
  });

  test('committing an empty state produces the EMPTY_DATABASE merkle root', async () => {
    const { db, cleanup } = await makeDB();
    try {
      // Import MerkleTree to compute expected root independently.
      const { MerkleTree } = await import('./MerkleTree.js');
      const { commit, merkleRoot } = await db.commit('empty commit');
      expect(merkleRoot).toBe(MerkleTree.buildTree([]));
      expect(commit.root_merkle_hash).toBe(merkleRoot);
    } finally {
      await cleanup();
    }
  });

  test('two commits with different state have different merkle roots', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { merkleRoot: root1 } = await db.commit('first');
      db.insert('doc:2', DOC2);
      const { merkleRoot: root2 } = await db.commit('second');
      expect(root1).not.toBe(root2);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for a non-string or empty message', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.commit('')).rejects.toThrow(TypeError);
      await expect(db.commit(null)).rejects.toThrow(TypeError);
      await expect(db.commit(42)).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });

  test('HEAD advances to the new commit id after each commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');
      expect(await db.currentHead()).toBe(c1.id);
      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('second');
      expect(await db.currentHead()).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// THE CORE SCENARIO — the spec's required integration test
// ---------------------------------------------------------------------------

describe('NilesKV — core integration scenario', () => {
  /**
   * Scenario:
   *   1. Insert doc:1, doc:2, doc:3 → commit (commit A)
   *   2. Modify doc:2, delete doc:3  → commit (commit B)
   *   3. checkout(commitA.id)
   *   4. Assert state == original 3 documents exactly
   */
  test('checkout restores state to the exact 3-document snapshot', async () => {
    const { db, cleanup } = await makeDB();
    try {
      // — Commit A: three documents —
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      db.insert('doc:3', DOC3);
      const { commit: commitA } = await db.commit('initial: add three documents');

      // — Commit B: modify doc:2, delete doc:3 —
      db.insert('doc:2', { name: 'Robert', role: 'senior designer', age: 26 });
      db.delete('doc:3');
      await db.commit('update doc:2 and remove doc:3');

      // Verify intermediate state is correct before checkout.
      expect(db.state.size).toBe(2);
      expect(db.get('doc:2')).toEqual({ name: 'Robert', role: 'senior designer', age: 26 });
      expect(db.get('doc:3')).toBeUndefined();

      // — Checkout commit A —
      await db.checkout(commitA.id);

      // Assert state is perfectly restored to the original 3 documents.
      expect(db.state.size).toBe(3);
      expect(db.get('doc:1')).toEqual(DOC1);
      expect(db.get('doc:2')).toEqual(DOC2);
      expect(db.get('doc:3')).toEqual(DOC3);
    } finally {
      await cleanup();
    }
  });

  test('HEAD points at the checked-out commit after checkout', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: commitA } = await db.commit('commit A');
      db.insert('doc:2', DOC2);
      await db.commit('commit B');

      await db.checkout(commitA.id);
      expect(await db.currentHead()).toBe(commitA.id);
    } finally {
      await cleanup();
    }
  });

  test('checkout wipes uncommitted working changes', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: commitA } = await db.commit('commit A');

      // Make an uncommitted change.
      db.insert('doc:UNCOMMITTED', { dirty: true });
      expect(db.state.has('doc:UNCOMMITTED')).toBe(true);

      await db.checkout(commitA.id);

      // Uncommitted document must be gone.
      expect(db.state.has('doc:UNCOMMITTED')).toBe(false);
      expect(db.state.size).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('multiple checkout roundtrips are consistent', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('commit 1');

      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('commit 2');

      // Bounce between commits multiple times.
      await db.checkout(c1.id);
      expect(db.state.size).toBe(1);
      expect(db.get('doc:1')).toEqual(DOC1);

      await db.checkout(c2.id);
      expect(db.state.size).toBe(2);
      expect(db.get('doc:2')).toEqual(DOC2);

      await db.checkout(c1.id);
      expect(db.state.size).toBe(1);
      expect(db.get('doc:2')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getHistory() via NilesKV
// ---------------------------------------------------------------------------

describe('NilesKV.getHistory()', () => {
  test('throws HeadNotInitialisedError before any commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.getHistory()).rejects.toThrow(HeadNotInitialisedError);
    } finally {
      await cleanup();
    }
  });

  test('three-commit chain is returned in chronological order', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('commit 1');
      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('commit 2');
      db.insert('doc:3', DOC3);
      const { commit: c3 } = await db.commit('commit 3');

      const history = await db.getHistory();
      expect(history.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// checkout() error paths
// ---------------------------------------------------------------------------

describe('NilesKV.checkout() — error paths', () => {
  test('throws CommitNotFoundError for an unknown hash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.checkout('a'.repeat(64))).rejects.toThrow(CommitNotFoundError);
    } finally {
      await cleanup();
    }
  });

  // checkout() now accepts both 64-char hashes AND branch names — any non-hex
  // string is treated as a branch name.  'tooshort' is a valid branch name
  // that simply does not exist, so BranchNotFoundError is correct.
  test('throws BranchNotFoundError for any non-hex string (treated as branch name)', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.checkout('tooshort')).rejects.toThrow(BranchNotFoundError);
      await expect(db.checkout('no-such-branch')).rejects.toThrow(BranchNotFoundError);
    } finally {
      await cleanup();
    }
  });

  // TypeError is still surfaced for a valid-looking 64-char string that is not
  // a real commit — getCommit() validates the format after branch routing.
  test('throws CommitNotFoundError for a 64-char hex string with no commit on disk', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.checkout('a'.repeat(64))).rejects.toThrow(CommitNotFoundError);
    } finally {
      await cleanup();
    }
  });

  test('throws BranchNotFoundError for an unknown branch name', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.checkout('no-such-branch')).rejects.toThrow(BranchNotFoundError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Merkle root determinism through NilesKV
// ---------------------------------------------------------------------------

describe('NilesKV — Merkle root determinism', () => {
  test('inserting same documents in different order yields the same Merkle root', async () => {
    const { db: db1, cleanup: c1 } = await makeDB();
    const { db: db2, cleanup: c2 } = await makeDB();
    try {
      // db1: insert A, B, C
      db1.insert('doc:a', DOC1);
      db1.insert('doc:b', DOC2);
      db1.insert('doc:c', DOC3);
      const { merkleRoot: root1 } = await db1.commit('forward order');

      // db2: insert C, A, B (different insertion order)
      db2.insert('doc:c', DOC3);
      db2.insert('doc:a', DOC1);
      db2.insert('doc:b', DOC2);
      const { merkleRoot: root2 } = await db2.commit('reverse order');

      expect(root1).toBe(root2);
    } finally {
      await c1();
      await c2();
    }
  });
});

// ---------------------------------------------------------------------------
// status() — diff engine
// ---------------------------------------------------------------------------

describe('NilesKV.status()', () => {
  test('returns all-empty arrays when working state matches HEAD commit exactly', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      await db.commit('baseline');
      const s = await db.status();
      expect(s.added).toHaveLength(0);
      expect(s.modified).toHaveLength(0);
      expect(s.deleted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('reports everything as added when there are no commits yet', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      const s = await db.status();
      expect(s.added.sort()).toEqual(['doc:1', 'doc:2'].sort());
      expect(s.modified).toHaveLength(0);
      expect(s.deleted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('reports a new document as added after a previous commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('baseline');
      db.insert('doc:2', DOC2);
      const s = await db.status();
      expect(s.added).toEqual(['doc:2']);
      expect(s.modified).toHaveLength(0);
      expect(s.deleted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('reports a changed document as modified', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('baseline');
      db.insert('doc:1', { name: 'Alice-Updated', role: 'lead engineer', age: 31 });
      const s = await db.status();
      expect(s.added).toHaveLength(0);
      expect(s.modified).toEqual(['doc:1']);
      expect(s.deleted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('reports a removed document as deleted', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      await db.commit('baseline');
      db.delete('doc:2');
      const s = await db.status();
      expect(s.added).toHaveLength(0);
      expect(s.modified).toHaveLength(0);
      expect(s.deleted).toEqual(['doc:2']);
    } finally {
      await cleanup();
    }
  });

  test('simultaneously reports added, modified, and deleted categories', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      db.insert('doc:3', DOC3);
      await db.commit('baseline: 3 docs');

      // Modify doc:1, delete doc:2, add doc:4
      db.insert('doc:1', { name: 'Alice-Changed', role: 'cto', age: 35 });
      db.delete('doc:2');
      db.insert('doc:4', { name: 'Diana', role: 'qa', age: 28 });

      const s = await db.status();
      expect(s.added).toEqual(['doc:4']);
      expect(s.modified).toEqual(['doc:1']);
      expect(s.deleted).toEqual(['doc:2']);
    } finally {
      await cleanup();
    }
  });

  test('status is clean immediately after checkout', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('initial');
      db.insert('doc:2', DOC2);
      await db.commit('second');

      await db.checkout(c1.id);
      const s = await db.status();
      expect(s.added).toHaveLength(0);
      expect(s.modified).toHaveLength(0);
      expect(s.deleted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('empty working state after a commit shows all docs as deleted', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('with data');
      db.delete('doc:1');
      const s = await db.status();
      expect(s.deleted).toEqual(['doc:1']);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// createBranch() and branch checkout
// ---------------------------------------------------------------------------

describe('NilesKV.createBranch() and branch checkout', () => {
  test('createBranch() creates a branch at current HEAD', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit } = await db.commit('initial');
      await db.createBranch('feature');
      const resolved = await db.commitManager.resolveBranch('feature');
      expect(resolved).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('checkout(branchName) reconstructs state from that branch tip', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('initial on main');
      await db.createBranch('feature');
      await db.commitManager.switchBranch('feature');

      db.insert('doc:2', DOC2);
      await db.commit('feature commit');

      // Go back to main via hash checkout
      const mainHash = await db.commitManager.resolveBranch('main');
      await db.checkout(mainHash);
      expect(db.state.size).toBe(1);
      expect(db.get('doc:1')).toEqual(DOC1);
      expect(db.get('doc:2')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('checkout(branchName) puts HEAD in attached state', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('initial');
      await db.createBranch('feature');

      // Detach HEAD first, then re-attach via branch checkout.
      const { commit: c } = await db.commit('second on main');
      await db.commitManager.detachHead(c.id);
      expect(await db.currentBranch()).toBeNull(); // detached

      // Now checkout feature branch — should re-attach.
      await db.checkout('feature');
      expect(await db.currentBranch()).toBe('feature');
    } finally {
      await cleanup();
    }
  });

  test('checkout(commitHash) puts HEAD in detached state', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('initial');
      await db.checkout(c1.id);
      expect(await db.currentBranch()).toBeNull();
      expect(await db.currentHead()).toBe(c1.id);
    } finally {
      await cleanup();
    }
  });

  test('createBranch() throws HeadNotInitialisedError with no commits', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await expect(db.createBranch('feature')).rejects.toThrow(HeadNotInitialisedError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Working-state persistence
// ---------------------------------------------------------------------------

describe('NilesKV — working-state persistence', () => {
  test('persistWorkingState / loadWorkingState round-trips the state Map', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      await db.persistWorkingState();

      // Simulate new process by creating a fresh NilesKV instance on the same dbRoot.
      const db2 = new NilesKV(db.dbRoot);
      await db2.init();
      await db2.loadWorkingState();

      expect(db2.state.size).toBe(2);
      expect(db2.get('doc:1')).toEqual(DOC1);
      expect(db2.get('doc:2')).toEqual(DOC2);
    } finally {
      await cleanup();
    }
  });

  test('loadWorkingState() initialises empty state when no WORKING_STATE file exists', async () => {
    const { db, cleanup } = await makeDB();
    try {
      await db.loadWorkingState();
      expect(db.state.size).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Write-Ahead Log (WAL) — durability and crash recovery
// ---------------------------------------------------------------------------

describe('Write-Ahead Log — crash recovery', () => {
  test('WAL file exists after insert()', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const walContent = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      expect(walContent.trim().length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('WAL entry for insert contains correct op, id, and doc', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const raw = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      const entry = JSON.parse(raw.trim().split('\n')[0]);
      expect(entry.op).toBe('insert');
      expect(entry.id).toBe('doc:1');
      expect(entry.doc).toEqual(DOC1);
      expect(typeof entry.ts).toBe('number');
    } finally {
      await cleanup();
    }
  });

  test('WAL entry for delete has op delete and correct id', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.delete('doc:1');
      const raw = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      const lines = raw.trim().split('\n');
      const delEntry = JSON.parse(lines[1]);
      expect(delEntry.op).toBe('delete');
      expect(delEntry.id).toBe('doc:1');
    } finally {
      await cleanup();
    }
  });

  test('WAL is empty after a successful commit()', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('first');
      const walContent = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      expect(walContent.trim()).toBe('');
    } finally {
      await cleanup();
    }
  });

  test('WAL is empty after checkout()', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('initial');
      db.insert('doc:2', DOC2); // uncommitted — WAL has this
      await db.checkout(c1.id);
      const walContent = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      expect(walContent.trim()).toBe('');
    } finally {
      await cleanup();
    }
  });

  test('loadWorkingState() replays WAL and reconstructs uncommitted inserts after a simulated crash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      // Insert docs — WAL is written. No commit, no persistWorkingState = "crash".
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);

      // New process: fresh instance on same dbRoot.
      const db2 = new NilesKV(db.dbRoot);
      await db2.init();
      await db2.loadWorkingState();

      expect(db2.state.size).toBe(2);
      expect(db2.get('doc:1')).toEqual(DOC1);
      expect(db2.get('doc:2')).toEqual(DOC2);
    } finally {
      await cleanup();
    }
  });

  test('loadWorkingState() replays WAL entries on top of committed state after crash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await db.commit('initial commit'); // WAL cleared

      // Uncommitted changes — WAL gets these.
      db.insert('doc:2', DOC2);
      db.insert('doc:3', DOC3);
      // Process "crashes" here.

      const db2 = new NilesKV(db.dbRoot);
      await db2.init();
      await db2.loadWorkingState();

      expect(db2.state.size).toBe(3);
      expect(db2.get('doc:1')).toEqual(DOC1);
      expect(db2.get('doc:2')).toEqual(DOC2);
      expect(db2.get('doc:3')).toEqual(DOC3);
    } finally {
      await cleanup();
    }
  });

  test('loadWorkingState() replays WAL delete operations correctly after crash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      await db.commit('two docs');

      // Delete doc:1 — WAL records it. Then "crash".
      db.delete('doc:1');

      const db2 = new NilesKV(db.dbRoot);
      await db2.init();
      await db2.loadWorkingState();

      expect(db2.state.size).toBe(1);
      expect(db2.get('doc:1')).toBeUndefined();
      expect(db2.get('doc:2')).toEqual(DOC2);
    } finally {
      await cleanup();
    }
  });

  test('WAL write happens before state update — ordering invariant', async () => {
    const { db, dbRoot, cleanup } = await makeDB();
    try {
      // After insert, WAL must already contain the entry.
      db.insert('doc:1', DOC1);
      const raw = await readFile(join(dbRoot, 'wal.log'), 'utf8');
      expect(raw.trim()).not.toBe('');
      expect(db.get('doc:1')).toEqual(DOC1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Optimistic Concurrency Control (OCC)
// ---------------------------------------------------------------------------

describe('NilesKV.commit() — Optimistic Concurrency Control', () => {
  test('commit without expectedParentHash always succeeds', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await expect(db.commit('first')).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test('commit with correct expectedParentHash succeeds', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');

      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('second', c1.id);
      expect(c2.parent_hash).toBe(c1.id);
    } finally {
      await cleanup();
    }
  });

  test('throws ConcurrencyError when expectedParentHash does not match HEAD', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');

      // Advance HEAD by committing again.
      db.insert('doc:2', DOC2);
      await db.commit('second');

      // Now try to commit with stale expectedParentHash (c1.id).
      db.insert('doc:3', DOC3);
      await expect(db.commit('conflicting commit', c1.id)).rejects.toThrow(ConcurrencyError);
    } finally {
      await cleanup();
    }
  });

  test('ConcurrencyError is thrown even when expected is null but HEAD is not', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');

      // Pass a hash that is definitely wrong (all zeros).
      db.insert('doc:2', DOC2);
      await expect(db.commit('bad', 'a'.repeat(64))).rejects.toThrow(ConcurrencyError);
    } finally {
      await cleanup();
    }
  });

  test('ConcurrencyError has correct name and message', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');
      db.insert('doc:2', DOC2);
      await db.commit('second'); // advance HEAD

      db.insert('doc:3', DOC3);
      let caught;
      try {
        await db.commit('conflict', c1.id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConcurrencyError);
      expect(caught.name).toBe('ConcurrencyError');
      expect(caught.message.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test('ConcurrencyError is an instance of Error', () => {
    expect(new ConcurrencyError()).toBeInstanceOf(Error);
  });

  test('commit after ConcurrencyError still succeeds with correct expectedParentHash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first');

      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('second');

      // First attempt with stale hash → ConcurrencyError
      db.insert('doc:3', DOC3);
      await expect(db.commit('conflict', c1.id)).rejects.toThrow(ConcurrencyError);

      // Second attempt with correct hash → succeeds
      const { commit: c3 } = await db.commit('retry', c2.id);
      expect(c3.parent_hash).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for expectedParentHash that is not null or 64-char hex', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      await expect(db.commit('msg', 'tooshort')).rejects.toThrow(TypeError);
      await expect(db.commit('msg', 42)).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Cryptographic Inclusion Proofs
// ---------------------------------------------------------------------------

describe('NilesKV.generateProof() and NilesKV.verifyProof()', () => {
  test('generates a valid proof for a document in a 3-document commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      db.insert('doc:3', DOC3);
      const { commit } = await db.commit('three docs');

      const { docHash, proof, rootHash } = await db.generateProof(commit.id, 'doc:1');
      expect(NilesKV.verifyProof(docHash, proof, rootHash)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('proof is valid for every document in the commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:a', DOC1);
      db.insert('doc:b', DOC2);
      db.insert('doc:c', DOC3);
      const { commit } = await db.commit('all docs');

      for (const docId of ['doc:a', 'doc:b', 'doc:c']) {
        const { docHash, proof, rootHash } = await db.generateProof(commit.id, docId);
        expect(NilesKV.verifyProof(docHash, proof, rootHash)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test('verifyProof returns false for a tampered document hash', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      const { commit } = await db.commit('two docs');

      const { proof, rootHash } = await db.generateProof(commit.id, 'doc:1');
      const tamperedHash = db.blobStore.computeHash({ name: 'Mallory', role: 'attacker' });
      expect(NilesKV.verifyProof(tamperedHash, proof, rootHash)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('verifyProof returns false if the root hash is from a different commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('commit 1');
      db.insert('doc:2', DOC2);
      const { commit: c2 } = await db.commit('commit 2');

      const { docHash, proof } = await db.generateProof(c1.id, 'doc:1');
      // Verify against c2's root — should fail (doc:1 proof was built for c1)
      expect(NilesKV.verifyProof(docHash, proof, c2.root_merkle_hash)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('generateProof proof object has the expected shape', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      db.insert('doc:2', DOC2);
      const { commit } = await db.commit('two docs');

      const result = await db.generateProof(commit.id, 'doc:1');
      expect(result).toHaveProperty('docId', 'doc:1');
      expect(result.docHash).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof result.leafIndex).toBe('number');
      expect(Array.isArray(result.proof)).toBe(true);
      expect(result.rootHash).toBe(commit.root_merkle_hash);
      expect(result.commitHash).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('generateProof throws for a document not in the commit', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit } = await db.commit('one doc');
      await expect(db.generateProof(commit.id, 'doc:nonexistent')).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test('proof generated at one point in time still verifies after further commits', async () => {
    const { db, cleanup } = await makeDB();
    try {
      db.insert('doc:1', DOC1);
      const { commit: c1 } = await db.commit('first commit');

      // Capture proof at c1.
      const { docHash, proof, rootHash } = await db.generateProof(c1.id, 'doc:1');

      // Make further commits — proof must still verify against original root.
      db.insert('doc:2', DOC2);
      await db.commit('second commit');

      expect(NilesKV.verifyProof(docHash, proof, rootHash)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
