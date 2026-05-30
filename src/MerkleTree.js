import { createHash } from 'crypto';

/**
 * Computes the SHA-256 hex digest of a UTF-8 string.
 *
 * @param {string} input
 * @returns {string} 64-character lowercase hex digest.
 */
function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Validates that a value is a 64-character lowercase hex string.
 *
 * @param {unknown} value
 * @param {number} index - Position in the input array (for error messages).
 * @throws {TypeError}
 */
function assertValidHash(value, index) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(
      `MerkleTree.buildTree: element at index ${index} is not a valid SHA-256 hex hash, got: ${JSON.stringify(value)}`
    );
  }
}

/**
 * Reduces one level of a Merkle tree by pairing adjacent hashes and hashing
 * each pair.  The last node is duplicated when the count is odd.
 *
 * @param {string[]} level - Current array of hashes (already validated).
 * @returns {string[]} Next level — always ⌈level.length / 2⌉ elements.
 */
function reduceLevel(level) {
  const nextLevel = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i];
    const right = level[i + 1] ?? left; // duplicate last node for odd-length levels
    nextLevel.push(sha256(left + right));
  }
  return nextLevel;
}

/**
 * @typedef {object} ProofStep
 * @property {string} hash     - The sibling hash at this level.
 * @property {'left'|'right'} position - Whether the sibling is to the left or right
 *   of the current node.  Used by `verifyProof` to determine concatenation order.
 */

/**
 * Mathematically pure, synchronous Merkle tree builder with inclusion proof support.
 *
 * ### Algorithm
 * 1. Validate every leaf is a 64-character hex string.
 * 2. Empty input → SHA-256("EMPTY_DATABASE").
 * 3. Pair adjacent leaves; if the count is odd, duplicate the last leaf.
 * 4. Hash each pair → next level.  Repeat until one hash remains (the root).
 *
 * @example
 * const root  = MerkleTree.buildTree([hashA, hashB, hashC]);
 * const proof = MerkleTree.generateProof([hashA, hashB, hashC], 0);
 * const valid = MerkleTree.verifyProof(hashA, proof, root); // true
 */
export class MerkleTree {
  /**
   * Builds a Merkle tree and returns the root hash.
   *
   * @param {string[]} hashes - Leaf hashes.  Order matters.
   * @returns {string} The Merkle root — a 64-character SHA-256 hex string.
   * @throws {TypeError} If any element is not a valid 64-character hex hash,
   *   or if `hashes` is not an array.
   */
  static buildTree(hashes) {
    if (!Array.isArray(hashes)) {
      throw new TypeError('MerkleTree.buildTree: argument must be an array');
    }

    hashes.forEach(assertValidHash);

    if (hashes.length === 0) {
      return sha256('EMPTY_DATABASE');
    }

    if (hashes.length === 1) {
      return sha256(hashes[0] + hashes[0]);
    }

    let level = hashes.slice();
    while (level.length > 1) {
      level = reduceLevel(level);
    }

    return level[0];
  }

  /**
   * Generates a Merkle inclusion proof for the leaf at `leafIndex`.
   *
   * The proof is an ordered array of `ProofStep` objects.  Starting from the
   * leaf hash, each step records the sibling hash and its position.  Feeding
   * the leaf hash and this proof into `verifyProof` reproduces the root.
   *
   * ### Complexity
   * O(n) time to build all intermediate levels; O(log n) for the proof itself.
   *
   * @param {string[]} hashes    - The same leaf array used with `buildTree`.
   * @param {number}   leafIndex - Zero-based index of the target leaf.
   * @returns {ProofStep[]} Ordered proof steps from leaf to root.
   * @throws {TypeError}   If `hashes` is not an array or contains invalid hashes.
   * @throws {RangeError}  If `hashes` is empty or `leafIndex` is out of range.
   *
   * @example
   * const proof = MerkleTree.generateProof([h0, h1, h2], 2);
   * // proof[0] = {hash: h2, position: 'right'}  (h2 pairs with itself, odd)
   * // proof[1] = {hash: sha256(h0+h1), position: 'left'}
   */
  static generateProof(hashes, leafIndex) {
    if (!Array.isArray(hashes)) {
      throw new TypeError('MerkleTree.generateProof: hashes must be an array');
    }
    if (hashes.length === 0) {
      throw new RangeError('MerkleTree.generateProof: cannot generate proof for an empty tree');
    }
    hashes.forEach(assertValidHash);
    if (
      !Number.isInteger(leafIndex) ||
      leafIndex < 0 ||
      leafIndex >= hashes.length
    ) {
      throw new RangeError(
        `MerkleTree.generateProof: leafIndex ${leafIndex} is out of range [0, ${hashes.length - 1}]`
      );
    }

    const proof = [];
    let level = hashes.slice();
    let idx = leafIndex;

    // A single leaf pairs with itself once to become the root.
    if (level.length === 1) {
      proof.push({ hash: level[0], position: 'right' });
      return proof;
    }

    while (level.length > 1) {
      if (idx % 2 === 0) {
        // Current node is the LEFT of its pair.
        // Sibling is to the RIGHT; if none exists, the current node is its own sibling.
        const siblingHash =
          idx + 1 < level.length ? level[idx + 1] : level[idx];
        proof.push({ hash: siblingHash, position: 'right' });
      } else {
        // Current node is the RIGHT of its pair — sibling is always to the LEFT.
        proof.push({ hash: level[idx - 1], position: 'left' });
      }

      level = reduceLevel(level);
      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  /**
   * Verifies a Merkle inclusion proof.
   *
   * Applies each proof step to combine `leafHash` with sibling hashes up the
   * tree.  If the final value equals `rootHash`, the document was included in
   * the committed state represented by that root.
   *
   * @param {string}     leafHash - SHA-256 hash of the document being proved.
   * @param {ProofStep[]} proof   - The proof array returned by `generateProof`.
   * @param {string}     rootHash - The Merkle root to verify against.
   * @returns {boolean} `true` if the document is provably in the tree, `false` otherwise.
   *
   * @example
   * MerkleTree.verifyProof(docHash, proof, commit.root_merkle_hash); // true or false
   */
  static verifyProof(leafHash, proof, rootHash) {
    if (typeof leafHash !== 'string' || !/^[a-f0-9]{64}$/.test(leafHash)) {
      return false;
    }
    if (!Array.isArray(proof)) {
      return false;
    }
    if (typeof rootHash !== 'string' || !/^[a-f0-9]{64}$/.test(rootHash)) {
      return false;
    }

    let current = leafHash;

    for (const step of proof) {
      if (!step || typeof step !== 'object') return false;
      if (typeof step.hash !== 'string' || !/^[a-f0-9]{64}$/.test(step.hash)) {
        return false;
      }
      if (step.position !== 'left' && step.position !== 'right') return false;

      if (step.position === 'left') {
        // Sibling is LEFT of current: sha256(sibling + current)
        current = sha256(step.hash + current);
      } else {
        // Sibling is RIGHT of current: sha256(current + sibling)
        current = sha256(current + step.hash);
      }
    }

    return current === rootHash;
  }
}
