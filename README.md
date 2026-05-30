<<<<<<< HEAD
# NilesKV: A Content-Addressable, Version-Controlled State Engine

**The content-addressable, version-controlled state engine with Merkle inclusion proofs, WAL durability, and Git-style branching.**

NilesKV is a purpose-built document engine in Node.js that layers Git's version-control semantics — content-addressable storage, Merkle tree state hashing, and a branching DAG commit history — directly over a JSON document store.  Every state transition is immutable, tamper-evident, and cryptographically provable.

Built with zero external runtime dependencies.  Pure native Node.js (`fs/promises`, `crypto`, `path`).

---

## Why this exists

Most databases treat history as an afterthought (audit logs, CDC streams).  NilesKV treats **every write as a commit** and every database state as a cryptographically signed snapshot.  This makes the following guarantees:

- **Tamper detection** — the Merkle root of any historical snapshot can be recomputed and compared at any time.  A single altered byte changes every hash in the chain.
- **Point-in-time recovery** — `checkout` restores the exact byte-for-byte state of the database at any prior commit with no WAL replay, no incremental reconstruction.
- **Convergence verification** — two independent nodes that have applied the same sequence of writes will produce identical Merkle roots, enabling consensus without coordination.

---

## Architecture

### System overview

```
┌─────────────────────────────────────────────────────────────────┐
│  NilesKV (Orchestrator)                                           │
│                                                                 │
│  insert(id, doc) ──► this.state : Map<string, object>          │
│                              │                                  │
│                         commit(msg)                             │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         ▼                    ▼                    ▼            │
│    BlobStore           BlobStore            MerkleTree          │
│  save(doc) ──► hash   save(stateIdx) ──►  buildTree([hashes])  │
│  .db/objects/<hash>   .db/objects/<hash>       │               │
│                                                 ▼               │
│                                          root_merkle_hash       │
│                                                 │               │
│                                         CommitManager           │
│                                     createCommit(...)           │
│                                    .db/commits/<hash>.json      │
│                                         updateHead()            │
│                                    .db/refs/heads/main          │
└─────────────────────────────────────────────────────────────────┘
```

### Content-Addressable Storage (BlobStore)

Every JSON document is serialised with **alphabetically sorted keys** at every nesting depth, then hashed with SHA-256.  The hash is the filename.

```
.db/objects/
  4d5a9584d985e8fb...   ← {"age":30,"name":"Alice","role":"engineer"}
  d103cfb5e499c566...   ← {"age":25,"name":"Bob","role":"designer"}
  8361a516595c1a74...   ← {"user:1":"4d5a...","user:2":"d103..."}  (state index)
```

Key properties:

| Property | Guarantee |
|---|---|
| Determinism | `{"z":1,"a":2}` and `{"a":2,"z":1}` produce the **same hash** |
| Deduplication | Identical documents share one file regardless of how many commits reference them |
| Immutability | Files are written once and never modified (content-addressable by design) |
| Integrity | Reading a blob and re-hashing it proves it has not been corrupted |

### Merkle Tree (state fingerprint)

At commit time, blob hashes for all documents (sorted by document ID) are fed into a binary Merkle tree reduction.  The resulting **root hash** uniquely fingerprints the entire database state.

```
Documents (sorted by id):     user:1          user:2          user:3
Blob hashes (leaves):         [h0]            [h1]            [h2]

Level 1:              sha256(h0 ‖ h1)                sha256(h2 ‖ h2)  ← odd node duplicated
                            [h01]                          [h22]

Root:                         sha256(h01 ‖ h22)
                                   [root]
```

Rules:
- Leaves are **ordered by document ID** (lexicographic) — insertion order into the Map never affects the root.
- An empty database hashes to `sha256("EMPTY_DATABASE")`.
- Odd-numbered levels duplicate the last node before hashing (Bitcoin-compatible completion rule).

### Branching Pointer DAG (CommitManager)

The commit history is a Directed Acyclic Graph where each commit node contains:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | SHA-256 of content fields (excluding `id` itself) |
| `timestamp` | `number` | Unix epoch milliseconds |
| `message` | `string` | Human-readable snapshot description |
| `parent_hash` | `string \| null` | Hash of the preceding commit; `null` for root |
| `root_merkle_hash` | `string` | Merkle root — cryptographic fingerprint of state |
| `state_hash` | `string` | BlobStore address of `{ docId → blobHash }` index |

```
.db/
  commits/
    a1b2c3d4...json   ← commit C (HEAD)
    e5f6g7h8...json   ← commit B
    i9j0k1l2...json   ← commit A (root, parent_hash: null)
  refs/
    HEAD              ← "ref: refs/heads/main"
    heads/
      main            ← "a1b2c3d4..."
      feature         ← "e5f6g7h8..."
```

**HEAD pointer semantics** (identical to Git):

| State | HEAD file contains | Commits advance |
|---|---|---|
| Attached (on branch) | `ref: refs/heads/main` | The branch file |
| Detached (specific commit) | `a1b2c3d4...` (raw hash) | HEAD file directly |

### Checkout reconstruction

Because the Merkle reduction is **one-way** (SHA-256 is preimage-resistant), checkout does not reverse the tree.  Instead, each commit stores a `state_hash` pointing to a **state index blob** — a plain JSON object mapping every document ID to its blob hash.  Checkout reads this index and fetches each blob individually from the object store.

This is the exact mechanism Git uses: commits → tree objects → blob objects.

---

## Quick Start

```bash
# Initialise project
git clone <repo>
cd nileskv
npm install

# Run tests (133 passing)
npm test
```

---

## CLI Reference

All commands operate on the `.db/` directory in the current working directory.

### `insert <id> '<json>'`

Stage a document in the working set.  No disk write until `commit`.

```
$ node cli.js insert "user:1" '{"name":"Alice","role":"engineer","age":30}'
+  Staged user:1
```

### `delete <id>`

Stage a deletion from the working set.

```
$ node cli.js delete "user:3"
-  Staged deletion of user:3
```

### `status`

Diff the working set against the HEAD commit.

```
$ node cli.js status
On branch main

Added:
  +  user:3

Modified:
  ~  user:1

Deleted:
  -  user:2
```

| Symbol | Meaning |
|---|---|
| `+` (green) | Present in working state, absent from HEAD |
| `~` (yellow) | Present in both, content hash differs |
| `-` (red) | Present in HEAD, absent from working state |

### `commit "<message>"`

Snapshot the working set: persist blobs → build Merkle tree → write commit → advance HEAD.

```
$ node cli.js commit "add Alice and Bob"
[main] 3b3e7d8  add Alice and Bob
merkle  371e1628d183e574e3a3f446f84ed783...
state   8361a516595c1a748e92b71e3e4d9544...
```

### `branch <name>`

Create a branch pointing at the current HEAD commit.

```
$ node cli.js branch feature
✓  Created branch feature
```

### `checkout <hash_or_branch>`

Restore working state to a prior commit or branch tip.  Wipes any uncommitted changes.

```
# Detached HEAD (commit hash)
$ node cli.js checkout 3b3e7d8aebe7ce40...
Switched to detached HEAD at 3b3e7d8
  initial: add Alice and Bob

# Attached HEAD (branch name)
$ node cli.js checkout feature
Switched to branch feature
  add experimental index
```

### `log [--limit <n>]`

Print a chronological ASCII timeline of the commit DAG.

```
$ node cli.js log
* 927773f (HEAD -> main)  2026-05-11 00:50:30 UTC
|  add Charlie, update Alice
|
* 3b3e7d8  2026-05-11 00:50:25 UTC
|  initial: add Alice and Bob
```

---

## Module API

### `BlobStore`

```js
import { BlobStore } from './src/BlobStore.js';

const store = new BlobStore('.db');
await store.init();

const hash = await store.save({ name: 'Alice', age: 30 });   // SHA-256 hex string
const doc  = await store.read(hash);                          // { age: 30, name: 'Alice' }
const hash2 = store.computeHash({ age: 30, name: 'Alice' }); // same hash, no I/O
```

### `MerkleTree`

```js
import { MerkleTree } from './src/MerkleTree.js';

const root = MerkleTree.buildTree([hashA, hashB, hashC]); // pure synchronous
const emptyRoot = MerkleTree.buildTree([]);               // sha256('EMPTY_DATABASE')
```

### `CommitManager`

```js
import { CommitManager } from './src/CommitManager.js';

const cm = new CommitManager('.db');
await cm.init();

const commit = await cm.createCommit('message', merkleRoot, parentHash, stateHash);
await cm.updateHead(commit.id);         // advances current branch
await cm.createBranch('feature');       // branch at current HEAD
await cm.switchBranch('feature');       // HEAD → ref: refs/heads/feature
await cm.detachHead(commit.id);         // HEAD → raw hash

const history = await cm.getHistory(10); // oldest-first
const branch  = await cm.getCurrentBranch(); // null if detached
```

### `NilesKV`

```js
import { NilesKV } from './src/NilesKV.js';

const db = new NilesKV('.db');
await db.init();

// Working set mutations (in-memory, no I/O)
db.insert('user:1', { name: 'Alice' });
db.delete('user:2');

// Diff
const { added, modified, deleted } = await db.status();

// Snapshot
const { commit, merkleRoot } = await db.commit('add Alice');

// Branch
await db.createBranch('feature');

// Time-machine
await db.checkout('feature');        // branch checkout (attached HEAD)
await db.checkout(commit.id);        // commit checkout (detached HEAD)

// History
const history = await db.getHistory(10); // oldest-first

// Working-state persistence (for CLI / multi-process use)
await db.persistWorkingState();
await db.loadWorkingState();
```

---

## Project Structure

```
nileskv/
├── cli.js                        CLI entry point
├── scripts/
│   └── benchmark.js              Performance benchmark (10k docs, WAL, proofs)
├── src/
│   ├── BlobStore.js              Content-addressable object store
│   ├── MerkleTree.js             Pure synchronous Merkle tree builder + inclusion proofs
│   ├── CommitManager.js          DAG commit history + branch pointer management
│   ├── NilesKV.js                Orchestrator: state → blobs → Merkle → commit
│   ├── blobStore.test.js         19 unit tests
│   ├── merkleTree.test.js        39 unit tests
│   ├── commitManager.test.js     57 unit tests
│   └── nilesKV.integration.test.js 60 integration tests
├── package.json
└── README.md
```

---

## Durability (Write-Ahead Log)

Every `insert()` and `delete()` is durably written to an append-only **WAL** (`.db/wal.log`) *before* the in-memory state is updated, using `appendFileSync` to block until the write is flushed to the kernel buffer.

```
{"op":"insert","id":"user:1","doc":{...},"ts":1747000000000}
{"op":"insert","id":"user:2","doc":{...},"ts":1747000000001}
{"op":"delete","id":"user:2","ts":1747000000002}
```

On startup, `loadWorkingState()` reconstructs the last committed snapshot from the HEAD commit's `state_hash`, then **replays** any unprocessed WAL entries on top.  If the process crashes between an `insert()` call and the subsequent `commit()`, the operation is recovered exactly on restart — zero data loss.

The WAL is **cleared atomically** on every successful `commit()` and `checkout()`.  This means the WAL is only non-empty during the window between a mutation and its commit.

---

## Optimistic Concurrency Control

`commit()` accepts an optional `expectedParentHash` parameter.  When supplied, the engine reads the actual HEAD before writing and throws `ConcurrencyError` if another writer has advanced the branch since the caller last read it.

```js
import { NilesKV, ConcurrencyError } from './src/NilesKV.js';

const db = new NilesKV('.db');
await db.init();

const { commit: c1 } = await db.commit('first write');

db.insert('user:99', { name: 'Eve' });

try {
  // Fails if HEAD has moved since c1 was created
  await db.commit('conditional write', c1.id);
} catch (err) {
  if (err instanceof ConcurrencyError) {
    // Retry with fresh state
  }
}
```

This is the classic [optimistic locking](https://en.wikipedia.org/wiki/Optimistic_concurrency_control) pattern: reads are free, writes validate at commit time, and conflicts are caught rather than prevented with locks.

---

## Cryptographic Merkle Inclusion Proofs

Any document in any historical commit can be proved present without replaying the full database state.  The proof is a compact `O(log n)` array of sibling hashes that, combined with the document hash, recomputes the Merkle root.

```js
import { NilesKV } from './src/NilesKV.js';

const db = new NilesKV('.db');
await db.init();

// Generate proof — reads state_hash blob, sorts leaf order, walks the tree
const result = await db.generateProof(commitHash, 'user:1');
// {
//   docId:       'user:1',
//   docHash:     '4d5a9584d985e8fb...',  // SHA-256 of the document blob
//   leafIndex:   0,
//   proof:       [{ hash: '...', position: 'right' }, ...],
//   rootHash:    'a1b2c3d4...',           // == commit.root_merkle_hash
//   commitHash:  'e5f6g7h8...'
// }

// Verify — pure, offline, no I/O
const valid = NilesKV.verifyProof(result.docHash, result.proof, result.rootHash);
// true
```

Proofs are **offline-verifiable**: the verifier needs only the document content, the proof steps, and the Merkle root from the commit.  No database access required.  A tampered document or forged proof step causes `verifyProof` to return `false`.

### Proof algorithm

```
Leaf hashes (sorted by docId): [h0, h1, h2, h3]    target: index 1 (h1)

Level 0:  [h0,  h1,  h2,  h3]   → sibling of h1 is h0 (position: 'left')
Level 1:  [H01, H23]             → sibling of H01 is H23 (position: 'right')
Level 2:  [root]                 ← stop

proof = [{hash: h0, position: 'left'}, {hash: H23, position: 'right'}]

Verify:
  step 1 (left sibling):  sha256(h0  + h1)  = H01
  step 2 (right sibling): sha256(H01 + H23) = root  ✓
```

---

## Performance Benchmarks

Measured on Apple M-series hardware, Node.js v22.20.0, 10,000-document tree.

```
──────────────────────────────────────────────────────────────────────────────────────────
Operation                          Count     Time (ms)       Ops / sec             Notes
──────────────────────────────────────────────────────────────────────────────────────────
insert() × 10,000 (+ WAL)         10,000       748.78          13,355   in-memory + WAL
commit() 10,000 docs              10,000      1859.50           5,378    root 46cdd0a6…
generateProof() mid-tree leaf          1        56.30              18          14 steps
verifyProof() × 10,000            10,000       132.22          75,632       pure crypto
──────────────────────────────────────────────────────────────────────────────────────────
```

Run it yourself:

```bash
node scripts/benchmark.js
```

Key observations:

| Metric | Result | Explanation |
|---|---|---|
| Insert throughput | ~13,000 ops/sec | Bottleneck is `appendFileSync` WAL durability |
| Commit throughput | ~5,400 docs/sec | BlobStore `writeFile` per unique blob dominates |
| Proof depth | 14 steps | ⌈log₂(10,000)⌉ = 14 — logarithmic with tree size |
| Verify throughput | ~75,000/sec | Pure SHA-256 math, no I/O |

---

## Test Suite

```
Test Suites:  4 passed, 4 total
Tests:        175 passed, 175 total
```

```bash
npm test
```

Tests are written with Jest and cover:
- Key-sort determinism (same object, different insertion order → same hash)
- Merkle edge cases (0, 1, 3, 50 leaves; hardcoded root assertion)
- Odd-node duplication in the Merkle reduction
- Merkle inclusion proof generation and verification (1, 2, 3, 4, 50-leaf trees)
- Tamper detection: forged leaf, forged proof step, wrong root → `false`
- WAL durability: correct entry format, crash recovery (two scenarios), delete replay
- Optimistic concurrency: `ConcurrencyError` fires on stale parent hash, retry succeeds
- Branching: attached/detached HEAD transitions, branch creation and resolution
- Status diff: all three categories (added / modified / deleted) simultaneously
- Point-in-time checkout with state reconstruction verification
- Full DAG traversal with `parent_hash` chain validation
- Error propagation: `BlobNotFoundError`, `CommitNotFoundError`, `HeadNotInitialisedError`, `BranchNotFoundError`, `InvalidDocumentError`, `ConcurrencyError`

---

## Engineering Notes

**Why `state_hash` alongside `root_merkle_hash`?**  The Merkle root is a cryptographic commitment — it proves the state at a given commit hasn't been tampered with.  But SHA-256 is preimage-resistant by design; you cannot reverse a root back to its leaves.  `state_hash` addresses this by storing a `{ docId → blobHash }` index as a first-class blob, exactly as Git stores tree objects.  Two hashes per commit: one for integrity, one for reconstruction.

**Why sort document IDs before building the Merkle tree?**  `Map` preserves insertion order, which is non-deterministic across sessions.  Sorting by `docId` before computing leaf hashes guarantees that the Merkle root is a pure function of the document set, not the order documents were inserted — a critical correctness property for convergence and comparison.  `generateProof()` applies the same sort, so leaf indices are consistent between `commit()` and proof generation.

**Why native `crypto` instead of a hashing library?**  Node's built-in `createHash('sha256')` uses OpenSSL under the hood — the same implementation most production systems rely on.  Adding a wrapper library would introduce a supply-chain dependency for zero algorithmic gain.

**Why `appendFileSync` for the WAL instead of `appendFile` (async)?**  The durability contract requires the WAL entry to be written to the kernel buffer *before* the in-memory state changes.  `appendFileSync` blocks the event loop for the duration of the syscall, making this ordering impossible to violate.  For the WAL's typical payload (one JSON line, ~100 bytes), the blocking window is sub-millisecond.

**Idempotent writes throughout.**  `BlobStore.save()`, `CommitManager.init()`, and `NilesKV.init()` are all safe to call multiple times.  Blob writes check for file existence before writing; directory creation uses `{ recursive: true }`.  This makes the system resilient to interrupted writes and safe to initialise in concurrent environments.

---

## License

ISC
=======
# NilesKV
>>>>>>> c5cf9de4cfbde64040d1740104fe5c527028d740
