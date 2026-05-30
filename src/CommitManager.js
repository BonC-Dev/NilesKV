import { createHash } from 'crypto';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a commit hash cannot be found in `.db/commits/`.
 */
export class CommitNotFoundError extends Error {
  /** @param {string} hash */
  constructor(hash) {
    super(`Commit not found: ${hash}`);
    this.name = 'CommitNotFoundError';
    this.hash = hash;
  }
}

/**
 * Thrown when HEAD (or the branch it references) has no commits yet,
 * or when the HEAD file itself is absent.
 */
export class HeadNotInitialisedError extends Error {
  constructor() {
    super('HEAD is not initialised — no commits exist yet');
    this.name = 'HeadNotInitialisedError';
  }
}

/**
 * Thrown when a branch name references a file that does not exist in
 * `.db/refs/heads/`.
 */
export class BranchNotFoundError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`Branch not found: ${name}`);
    this.name = 'BranchNotFoundError';
    this.branch = name;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of a UTF-8 string.
 * @param {string} input
 * @returns {string}
 */
function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Serializes `obj` with keys sorted alphabetically so that logically
 * identical objects always produce the same string regardless of insertion
 * order.
 *
 * @param {object} obj
 * @returns {string}
 */
function deterministicJSON(obj) {
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// CommitManager
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Commit
 * @property {string}      id               - SHA-256 content hash of this commit.
 * @property {number}      timestamp        - Unix epoch milliseconds at creation time.
 * @property {string}      message          - Human-readable description of the change.
 * @property {string|null} parent_hash      - Hash of the preceding commit, or null for root.
 * @property {string}      root_merkle_hash - Merkle root of the database state at this commit.
 * @property {string|null} state_hash       - BlobStore hash of the {docId→blobHash} index blob.
 *                                            Required for state reconstruction during checkout.
 *                                            Null only for commits created outside of NilesKV.
 * @property {string|null} index_hash       - BlobStore hash of the field index blob:
 *                                            { field: { value: [docId, ...] } }.
 *                                            Null for commits predating field-index support.
 */

/**
 * Manages the commit Directed Acyclic Graph (DAG) and branch pointers on disk.
 *
 * ### Directory layout
 * ```
 * .db/
 *   commits/                — one JSON file per commit, named by its SHA-256 hash
 *   refs/
 *     HEAD                  — either "ref: refs/heads/<branch>" (attached)
 *                             or a raw 64-char hash (detached HEAD)
 *     heads/
 *       main                — current tip hash of the main branch
 *       <other-branches>…
 * ```
 *
 * ### HEAD pointer semantics (mirrors Git exactly)
 * - **Attached HEAD**: HEAD contains `ref: refs/heads/<branch>`.  Commits
 *   advance the branch file; `readHead()` resolves through the indirection.
 * - **Detached HEAD**: HEAD contains a raw hash.  `readHead()` returns it
 *   directly; commits overwrite HEAD in place.
 *
 * ### Commit identity
 * The commit `id` is the SHA-256 of the content fields
 * (`message`, `parent_hash`, `root_merkle_hash`, `state_hash`, `timestamp`)
 * serialised with alphabetically sorted keys.
 *
 * @example
 * const cm = new CommitManager('/project/.db');
 * await cm.init();
 * const c = await cm.createCommit('initial', merkleRoot, null, stateHash);
 * await cm.updateHead(c.id);         // advances 'main' branch file
 * await cm.createBranch('feature');  // creates refs/heads/feature at current tip
 * await cm.switchBranch('feature');  // HEAD now tracks 'feature'
 */
export class CommitManager {
  /**
   * @param {string} [dbRoot='.db'] - Path to the root database directory.
   */
  constructor(dbRoot = '.db') {
    this.dbRoot = dbRoot;
    this.commitsDir = join(dbRoot, 'commits');
    this.refsDir = join(dbRoot, 'refs');
    this.headsDir = join(dbRoot, 'refs', 'heads');
    this.headPath = join(dbRoot, 'refs', 'HEAD');
  }

  /**
   * Ensures all required directories exist and bootstraps HEAD to point at the
   * `main` branch if HEAD does not already exist.
   * Idempotent — safe to call multiple times.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await Promise.all([
      mkdir(this.commitsDir, { recursive: true }),
      mkdir(this.refsDir, { recursive: true }),
      mkdir(this.headsDir, { recursive: true }),
    ]);

    // Only write the initial HEAD ref once — preserve existing state on re-init.
    const headExists = await access(this.headPath).then(() => true).catch(() => false);
    if (!headExists) {
      await writeFile(this.headPath, 'ref: refs/heads/main', 'utf8');
    }
  }

  // ---------------------------------------------------------------------------
  // HEAD resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Reads and resolves HEAD to the current commit hash.
   *
   * - If HEAD contains `ref: refs/heads/<branch>`, reads the branch file.
   * - If HEAD contains a raw hash (detached HEAD), returns it directly.
   * - Returns `null` if HEAD or its referenced branch file does not exist yet.
   *
   * @returns {Promise<string|null>}
   */
  async readHead() {
    let content;
    try {
      content = (await readFile(this.headPath, 'utf8')).trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    if (content.startsWith('ref: ')) {
      const refRelPath = content.slice(5); // e.g. 'refs/heads/main'
      const refAbsPath = join(this.dbRoot, refRelPath);
      try {
        return (await readFile(refAbsPath, 'utf8')).trim();
      } catch (err) {
        if (err.code === 'ENOENT') return null; // branch exists but has no commits
        throw err;
      }
    }

    // Detached HEAD — content is a raw commit hash.
    return content;
  }

  /**
   * Returns the name of the currently tracked branch, or `null` when HEAD is
   * detached (pointing directly at a commit hash).
   *
   * @returns {Promise<string|null>}
   */
  async getCurrentBranch() {
    try {
      const content = (await readFile(this.headPath, 'utf8')).trim();
      if (content.startsWith('ref: refs/heads/')) {
        return content.slice('ref: refs/heads/'.length);
      }
      return null; // detached HEAD
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // HEAD mutation helpers
  // ---------------------------------------------------------------------------

  /**
   * Advances HEAD to `commit_hash`.
   *
   * - **Attached HEAD**: writes the hash to the branch file (e.g.
   *   `.db/refs/heads/main`), leaving HEAD's `ref:` pointer intact.
   * - **Detached HEAD**: overwrites HEAD in place with the raw hash.
   *
   * @param {string} commit_hash - A valid 64-character SHA-256 hex string.
   * @returns {Promise<void>}
   * @throws {TypeError} If `commit_hash` is not a 64-character hex string.
   */
  async updateHead(commit_hash) {
    if (typeof commit_hash !== 'string' || !/^[a-f0-9]{64}$/.test(commit_hash)) {
      throw new TypeError(
        'CommitManager.updateHead: commit_hash must be a 64-character hex string'
      );
    }

    let content;
    try {
      content = (await readFile(this.headPath, 'utf8')).trim();
    } catch (err) {
      if (err.code === 'ENOENT') {
        // HEAD file missing entirely (pre-init path) — write directly.
        await writeFile(this.headPath, commit_hash, 'utf8');
        return;
      }
      throw err;
    }

    if (content.startsWith('ref: ')) {
      // Attached HEAD: advance the branch file.
      const refAbsPath = join(this.dbRoot, content.slice(5));
      await writeFile(refAbsPath, commit_hash, 'utf8');
    } else {
      // Detached HEAD: overwrite HEAD directly.
      await writeFile(this.headPath, commit_hash, 'utf8');
    }
  }

  /**
   * Puts HEAD into **detached** state by writing the raw commit hash directly
   * into the HEAD file, bypassing any branch ref.
   *
   * @param {string} commit_hash
   * @returns {Promise<void>}
   * @throws {TypeError} If `commit_hash` is not a 64-character hex string.
   */
  async detachHead(commit_hash) {
    if (typeof commit_hash !== 'string' || !/^[a-f0-9]{64}$/.test(commit_hash)) {
      throw new TypeError(
        'CommitManager.detachHead: commit_hash must be a 64-character hex string'
      );
    }
    await writeFile(this.headPath, commit_hash, 'utf8');
  }

  /**
   * Puts HEAD into **attached** state by writing a `ref:` pointer to the
   * named branch.  The branch file does not need to exist yet.
   *
   * @param {string} name - Branch name (must already exist in refs/heads/).
   * @returns {Promise<void>}
   * @throws {TypeError} If `name` is not a valid branch name string.
   */
  async switchBranch(name) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError(
        'CommitManager.switchBranch: name must be a non-empty string'
      );
    }
    await writeFile(this.headPath, `ref: refs/heads/${name}`, 'utf8');
  }

  // ---------------------------------------------------------------------------
  // Branch management
  // ---------------------------------------------------------------------------

  /**
   * Creates a new branch at the current HEAD commit.
   *
   * The branch file `.db/refs/heads/<name>` is written with the current HEAD
   * hash.  If the branch already exists its tip is overwritten (same semantics
   * as `git branch -f`).
   *
   * @param {string} name - Branch identifier.  May contain alphanumerics,
   *   hyphens, underscores, dots, and forward-slashes.
   * @returns {Promise<void>}
   * @throws {TypeError}             If `name` is not a valid branch identifier.
   * @throws {HeadNotInitialisedError} If there are no commits yet to branch from.
   */
  async createBranch(name) {
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      !/^[a-zA-Z0-9_\-./]+$/.test(name)
    ) {
      throw new TypeError(
        `CommitManager.createBranch: "${name}" is not a valid branch identifier`
      );
    }

    const currentHash = await this.readHead();
    if (currentHash === null) {
      throw new HeadNotInitialisedError();
    }

    const branchPath = join(this.headsDir, name);
    await writeFile(branchPath, currentHash, 'utf8');
  }

  /**
   * Resolves a branch name to its current tip commit hash.
   *
   * @param {string} name
   * @returns {Promise<string|null>} The commit hash, or `null` if the branch
   *   file does not exist.
   */
  async resolveBranch(name) {
    const branchPath = join(this.headsDir, name);
    try {
      return (await readFile(branchPath, 'utf8')).trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Commit operations
  // ---------------------------------------------------------------------------

  /**
   * Constructs, persists, and returns a new commit object.
   *
   * The commit `id` is derived by hashing the content fields with sorted keys.
   * Writing is idempotent: if a commit with the same content already exists the
   * file is not rewritten.
   *
   * @param {string}      message             - Commit description.
   * @param {string}      root_merkle_hash    - Merkle root of the snapshotted state.
   * @param {string|null} parent_hash         - Previous commit hash, or null for root.
   * @param {string|null} [state_hash=null]   - BlobStore hash of the {docId→blobHash}
   *                                            index; required for checkout to reconstruct state.
   * @param {string|null} [index_hash=null]   - BlobStore hash of the field index blob
   *                                            { field: { value: [docId] } }; null for old commits.
   * @returns {Promise<Commit>}
   * @throws {TypeError} If arguments fail type/format validation.
   */
  async createCommit(message, root_merkle_hash, parent_hash, state_hash = null, index_hash = null) {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('CommitManager.createCommit: message must be a non-empty string');
    }
    if (typeof root_merkle_hash !== 'string' || !/^[a-f0-9]{64}$/.test(root_merkle_hash)) {
      throw new TypeError(
        'CommitManager.createCommit: root_merkle_hash must be a 64-character hex string'
      );
    }
    if (
      parent_hash !== null &&
      (typeof parent_hash !== 'string' || !/^[a-f0-9]{64}$/.test(parent_hash))
    ) {
      throw new TypeError(
        'CommitManager.createCommit: parent_hash must be a 64-character hex string or null'
      );
    }
    if (
      state_hash !== null &&
      (typeof state_hash !== 'string' || !/^[a-f0-9]{64}$/.test(state_hash))
    ) {
      throw new TypeError(
        'CommitManager.createCommit: state_hash must be a 64-character hex string or null'
      );
    }
    if (
      index_hash !== null &&
      (typeof index_hash !== 'string' || !/^[a-f0-9]{64}$/.test(index_hash))
    ) {
      throw new TypeError(
        'CommitManager.createCommit: index_hash must be a 64-character hex string or null'
      );
    }

    const timestamp = Date.now();

    // Hash only content fields — `id` cannot be part of its own preimage.
    const contentFields = { index_hash, message, parent_hash, root_merkle_hash, state_hash, timestamp };
    const id = sha256(deterministicJSON(contentFields));

    /** @type {Commit} */
    const commit = { id, message, parent_hash, root_merkle_hash, state_hash, index_hash, timestamp };

    const filePath = join(this.commitsDir, `${id}.json`);
    const exists = await access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      await writeFile(filePath, JSON.stringify(commit, null, 2), 'utf8');
    }

    return commit;
  }

  /**
   * Reads a single commit from `.db/commits/<hash>.json`.
   *
   * @param {string} hash
   * @returns {Promise<Commit>}
   * @throws {TypeError}           If `hash` is not a 64-character hex string.
   * @throws {CommitNotFoundError} If no file exists for that hash.
   */
  async getCommit(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new TypeError(
        `CommitManager.getCommit: hash must be a 64-character hex string, got: ${JSON.stringify(hash)}`
      );
    }

    const filePath = join(this.commitsDir, `${hash}.json`);
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new CommitNotFoundError(hash);
      throw err;
    }
    return JSON.parse(raw);
  }

  /**
   * Walks the commit DAG from HEAD backwards through `parent_hash` links,
   * collecting up to `limit` commits and returning them in chronological order
   * (oldest first).
   *
   * @param {number} [limit=10] - Maximum number of commits to return.
   * @returns {Promise<Commit[]>} Chronological commit array, oldest at index 0.
   * @throws {HeadNotInitialisedError} If HEAD resolves to null.
   * @throws {CommitNotFoundError}     If a commit in the chain is missing.
   * @throws {TypeError}               If `limit` is not a positive integer.
   */
  async getHistory(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('CommitManager.getHistory: limit must be a positive integer');
    }

    const headHash = await this.readHead();
    if (headHash === null) {
      throw new HeadNotInitialisedError();
    }

    const commits = [];
    let current = headHash;

    while (current !== null && commits.length < limit) {
      const commit = await this.getCommit(current);
      commits.push(commit);
      current = commit.parent_hash;
    }

    // Reverse so callers receive oldest-first (chronological) order.
    return commits.reverse();
  }
}
