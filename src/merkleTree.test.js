import { createHash } from 'crypto';
import { MerkleTree } from './MerkleTree.js';

/** Convenience wrapper matching the engine's own sha256 function. */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Pre-computed leaf hashes used throughout the suite.
const LEAF = {
  h0: sha256('leaf0'), // 4d5a9584d985e8fb44015a8affa9b76f1ff16f65e61df7156d8e8159e1448978
  h1: sha256('leaf1'), // d103cfb5e499c566904787533afbdec56f95492d67fc00e2c0d0161ba99653f1
  h2: sha256('leaf2'), // 5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a
};

// ---------------------------------------------------------------------------
// Edge case: empty input
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 0 leaves', () => {
  test('returns sha256("EMPTY_DATABASE") for an empty array', () => {
    const expected = '1b0dbb415086cee3c027c30779f64037d28bf63b5210e7f1abeee53d08c5491d';
    expect(MerkleTree.buildTree([])).toBe(expected);
  });

  test('empty result equals sha256("EMPTY_DATABASE") computed locally', () => {
    expect(MerkleTree.buildTree([])).toBe(sha256('EMPTY_DATABASE'));
  });
});

// ---------------------------------------------------------------------------
// Edge case: single leaf
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 1 leaf', () => {
  test('single leaf is paired with itself: root = sha256(leaf + leaf)', () => {
    const expected = sha256(LEAF.h0 + LEAF.h0);
    expect(MerkleTree.buildTree([LEAF.h0])).toBe(expected);
  });

  test('hardcoded 1-leaf root matches pre-computed value', () => {
    // e6acb23132a4f308a9ad6f5fd1021e8b4ef0238f55eec7b2e92726801aaba583
    const expected = 'e6acb23132a4f308a9ad6f5fd1021e8b4ef0238f55eec7b2e92726801aaba583';
    expect(MerkleTree.buildTree([LEAF.h0])).toBe(expected);
  });

  test('returns a 64-character hex string', () => {
    expect(MerkleTree.buildTree([LEAF.h0])).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 3-leaf: hardcoded root proves algorithm correctness
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 3 leaves (hardcoded root assertion)', () => {
  /**
   * Manual derivation of the 3-leaf root:
   *
   *   Level 0 (leaves): [h0, h1, h2]
   *   Level 1:          [sha256(h0+h1), sha256(h2+h2)]   ← h2 duplicated
   *   Level 2 (root):   sha256(level1[0] + level1[1])
   *
   * Hardcoded: 2486eb950a0dac62332dc453316fd6aceb8ee50ca0515f3536bb297ceb401fc2
   */
  const KNOWN_3_LEAF_ROOT = '2486eb950a0dac62332dc453316fd6aceb8ee50ca0515f3536bb297ceb401fc2';

  test('matches hardcoded root for [h0, h1, h2]', () => {
    expect(MerkleTree.buildTree([LEAF.h0, LEAF.h1, LEAF.h2])).toBe(KNOWN_3_LEAF_ROOT);
  });

  test('matches manually re-derived root step-by-step', () => {
    const level1a = sha256(LEAF.h0 + LEAF.h1);
    const level1b = sha256(LEAF.h2 + LEAF.h2); // odd node duplicated
    const root = sha256(level1a + level1b);
    expect(MerkleTree.buildTree([LEAF.h0, LEAF.h1, LEAF.h2])).toBe(root);
  });

  test('root is a 64-character hex string', () => {
    expect(MerkleTree.buildTree([LEAF.h0, LEAF.h1, LEAF.h2])).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 2-leaf sanity check
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 2 leaves', () => {
  test('root = sha256(h0 + h1) for exactly two leaves', () => {
    const expected = sha256(LEAF.h0 + LEAF.h1);
    expect(MerkleTree.buildTree([LEAF.h0, LEAF.h1])).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 4-leaf: perfect binary tree (no duplication needed)
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 4 leaves', () => {
  test('root matches manual two-level derivation', () => {
    const h3 = sha256('leaf3');
    const l1a = sha256(LEAF.h0 + LEAF.h1);
    const l1b = sha256(LEAF.h2 + h3);
    const root = sha256(l1a + l1b);
    expect(MerkleTree.buildTree([LEAF.h0, LEAF.h1, LEAF.h2, h3])).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// 50-leaf: scale test
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — 50 leaves', () => {
  /** Generate 50 deterministic leaf hashes. */
  const leaves50 = Array.from({ length: 50 }, (_, i) => sha256(`leaf-${i}`));

  test('returns a 64-character hex string', () => {
    expect(MerkleTree.buildTree(leaves50)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('is deterministic: two calls with the same leaves return the same root', () => {
    const root1 = MerkleTree.buildTree(leaves50);
    const root2 = MerkleTree.buildTree(leaves50);
    expect(root1).toBe(root2);
  });

  test('different leaf order produces a different root', () => {
    const reversed = leaves50.slice().reverse();
    expect(MerkleTree.buildTree(leaves50)).not.toBe(MerkleTree.buildTree(reversed));
  });

  test('adding one more leaf changes the root', () => {
    const root50 = MerkleTree.buildTree(leaves50);
    const root51 = MerkleTree.buildTree([...leaves50, sha256('leaf-50')]);
    expect(root50).not.toBe(root51);
  });
});

// ---------------------------------------------------------------------------
// Immutability: input array must not be mutated
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — input array immutability', () => {
  test('does not mutate the original hashes array', () => {
    const input = [LEAF.h0, LEAF.h1, LEAF.h2];
    const copy = input.slice();
    MerkleTree.buildTree(input);
    expect(input).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Determinism across different call sites
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — determinism', () => {
  test('same leaves always yield the same root regardless of call count', () => {
    const leaves = [LEAF.h0, LEAF.h1];
    const results = Array.from({ length: 10 }, () => MerkleTree.buildTree(leaves));
    expect(new Set(results).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('MerkleTree.buildTree() — input validation', () => {
  test('throws TypeError when argument is not an array', () => {
    expect(() => MerkleTree.buildTree(null)).toThrow(TypeError);
    expect(() => MerkleTree.buildTree('string')).toThrow(TypeError);
    expect(() => MerkleTree.buildTree(42)).toThrow(TypeError);
    expect(() => MerkleTree.buildTree({ length: 1 })).toThrow(TypeError);
  });

  test('throws TypeError when a leaf is not a 64-char hex string', () => {
    expect(() => MerkleTree.buildTree(['tooshort'])).toThrow(TypeError);
    expect(() => MerkleTree.buildTree([LEAF.h0, ''])).toThrow(TypeError);
    expect(() => MerkleTree.buildTree([LEAF.h0, 'z'.repeat(64)])).toThrow(TypeError); // non-hex
    expect(() => MerkleTree.buildTree([LEAF.h0, null])).toThrow(TypeError);
  });

  test('TypeError message identifies the offending index', () => {
    let caught;
    try { MerkleTree.buildTree([LEAF.h0, 'bad']); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toContain('index 1');
  });
});

// ---------------------------------------------------------------------------
// MerkleTree.generateProof() — proof construction
// ---------------------------------------------------------------------------

describe('MerkleTree.generateProof()', () => {
  test('returns an array of proof steps for a 4-leaf tree', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2, sha256('leaf3')];
    const proof = MerkleTree.generateProof(leaves, 1);
    expect(Array.isArray(proof)).toBe(true);
    expect(proof).toHaveLength(2); // log2(4) = 2 levels
    expect(proof[0]).toHaveProperty('hash');
    expect(proof[0]).toHaveProperty('position');
  });

  test('each step has a valid 64-char hash and a left/right position', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2, sha256('leaf3')];
    const proof = MerkleTree.generateProof(leaves, 0);
    for (const step of proof) {
      expect(step.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(['left', 'right']).toContain(step.position);
    }
  });

  test('proof for every leaf in a 4-leaf tree is verified by verifyProof', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2, sha256('leaf3')];
    const root = MerkleTree.buildTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = MerkleTree.generateProof(leaves, i);
      expect(MerkleTree.verifyProof(leaves[i], proof, root)).toBe(true);
    }
  });

  test('handles a 3-leaf (odd) tree — all proofs verify', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2];
    const root = MerkleTree.buildTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = MerkleTree.generateProof(leaves, i);
      expect(MerkleTree.verifyProof(leaves[i], proof, root)).toBe(true);
    }
  });

  test('handles a 1-leaf tree — proof verifies against sha256(leaf+leaf)', () => {
    const leaves = [LEAF.h0];
    const root = MerkleTree.buildTree(leaves);
    const proof = MerkleTree.generateProof(leaves, 0);
    expect(MerkleTree.verifyProof(LEAF.h0, proof, root)).toBe(true);
  });

  test('handles a 2-leaf tree', () => {
    const leaves = [LEAF.h0, LEAF.h1];
    const root = MerkleTree.buildTree(leaves);
    expect(MerkleTree.verifyProof(LEAF.h0, MerkleTree.generateProof(leaves, 0), root)).toBe(true);
    expect(MerkleTree.verifyProof(LEAF.h1, MerkleTree.generateProof(leaves, 1), root)).toBe(true);
  });

  test('handles a 50-leaf tree — all proofs verify', () => {
    const leaves50 = Array.from({ length: 50 }, (_, i) => sha256(`leaf-${i}`));
    const root = MerkleTree.buildTree(leaves50);
    // Spot-check boundary indices
    for (const i of [0, 1, 24, 25, 48, 49]) {
      const proof = MerkleTree.generateProof(leaves50, i);
      expect(MerkleTree.verifyProof(leaves50[i], proof, root)).toBe(true);
    }
  });

  test('throws RangeError for an empty array', () => {
    expect(() => MerkleTree.generateProof([], 0)).toThrow(RangeError);
  });

  test('throws RangeError for leafIndex out of range', () => {
    const leaves = [LEAF.h0, LEAF.h1];
    expect(() => MerkleTree.generateProof(leaves, 2)).toThrow(RangeError);
    expect(() => MerkleTree.generateProof(leaves, -1)).toThrow(RangeError);
    expect(() => MerkleTree.generateProof(leaves, 1.5)).toThrow(RangeError);
  });

  test('throws TypeError for a non-array argument', () => {
    expect(() => MerkleTree.generateProof(null, 0)).toThrow(TypeError);
    expect(() => MerkleTree.generateProof('string', 0)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// MerkleTree.verifyProof() — proof verification
// ---------------------------------------------------------------------------

describe('MerkleTree.verifyProof()', () => {
  test('returns false for a tampered leaf hash', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2, sha256('leaf3')];
    const root = MerkleTree.buildTree(leaves);
    const proof = MerkleTree.generateProof(leaves, 1);
    const tampered = sha256('totally different document');
    expect(MerkleTree.verifyProof(tampered, proof, root)).toBe(false);
  });

  test('returns false for a wrong root hash', () => {
    const leaves = [LEAF.h0, LEAF.h1];
    const root = MerkleTree.buildTree(leaves);
    const proof = MerkleTree.generateProof(leaves, 0);
    const wrongRoot = sha256('not the real root');
    expect(MerkleTree.verifyProof(LEAF.h0, proof, wrongRoot)).toBe(false);
  });

  test('returns false for a tampered proof step hash', () => {
    const leaves = [LEAF.h0, LEAF.h1, LEAF.h2];
    const root = MerkleTree.buildTree(leaves);
    const proof = MerkleTree.generateProof(leaves, 0);
    const tamperedProof = [{ hash: sha256('forged sibling'), position: proof[0].position }, ...proof.slice(1)];
    expect(MerkleTree.verifyProof(LEAF.h0, tamperedProof, root)).toBe(false);
  });

  test('returns false for an invalid leafHash', () => {
    expect(MerkleTree.verifyProof('invalid', [], sha256('root'))).toBe(false);
    expect(MerkleTree.verifyProof(null, [], sha256('root'))).toBe(false);
  });

  test('returns false for an invalid rootHash', () => {
    expect(MerkleTree.verifyProof(LEAF.h0, [], 'bad-root')).toBe(false);
  });

  test('returns false for non-array proof', () => {
    expect(MerkleTree.verifyProof(LEAF.h0, null, sha256('root'))).toBe(false);
  });

  test('returns false for a proof step with an invalid hash', () => {
    const root = sha256('root');
    const badProof = [{ hash: 'not-hex', position: 'right' }];
    expect(MerkleTree.verifyProof(LEAF.h0, badProof, root)).toBe(false);
  });

  test('returns false for a proof step with an invalid position', () => {
    const root = sha256('root');
    const badProof = [{ hash: LEAF.h1, position: 'up' }];
    expect(MerkleTree.verifyProof(LEAF.h0, badProof, root)).toBe(false);
  });
});
