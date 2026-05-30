#!/usr/bin/env node
/**
 * NilesKV Performance Benchmark
 *
 * Measures:
 *   1. Insert throughput    — 10,000 in-memory document insertions with WAL
 *   2. Commit throughput    — Merkle tree construction + BlobStore flush for 10,000 docs
 *   3. Proof generation     — Merkle inclusion proof generation for a mid-tree leaf
 *   4. Proof verification   — Cryptographic proof verification
 *
 * Output: ASCII table to stdout.
 * Leaves no artefacts: .benchmark_db is removed before and after.
 */

import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { NilesKV } from '../src/NilesKV.js';

const DB_ROOT = join(process.cwd(), '.benchmark_db');
const N = 10_000;

// ─── helpers ────────────────────────────────────────────────────────────────

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return s * 1e3 + ns / 1e6;
}

function opsPerSec(count, ms) {
  return Math.round(count / (ms / 1000));
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function row(label, n, ms, extra = '') {
  const ops = opsPerSec(n, ms);
  return [
    label.padEnd(28),
    fmt(n).padStart(10),
    ms.toFixed(2).padStart(12),
    fmt(ops).padStart(14),
    extra.padStart(16),
  ].join('  ');
}

function printTable(rows) {
  const header = [
    'Operation'.padEnd(28),
    'Count'.padStart(10),
    'Time (ms)'.padStart(12),
    'Ops / sec'.padStart(14),
    'Notes'.padStart(16),
  ].join('  ');
  const rule = '─'.repeat(header.length);
  console.log('\n' + rule);
  console.log(header);
  console.log(rule);
  for (const r of rows) console.log(r);
  console.log(rule + '\n');
}

// ─── benchmark ──────────────────────────────────────────────────────────────

async function run() {
  // Clean slate
  await rm(DB_ROOT, { recursive: true, force: true });

  const db = new NilesKV(DB_ROOT);
  await db.init();

  const results = [];

  // 1. Insert throughput ─────────────────────────────────────────────────────
  const t1 = process.hrtime();
  for (let i = 0; i < N; i++) {
    db.insert(`doc:${i}`, {
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      score: Math.random(),
      active: i % 2 === 0,
    });
  }
  const ms1 = hrMs(t1);
  results.push(row('insert() × 10,000 (+ WAL)', N, ms1, 'in-memory + WAL'));

  // 2. Commit throughput (Merkle + BlobStore) ─────────────────────────────────
  const t2 = process.hrtime();
  const { commit } = await db.commit('benchmark: 10k documents');
  const ms2 = hrMs(t2);
  results.push(row('commit() 10,000 docs', N, ms2, `root ${commit.root_merkle_hash.slice(0, 8)}…`));

  // 3. Proof generation ──────────────────────────────────────────────────────
  const midDoc = `doc:${Math.floor(N / 2)}`;
  const t3 = process.hrtime();
  const proofResult = await db.generateProof(commit.id, midDoc);
  const ms3 = hrMs(t3);
  results.push(row('generateProof() mid-tree leaf', 1, ms3, `${proofResult.proof.length} steps`));

  // 4. Proof verification ────────────────────────────────────────────────────
  const { docHash, proof, rootHash } = proofResult;
  const VERIFY_ROUNDS = 10_000;
  const t4 = process.hrtime();
  for (let i = 0; i < VERIFY_ROUNDS; i++) {
    NilesKV.verifyProof(docHash, proof, rootHash);
  }
  const ms4 = hrMs(t4);
  results.push(row('verifyProof() × 10,000', VERIFY_ROUNDS, ms4, 'pure crypto'));

  printTable(results);

  // System info
  console.log(`Node.js ${process.version}  │  Platform: ${process.platform}  │  Docs in tree: ${fmt(N)}`);
  console.log(`Merkle root: ${commit.root_merkle_hash}`);
  console.log(`Proof steps for ${midDoc}: ${proofResult.proof.length}  (leaf index ${proofResult.leafIndex})\n`);

  // Cleanup
  await rm(DB_ROOT, { recursive: true, force: true });
}

run().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
