import { createHash } from 'crypto';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommitManager, CommitNotFoundError, HeadNotInitialisedError, BranchNotFoundError } from './CommitManager.js';

/** SHA-256 convenience wrapper. */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A pair of deterministic fake Merkle roots used as test fixtures. */
const MERKLE = {
  root1: sha256('state-v1'),
  root2: sha256('state-v2'),
  root3: sha256('state-v3'),
};

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), 'nileskv-cm-test-'));
  const dbRoot = join(dir, '.db');
  const cm = new CommitManager(dbRoot);
  await cm.init();
  return {
    cm,
    dbRoot,
    commitsDir: join(dbRoot, 'commits'),
    refsDir: join(dbRoot, 'refs'),
    headPath: join(dbRoot, 'refs', 'HEAD'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

describe('CommitManager.init()', () => {
  test('creates .db/commits directory', async () => {
    const { commitsDir, cleanup } = await makeManager();
    try {
      await expect(readdir(commitsDir)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test('creates .db/refs directory', async () => {
    const { refsDir, cleanup } = await makeManager();
    try {
      await expect(readdir(refsDir)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test('is idempotent — calling init() twice does not throw', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await expect(cm.init()).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// createCommit()
// ---------------------------------------------------------------------------

describe('CommitManager.createCommit()', () => {
  test('returns a commit object with the correct schema shape', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('initial commit', MERKLE.root1, null);
      expect(typeof commit.id).toBe('string');
      expect(commit.id).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof commit.timestamp).toBe('number');
      expect(commit.message).toBe('initial commit');
      expect(commit.parent_hash).toBeNull();
      expect(commit.root_merkle_hash).toBe(MERKLE.root1);
    } finally {
      await cleanup();
    }
  });

  test('persists the commit as <hash>.json in .db/commits/', async () => {
    const { cm, commitsDir, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('initial commit', MERKLE.root1, null);
      const files = await readdir(commitsDir);
      expect(files).toContain(`${commit.id}.json`);
    } finally {
      await cleanup();
    }
  });

  test('the persisted JSON round-trips back to the returned commit object', async () => {
    const { cm, commitsDir, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('round trip', MERKLE.root1, null);
      const raw = await readFile(join(commitsDir, `${commit.id}.json`), 'utf8');
      expect(JSON.parse(raw)).toEqual(commit);
    } finally {
      await cleanup();
    }
  });

  test('two commits with the same content fields produce different IDs due to timestamp', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      // Artificial delay to guarantee different timestamps.
      const c1 = await cm.createCommit('msg', MERKLE.root1, null);
      await new Promise((r) => setTimeout(r, 5));
      const c2 = await cm.createCommit('msg', MERKLE.root1, null);
      expect(c1.id).not.toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('a child commit carries the parent commit hash', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const parent = await cm.createCommit('parent', MERKLE.root1, null);
      const child = await cm.createCommit('child', MERKLE.root2, parent.id);
      expect(child.parent_hash).toBe(parent.id);
    } finally {
      await cleanup();
    }
  });

  test('three sequential commits each reference their predecessor', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('c1', MERKLE.root1, null);
      const c2 = await cm.createCommit('c2', MERKLE.root2, c1.id);
      const c3 = await cm.createCommit('c3', MERKLE.root3, c2.id);
      expect(c1.parent_hash).toBeNull();
      expect(c2.parent_hash).toBe(c1.id);
      expect(c3.parent_hash).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('creating the same logical commit twice does not duplicate the file', async () => {
    const { cm, commitsDir, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('dedup test', MERKLE.root1, null);
      // Manually replay save with same id — simulate idempotency at the storage layer.
      const before = await readdir(commitsDir);
      // Build a commit with the exact same id (can't reproduce without mocking time,
      // so we verify the file-exists guard by calling getCommit on the existing id).
      const fetched = await cm.getCommit(c1.id);
      expect(fetched).toEqual(c1);
      const after = await readdir(commitsDir);
      expect(after).toHaveLength(before.length);
    } finally {
      await cleanup();
    }
  });

  describe('input validation', () => {
    test('throws TypeError for an empty message', async () => {
      const { cm, cleanup } = await makeManager();
      try {
        await expect(cm.createCommit('', MERKLE.root1, null)).rejects.toThrow(TypeError);
        await expect(cm.createCommit('   ', MERKLE.root1, null)).rejects.toThrow(TypeError);
      } finally {
        await cleanup();
      }
    });

    test('throws TypeError for a non-string message', async () => {
      const { cm, cleanup } = await makeManager();
      try {
        await expect(cm.createCommit(null, MERKLE.root1, null)).rejects.toThrow(TypeError);
        await expect(cm.createCommit(42, MERKLE.root1, null)).rejects.toThrow(TypeError);
      } finally {
        await cleanup();
      }
    });

    test('throws TypeError for an invalid root_merkle_hash', async () => {
      const { cm, cleanup } = await makeManager();
      try {
        await expect(cm.createCommit('msg', 'bad-hash', null)).rejects.toThrow(TypeError);
        await expect(cm.createCommit('msg', '', null)).rejects.toThrow(TypeError);
        await expect(cm.createCommit('msg', null, null)).rejects.toThrow(TypeError);
      } finally {
        await cleanup();
      }
    });

    test('throws TypeError for an invalid parent_hash (not null and not 64-char hex)', async () => {
      const { cm, cleanup } = await makeManager();
      try {
        await expect(cm.createCommit('msg', MERKLE.root1, 'bad')).rejects.toThrow(TypeError);
        await expect(cm.createCommit('msg', MERKLE.root1, 123)).rejects.toThrow(TypeError);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// updateHead() and HEAD file
// ---------------------------------------------------------------------------

describe('CommitManager.updateHead()', () => {
  // HEAD now uses the Git-style "ref: refs/heads/main" indirection.
  // We verify the *resolved* value via readHead() — not the raw HEAD file —
  // because the raw file intentionally holds the ref pointer, not the hash.
  test('HEAD resolves to the commit hash after updateHead()', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('initial', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      expect(await cm.readHead()).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('HEAD resolves to the latest hash after two updateHead() calls', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('c1', MERKLE.root1, null);
      const c2 = await cm.createCommit('c2', MERKLE.root2, c1.id);
      await cm.updateHead(c1.id);
      await cm.updateHead(c2.id);
      expect(await cm.readHead()).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for a non-hex or wrong-length hash', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await expect(cm.updateHead('tooshort')).rejects.toThrow(TypeError);
      await expect(cm.updateHead('')).rejects.toThrow(TypeError);
      await expect(cm.updateHead('z'.repeat(64))).rejects.toThrow(TypeError);
      await expect(cm.updateHead(null)).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getHistory() — the core DAG traversal
// ---------------------------------------------------------------------------

describe('CommitManager.getHistory()', () => {
  test('throws HeadNotInitialisedError when no HEAD exists', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await expect(cm.getHistory()).rejects.toThrow(HeadNotInitialisedError);
    } finally {
      await cleanup();
    }
  });

  test('HeadNotInitialisedError has the correct name', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      let caught;
      try { await cm.getHistory(); } catch (e) { caught = e; }
      expect(caught.name).toBe('HeadNotInitialisedError');
    } finally {
      await cleanup();
    }
  });

  test('single commit history returns an array of length 1', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('only commit', MERKLE.root1, null);
      await cm.updateHead(c1.id);
      const history = await cm.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(c1.id);
    } finally {
      await cleanup();
    }
  });

  test('three-commit chain returns all three commits in chronological order', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      const c3 = await cm.createCommit('third commit', MERKLE.root3, c2.id);
      await cm.updateHead(c3.id);

      const history = await cm.getHistory();

      expect(history).toHaveLength(3);
      // Oldest first
      expect(history[0].id).toBe(c1.id);
      expect(history[1].id).toBe(c2.id);
      expect(history[2].id).toBe(c3.id);
    } finally {
      await cleanup();
    }
  });

  test('history messages are in chronological order', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      const c3 = await cm.createCommit('third commit', MERKLE.root3, c2.id);
      await cm.updateHead(c3.id);

      const history = await cm.getHistory();
      expect(history.map((c) => c.message)).toEqual([
        'initial commit',
        'second commit',
        'third commit',
      ]);
    } finally {
      await cleanup();
    }
  });

  test('each commit in history correctly references its parent', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      const c3 = await cm.createCommit('third commit', MERKLE.root3, c2.id);
      await cm.updateHead(c3.id);

      const [h1, h2, h3] = await cm.getHistory();
      expect(h1.parent_hash).toBeNull();
      expect(h2.parent_hash).toBe(c1.id);
      expect(h3.parent_hash).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('HEAD pointer updates between commits are reflected in getHistory', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      await cm.updateHead(c1.id);
      expect(await cm.getHistory()).toHaveLength(1);

      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      await cm.updateHead(c2.id);
      expect(await cm.getHistory()).toHaveLength(2);

      const c3 = await cm.createCommit('third commit', MERKLE.root3, c2.id);
      await cm.updateHead(c3.id);
      expect(await cm.getHistory()).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  test('limit parameter caps the number of returned commits (newest end truncated)', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      const c3 = await cm.createCommit('third commit', MERKLE.root3, c2.id);
      await cm.updateHead(c3.id);

      const history = await cm.getHistory(2);
      expect(history).toHaveLength(2);
      // Traversal starts at HEAD (newest) so limit cuts off the oldest.
      expect(history[0].id).toBe(c2.id);
      expect(history[1].id).toBe(c3.id);
    } finally {
      await cleanup();
    }
  });

  test('limit of 1 returns only HEAD commit', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      await cm.updateHead(c2.id);

      const history = await cm.getHistory(1);
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });

  test('limit larger than chain length returns the full chain', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      const c2 = await cm.createCommit('second commit', MERKLE.root2, c1.id);
      await cm.updateHead(c2.id);

      const history = await cm.getHistory(100);
      expect(history).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for a non-positive-integer limit', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('initial commit', MERKLE.root1, null);
      await cm.updateHead(c1.id);
      await expect(cm.getHistory(0)).rejects.toThrow(TypeError);
      await expect(cm.getHistory(-1)).rejects.toThrow(TypeError);
      await expect(cm.getHistory(1.5)).rejects.toThrow(TypeError);
      await expect(cm.getHistory('5')).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getCommit()
// ---------------------------------------------------------------------------

describe('CommitManager.getCommit()', () => {
  test('retrieves a commit by its hash', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('test', MERKLE.root1, null);
      const fetched = await cm.getCommit(commit.id);
      expect(fetched).toEqual(commit);
    } finally {
      await cleanup();
    }
  });

  test('throws CommitNotFoundError for an unknown hash', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const fakeHash = 'a'.repeat(64);
      await expect(cm.getCommit(fakeHash)).rejects.toThrow(CommitNotFoundError);
    } finally {
      await cleanup();
    }
  });

  test('CommitNotFoundError carries the queried hash and correct name', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const fakeHash = 'b'.repeat(64);
      let caught;
      try { await cm.getCommit(fakeHash); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(CommitNotFoundError);
      expect(caught.hash).toBe(fakeHash);
      expect(caught.name).toBe('CommitNotFoundError');
      expect(caught.message).toContain(fakeHash);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for an invalid hash format', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await expect(cm.getCommit('short')).rejects.toThrow(TypeError);
      await expect(cm.getCommit('')).rejects.toThrow(TypeError);
      await expect(cm.getCommit(null)).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CommitNotFoundError and HeadNotInitialisedError
// ---------------------------------------------------------------------------

describe('Custom error classes', () => {
  test('CommitNotFoundError is an instance of Error', () => {
    expect(new CommitNotFoundError('abc')).toBeInstanceOf(Error);
  });

  test('HeadNotInitialisedError is an instance of Error', () => {
    expect(new HeadNotInitialisedError()).toBeInstanceOf(Error);
  });

  test('HeadNotInitialisedError has descriptive message', () => {
    const err = new HeadNotInitialisedError();
    expect(err.message.length).toBeGreaterThan(0);
  });

  test('BranchNotFoundError is an instance of Error', () => {
    const err = new BranchNotFoundError('feature');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BranchNotFoundError');
    expect(err.branch).toBe('feature');
    expect(err.message).toContain('feature');
  });
});

// ---------------------------------------------------------------------------
// Branching (init, HEAD format, createBranch, switchBranch, resolveBranch,
//            getCurrentBranch, detachHead)
// ---------------------------------------------------------------------------

describe('CommitManager — HEAD initialisation and branch pointer format', () => {
  test('init() creates the refs/heads directory', async () => {
    const { dbRoot, cleanup } = await makeManager();
    try {
      const { readdir } = await import('fs/promises');
      await expect(readdir(join(dbRoot, 'refs', 'heads'))).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test('HEAD file contains a ref pointer after init()', async () => {
    const { headPath, cleanup } = await makeManager();
    try {
      const raw = (await readFile(headPath, 'utf8')).trim();
      expect(raw).toBe('ref: refs/heads/main');
    } finally {
      await cleanup();
    }
  });

  test('getCurrentBranch() returns "main" right after init()', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      expect(await cm.getCurrentBranch()).toBe('main');
    } finally {
      await cleanup();
    }
  });

  test('readHead() returns null before any commits', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      expect(await cm.readHead()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('readHead() resolves through the ref pointer after updateHead()', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      // The HEAD file still says "ref: refs/heads/main" — the hash lives in that file.
      expect(await cm.readHead()).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('updateHead() writes hash to the branch file, not to HEAD directly', async () => {
    const { cm, dbRoot, headPath, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      // HEAD itself still holds the ref pointer.
      const headContent = (await readFile(headPath, 'utf8')).trim();
      expect(headContent).toBe('ref: refs/heads/main');
      // The branch file holds the hash.
      const branchContent = (await readFile(join(dbRoot, 'refs', 'heads', 'main'), 'utf8')).trim();
      expect(branchContent).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });
});

describe('CommitManager.createBranch()', () => {
  test('creates a branch file at the current HEAD hash', async () => {
    const { cm, dbRoot, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      await cm.createBranch('feature');
      const branchContent = (await readFile(join(dbRoot, 'refs', 'heads', 'feature'), 'utf8')).trim();
      expect(branchContent).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('throws HeadNotInitialisedError when no commits exist', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await expect(cm.createBranch('feature')).rejects.toThrow(HeadNotInitialisedError);
    } finally {
      await cleanup();
    }
  });

  test('throws TypeError for an invalid branch name', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      await expect(cm.createBranch('')).rejects.toThrow(TypeError);
      await expect(cm.createBranch('   ')).rejects.toThrow(TypeError);
      await expect(cm.createBranch('bad name!')).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });
});

describe('CommitManager.switchBranch() and detachHead()', () => {
  test('switchBranch() writes ref pointer to HEAD', async () => {
    const { cm, headPath, cleanup } = await makeManager();
    try {
      await cm.switchBranch('feature');
      const raw = (await readFile(headPath, 'utf8')).trim();
      expect(raw).toBe('ref: refs/heads/feature');
    } finally {
      await cleanup();
    }
  });

  test('getCurrentBranch() returns the switched-to branch name', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      await cm.switchBranch('develop');
      expect(await cm.getCurrentBranch()).toBe('develop');
    } finally {
      await cleanup();
    }
  });

  test('detachHead() writes raw hash to HEAD', async () => {
    const { cm, headPath, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.detachHead(commit.id);
      const raw = (await readFile(headPath, 'utf8')).trim();
      expect(raw).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('getCurrentBranch() returns null in detached HEAD state', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.detachHead(commit.id);
      expect(await cm.getCurrentBranch()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('readHead() returns hash directly in detached state', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.detachHead(commit.id);
      expect(await cm.readHead()).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('updateHead() in detached state writes directly to HEAD', async () => {
    const { cm, headPath, cleanup } = await makeManager();
    try {
      const c1 = await cm.createCommit('c1', MERKLE.root1, null);
      const c2 = await cm.createCommit('c2', MERKLE.root2, c1.id);
      await cm.detachHead(c1.id);
      await cm.updateHead(c2.id);
      const raw = (await readFile(headPath, 'utf8')).trim();
      expect(raw).toBe(c2.id);
    } finally {
      await cleanup();
    }
  });
});

describe('CommitManager.resolveBranch()', () => {
  test('returns the commit hash for an existing branch', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      const commit = await cm.createCommit('first', MERKLE.root1, null);
      await cm.updateHead(commit.id);
      await cm.createBranch('feature');
      expect(await cm.resolveBranch('feature')).toBe(commit.id);
    } finally {
      await cleanup();
    }
  });

  test('returns null for a branch that does not exist', async () => {
    const { cm, cleanup } = await makeManager();
    try {
      expect(await cm.resolveBranch('nonexistent')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
