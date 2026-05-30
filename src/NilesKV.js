import { readFile, writeFile } from 'fs/promises';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { BlobStore } from './BlobStore.js';
import { MerkleTree } from './MerkleTree.js';
import { CommitManager, HeadNotInitialisedError } from './CommitManager.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `checkout()` is given a branch name that does not exist.
 */
export class BranchNotFoundError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`Branch not found: ${name}`);
    this.name = 'BranchNotFoundError';
    this.branch = name;
  }
}

/**
 * Thrown when `checkout()` targets a commit with no `state_hash` (cannot
 * reconstruct state from it).
 */
export class UnrestoredCommitError extends Error {
  /** @param {string} commitId */
  constructor(commitId) {
    super(`Commit ${commitId} has no state_hash and cannot be checked out`);
    this.name = 'UnrestoredCommitError';
    this.commitId = commitId;
  }
}

/**
 * Thrown by `insert()` when the document ID or document body is invalid.
 */
export class InvalidDocumentError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`Invalid document: ${reason}`);
    this.name = 'InvalidDocumentError';
  }
}

/**
 * Thrown by `commit()` when `expectedParentHash` is supplied but does not
 * match the actual current HEAD — indicating a concurrent write.
 */
export class ConcurrencyError extends Error {
  /** @param {string} [msg] */
  constructor(msg = 'State changed before commit could complete') {
    super(msg);
    this.name = 'ConcurrencyError';
  }
}

// ---------------------------------------------------------------------------
// Re-export CommitManager errors so callers only need one import
// ---------------------------------------------------------------------------
export { HeadNotInitialisedError } from './CommitManager.js';
export { CommitNotFoundError } from './CommitManager.js';

// ---------------------------------------------------------------------------
// NilesKV
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CommitResult
 * @property {import('./CommitManager.js').Commit} commit - The newly created commit.
 * @property {string} merkleRoot - The Merkle root computed for this snapshot.
 */

/**
 * @typedef {object} StatusResult
 * @property {string[]} added    - Document IDs in working state but not committed.
 * @property {string[]} modified - Document IDs whose content differs from committed.
 * @property {string[]} deleted  - Document IDs in committed state absent from working.
 */

/**
 * @typedef {object} InclusionProof
 * @property {string}   docId       - The document ID that was proved.
 * @property {string}   docHash     - SHA-256 hash of the document blob.
 * @property {number}   leafIndex   - Position of the document in the sorted leaf array.
 * @property {import('./MerkleTree.js').ProofStep[]} proof - Sibling hashes from leaf to root.
 * @property {string}   rootHash    - The Merkle root the proof is against.
 * @property {string}   commitHash  - The commit this proof was generated from.
 */

/**
 * NilesKV — a content-addressable, version-controlled state engine.
 *
 * Orchestrates four subsystems:
 * - **BlobStore**      — content-addressable persistence of JSON documents.
 * - **MerkleTree**     — cryptographic state fingerprint.
 * - **CommitManager**  — DAG commit history with Git-style branch pointers.
 * - **WAL**            — append-only write-ahead log for crash durability.
 *
 * ### Durability guarantees (Write-Ahead Log)
 * Every `insert()` and `delete()` is synchronously appended to `.db/wal.log`
 * **before** updating `this.state`.  On process restart `loadWorkingState()`
 * reconstructs the committed state from HEAD and then replays any WAL entries,
 * recovering all operations that occurred since the last `commit()`.
 *
 * `commit()` clears the WAL atomically after persisting all blobs and advancing
 * HEAD.  `checkout()` also clears the WAL — discarding uncommitted changes,
 * consistent with a hard reset semantics.
 *
 * ### Optimistic Concurrency Control
 * `commit(message, expectedParentHash)` throws `ConcurrencyError` if the
 * actual HEAD differs from `expectedParentHash` at the time of commit,
 * detecting concurrent writes without locks.
 *
 * ### Cryptographic Inclusion Proofs
 * `generateProof(commitHash, docId)` returns a Merkle sibling-hash path that
 * proves a document was part of a given snapshot.  `NilesKV.verifyProof()` is a
 * pure static function that can verify the proof offline without database access.
 */
export class NilesKV {
  /**
   * @param {string} [dbRoot='.db'] - Path to the root database directory.
   */
  constructor(dbRoot = '.db') {
    this.dbRoot = dbRoot;
    this.blobStore = new BlobStore(dbRoot);
    this.commitManager = new CommitManager(dbRoot);
    this.walPath = join(dbRoot, 'wal.log');
    this.workingStatePath = join(dbRoot, 'WORKING_STATE');
    /** @type {Map<string, object>} */
    this.state = new Map();
    /** @type {boolean} WAL writes are gated behind this flag set by init(). */
    this._walReady = false;
  }

  /**
   * Initialises all subsystem directories and enables WAL writes.
   * Idempotent — safe to call multiple times.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await Promise.all([
      this.blobStore.init(),
      this.commitManager.init(),
    ]);
    this._walReady = true;
  }

  // ---------------------------------------------------------------------------
  // WAL internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Synchronously appends a WAL entry to `.db/wal.log`.
   *
   * Using a synchronous write guarantees the operation is durable on disk
   * **before** `this.state` is updated.  This is the foundational invariant
   * of the write-ahead log: the log always leads the in-memory state.
   *
   * @param {'insert'|'delete'} op
   * @param {string} id
   * @param {object|null} [doc]
   */
  _walAppend(op, id, doc = null) {
    if (!this._walReady) return;
    const entry = JSON.stringify({ op, id, doc, ts: Date.now() });
    appendFileSync(this.walPath, entry + '\n', 'utf8');
  }

  /**
   * Reads `.db/wal.log` and replays each entry against `this.state`.
   * Silently skips corrupt or unrecognised lines.
   *
   * @returns {Promise<void>}
   */
  async _replayWAL() {
    let raw;
    try {
      raw = await readFile(this.walPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.op === 'insert' && typeof entry.id === 'string' && entry.doc) {
          this.state.set(entry.id, entry.doc);
        } else if (entry.op === 'delete' && typeof entry.id === 'string') {
          this.state.delete(entry.id);
        }
      } catch {
        // Corrupt WAL entry (e.g. partial write at crash boundary) — skip it.
      }
    }
  }

  /**
   * Truncates the WAL to zero bytes.  Called after a successful commit or
   * checkout so that replayed entries on the next restart are fresh.
   *
   * @returns {Promise<void>}
   */
  async _walClear() {
    try {
      await writeFile(this.walPath, '', 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // WAL never written — nothing to clear.
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Working-state CRUD
  // ---------------------------------------------------------------------------

  /**
   * Adds or replaces a document in the working state.
   *
   * The operation is **synchronously** appended to the WAL before updating
   * `this.state`, ensuring it survives a crash even if the process exits before
   * the next `commit()`.
   *
   * @param {string} id       - Unique document identifier (non-empty string).
   * @param {object} document - A JSON-serializable plain object (not an array).
   * @throws {InvalidDocumentError}
   */
  insert(id, document) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new InvalidDocumentError('id must be a non-empty string');
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new InvalidDocumentError('document must be a plain non-null object');
    }
    this._walAppend('insert', id, document);
    this.state.set(id, document);
  }

  /**
   * Removes a document from the working state.
   *
   * The deletion is synchronously appended to the WAL before state is updated.
   *
   * @param {string} id - The document ID to remove.
   * @returns {boolean} True if the document existed and was removed.
   */
  delete(id) {
    const existed = this.state.has(id);
    this._walAppend('delete', id);
    return this.state.delete(id);
  }

  /**
   * Returns a shallow copy of the document stored under `id`, or `undefined`.
   *
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    const doc = this.state.get(id);
    return doc !== undefined ? { ...doc } : undefined;
  }

  // ---------------------------------------------------------------------------
  // Commit pipeline
  // ---------------------------------------------------------------------------

  /**
   * Snapshots the current working state into a new commit.
   *
   * ### Optimistic Concurrency Control
   * When `expectedParentHash` is supplied, the actual HEAD is read at the start
   * of the commit pipeline.  If they differ, a `ConcurrencyError` is thrown
   * immediately — no blobs are written and no state changes.  Pass the commit
   * hash you read when you last fetched state to detect concurrent writers.
   *
   * ### Pipeline
   * 1. OCC check (if `expectedParentHash` provided).
   * 2. Sort state entries by document ID (deterministic Merkle root).
   * 3. Persist each document to BlobStore → collect blob hashes.
   * 4. Save the `{ docId: blobHash }` state-index blob.
   * 5. Build the field index `{ field: { value: [docId, ...] } }` and save as blob.
   * 6. Build the Merkle tree over the ordered blob hashes.
   * 7. Create the commit object and advance HEAD.
   * 8. Clear the WAL (all operations are now durably committed).
   *
   * @param {string}      message             - Human-readable description.
   * @param {string|null} [expectedParentHash] - OCC guard: expected current HEAD.
   * @returns {Promise<CommitResult>}
   * @throws {TypeError}        If `message` is not a non-empty string.
   * @throws {TypeError}        If `expectedParentHash` is not null or a 64-char hex string.
   * @throws {ConcurrencyError} If `expectedParentHash` doesn't match actual HEAD.
   */
  async commit(message, expectedParentHash = null) {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('NilesKV.commit: message must be a non-empty string');
    }
    if (
      expectedParentHash !== null &&
      (typeof expectedParentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedParentHash))
    ) {
      throw new TypeError(
        'NilesKV.commit: expectedParentHash must be a 64-character hex string or null'
      );
    }

    // OCC guard — read actual HEAD before writing anything.
    if (expectedParentHash !== null) {
      const actualHead = await this.commitManager.readHead();
      if (actualHead !== expectedParentHash) {
        throw new ConcurrencyError();
      }
    }

    // Step 1: sort for deterministic hashing.
    const entries = [...this.state.entries()].sort(([a], [b]) => a.localeCompare(b));

    // Step 2 & 3: persist documents and build state index.
    const blobHashes = [];
    const stateIndex = {};

    for (const [docId, document] of entries) {
      const blobHash = await this.blobStore.save(document);
      blobHashes.push(blobHash);
      stateIndex[docId] = blobHash;
    }

    const stateHash = await this.blobStore.save(stateIndex);

    // Step 5: build field index for O(k) NilesQL queries.
    // Shape: { fieldName: { stringifiedValue: [docId, ...] } }
    // Only top-level primitive fields (string | number | boolean) are indexed;
    // nested objects and arrays are skipped.
    const fieldIndex = {};
    for (const [docId, document] of entries) {
      for (const [field, value] of Object.entries(document)) {
        const t = typeof value;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
        const strVal = String(value);
        if (!fieldIndex[field]) fieldIndex[field] = {};
        if (!fieldIndex[field][strVal]) fieldIndex[field][strVal] = [];
        fieldIndex[field][strVal].push(docId);
      }
    }
    const indexHash = await this.blobStore.save(fieldIndex);

    // Step 6: Merkle root over ordered blob hashes.
    const merkleRoot = MerkleTree.buildTree(blobHashes);

    // Step 7: resolve parent.
    const parentHash = await this.commitManager.readHead();

    // Step 8: create commit and advance HEAD.
    const commit = await this.commitManager.createCommit(
      message,
      merkleRoot,
      parentHash,
      stateHash,
      indexHash,
    );
    await this.commitManager.updateHead(commit.id);

    // Step 9: WAL is now redundant — clear it.
    await this._walClear();

    return { commit, merkleRoot };
  }

  // ---------------------------------------------------------------------------
  // Diff engine
  // ---------------------------------------------------------------------------

  /**
   * Compares the current working state against the committed state at HEAD.
   *
   * @returns {Promise<StatusResult>}
   */
  async status() {
    const headHash = await this.commitManager.readHead();

    const committed = new Map();
    if (headHash !== null) {
      const commit = await this.commitManager.getCommit(headHash);
      if (commit.state_hash) {
        const stateIndex = await this.blobStore.read(commit.state_hash);
        for (const [docId, blobHash] of Object.entries(stateIndex)) {
          committed.set(docId, blobHash);
        }
      }
    }

    const added = [];
    const modified = [];
    const deleted = [];

    for (const [docId, document] of this.state) {
      if (!committed.has(docId)) {
        added.push(docId);
      } else {
        const currentHash = this.blobStore.computeHash(document);
        if (currentHash !== committed.get(docId)) {
          modified.push(docId);
        }
      }
    }

    for (const docId of committed.keys()) {
      if (!this.state.has(docId)) {
        deleted.push(docId);
      }
    }

    return { added, modified, deleted };
  }

  // ---------------------------------------------------------------------------
  // Checkout / branch management
  // ---------------------------------------------------------------------------

  /**
   * Restores the database to a prior commit or branch tip.
   *
   * Uncommitted working-state changes are discarded and the WAL is cleared —
   * equivalent to `git checkout --hard`.
   *
   * @param {string} hash_or_branch - A 64-char commit hash or a branch name.
   * @returns {Promise<import('./CommitManager.js').Commit>}
   * @throws {BranchNotFoundError}   If a named branch does not exist.
   * @throws {CommitNotFoundError}   If the commit file is absent.
   * @throws {UnrestoredCommitError} If the commit has no `state_hash`.
   */
  async checkout(hash_or_branch) {
    let commitHash;
    let isBranch = false;
    let branchName;

    if (/^[a-f0-9]{64}$/.test(hash_or_branch)) {
      commitHash = hash_or_branch;
    } else {
      branchName = hash_or_branch;
      isBranch = true;
      const resolved = await this.commitManager.resolveBranch(branchName);
      if (resolved === null) {
        throw new BranchNotFoundError(branchName);
      }
      commitHash = resolved;
    }

    const commit = await this.commitManager.getCommit(commitHash);

    if (!commit.state_hash) {
      throw new UnrestoredCommitError(commit.id);
    }

    const stateIndex = await this.blobStore.read(commit.state_hash);
    const newState = new Map();
    for (const [docId, blobHash] of Object.entries(stateIndex)) {
      const document = await this.blobStore.read(blobHash);
      newState.set(docId, document);
    }

    this.state = newState;

    if (isBranch) {
      await this.commitManager.switchBranch(branchName);
    } else {
      await this.commitManager.detachHead(commitHash);
    }

    // Discard any uncommitted WAL entries — state is now a clean snapshot.
    await this._walClear();

    return commit;
  }

  /**
   * Creates a new branch pointing at the current HEAD commit.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async createBranch(name) {
    return this.commitManager.createBranch(name);
  }

  // ---------------------------------------------------------------------------
  // Cryptographic inclusion proofs
  // ---------------------------------------------------------------------------

  /**
   * Generates a Merkle inclusion proof proving that `docId` was part of the
   * database state at `commitHash`.
   *
   * The proof can be shared and verified independently by any party that knows
   * the Merkle root (stored in the commit object) — no database access needed
   * for verification.
   *
   * @param {string} commitHash - The commit to prove membership against.
   * @param {string} docId      - The document ID to generate a proof for.
   * @returns {Promise<InclusionProof>}
   * @throws {CommitNotFoundError} If the commit does not exist.
   * @throws {UnrestoredCommitError} If the commit has no `state_hash`.
   * @throws {Error} If `docId` was not part of the specified commit.
   */
  async generateProof(commitHash, docId) {
    const commit = await this.commitManager.getCommit(commitHash);
    if (!commit.state_hash) {
      throw new UnrestoredCommitError(commit.id);
    }

    // Reconstruct the exact leaf ordering used by commit().
    const stateIndex = await this.blobStore.read(commit.state_hash);
    const sortedEntries = Object.entries(stateIndex).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    const docIds = sortedEntries.map(([id]) => id);
    const leafHashes = sortedEntries.map(([, hash]) => hash);
    const leafIndex = docIds.indexOf(docId);

    if (leafIndex === -1) {
      throw new Error(
        `Document "${docId}" was not part of commit ${commitHash.slice(0, 7)}`
      );
    }

    const docHash = stateIndex[docId];
    const proof = MerkleTree.generateProof(leafHashes, leafIndex);

    return {
      docId,
      docHash,
      leafIndex,
      proof,
      rootHash: commit.root_merkle_hash,
      commitHash,
    };
  }

  /**
   * Verifies a Merkle inclusion proof.
   *
   * A pure static function — no database access required.  Any party with the
   * `docHash`, `proof`, and `rootHash` can verify membership offline.
   *
   * @param {string}   docHash  - SHA-256 hash of the document to verify.
   * @param {import('./MerkleTree.js').ProofStep[]} proof
   * @param {string}   rootHash - Merkle root from the commit object.
   * @returns {boolean}
   */
  static verifyProof(docHash, proof, rootHash) {
    return MerkleTree.verifyProof(docHash, proof, rootHash);
  }

  // ---------------------------------------------------------------------------
  // History / metadata
  // ---------------------------------------------------------------------------

  /** @param {number} [limit=10] */
  async getHistory(limit = 10) {
    return this.commitManager.getHistory(limit);
  }

  /** @returns {Promise<string|null>} */
  async currentHead() {
    return this.commitManager.readHead();
  }

  /** @returns {Promise<string|null>} */
  async currentBranch() {
    return this.commitManager.getCurrentBranch();
  }

  // ---------------------------------------------------------------------------
  // Working-state persistence (for CLI usage)
  // ---------------------------------------------------------------------------

  /**
   * Reconstructs `this.state` from the committed HEAD snapshot and then
   * replays any WAL entries that accumulated since the last commit.
   *
   * This is the crash-recovery entry point: call it on startup to restore
   * both the committed baseline and any uncommitted operations that were
   * durably logged to the WAL before a crash.
   *
   * @returns {Promise<void>}
   */
  async loadWorkingState() {
    // Phase 1: reconstruct the committed state from HEAD.
    const headHash = await this.commitManager.readHead();
    this.state = new Map();

    if (headHash !== null) {
      try {
        const commit = await this.commitManager.getCommit(headHash);
        if (commit.state_hash) {
          const stateIndex = await this.blobStore.read(commit.state_hash);
          for (const [docId, blobHash] of Object.entries(stateIndex)) {
            const doc = await this.blobStore.read(blobHash);
            this.state.set(docId, doc);
          }
        }
      } catch {
        // Corrupt or missing commit — start from empty state.
        this.state = new Map();
      }
    }

    // Phase 2: replay uncommitted WAL entries on top.
    await this._replayWAL();
  }

  /**
   * Serialises `this.state` to `.db/WORKING_STATE` for compatibility with
   * external tooling.  Durability is now handled by the WAL — this file is
   * supplementary.
   *
   * @returns {Promise<void>}
   */
  async persistWorkingState() {
    await writeFile(
      this.workingStatePath,
      JSON.stringify([...this.state.entries()]),
      'utf8',
    );
  }
}
