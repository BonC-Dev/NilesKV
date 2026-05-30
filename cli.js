#!/usr/bin/env node
/**
 * NilesKV CLI
 *
 * Usage:
 *   node cli.js insert <id> '<json>'
 *   node cli.js delete <id>
 *   node cli.js status
 *   node cli.js commit "<message>"
 *   node cli.js branch <name>
 *   node cli.js checkout <hash_or_branch>
 *   node cli.js log [--limit <n>]
 */

import { join } from 'path';
import { NilesKV, BranchNotFoundError, InvalidDocumentError } from './src/NilesKV.js';
import { CommitNotFoundError, HeadNotInitialisedError } from './src/CommitManager.js';

// ---------------------------------------------------------------------------
// ANSI colour helpers (zero external dependencies)
// ---------------------------------------------------------------------------

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const paint = (color, text) => `${color}${text}${C.reset}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exitError(msg) {
  process.stderr.write(`${paint(C.red, 'error')}  ${msg}\n`);
  process.exit(1);
}

function formatDate(epochMs) {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdInsert(db, [id, jsonStr]) {
  if (!id)     exitError('Usage: node cli.js insert <id> \'<json>\'');
  if (!jsonStr) exitError('Usage: node cli.js insert <id> \'<json>\' — JSON argument is missing');

  let doc;
  try {
    doc = JSON.parse(jsonStr);
  } catch {
    exitError(`Invalid JSON: ${jsonStr}`);
  }

  db.insert(id, doc);
  await db.persistWorkingState();
  console.log(`${paint(C.green, '+')}  Staged ${paint(C.bold, id)}`);
}

async function cmdDelete(db, [id]) {
  if (!id) exitError('Usage: node cli.js delete <id>');
  const existed = db.delete(id);
  if (!existed) {
    exitError(`Document not found in working state: ${id}`);
  }
  await db.persistWorkingState();
  console.log(`${paint(C.red, '-')}  Staged deletion of ${paint(C.bold, id)}`);
}

async function cmdStatus(db) {
  const { added, modified, deleted } = await db.status();

  if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
    console.log(paint(C.dim, 'nothing to commit — working state is clean'));
    return;
  }

  const branch = await db.currentBranch();
  const head   = await db.currentHead();
  const ref    = branch ? `${paint(C.cyan, 'branch')} ${paint(C.bold, branch)}`
                        : `${paint(C.yellow, 'HEAD')} ${head ? head.slice(0, 7) : '(unborn)'}`;
  console.log(`On ${ref}\n`);

  if (added.length > 0) {
    console.log(paint(C.green, 'Added:'));
    for (const id of added.sort()) {
      console.log(`  ${paint(C.green, '+')}  ${id}`);
    }
  }
  if (modified.length > 0) {
    if (added.length > 0) console.log('');
    console.log(paint(C.yellow, 'Modified:'));
    for (const id of modified.sort()) {
      console.log(`  ${paint(C.yellow, '~')}  ${id}`);
    }
  }
  if (deleted.length > 0) {
    if (added.length > 0 || modified.length > 0) console.log('');
    console.log(paint(C.red, 'Deleted:'));
    for (const id of deleted.sort()) {
      console.log(`  ${paint(C.red, '-')}  ${id}`);
    }
  }
}

async function cmdCommit(db, args) {
  const message = args.join(' ');
  if (!message.trim()) exitError('Usage: node cli.js commit "<message>"');

  const { commit, merkleRoot } = await db.commit(message);
  await db.persistWorkingState();

  const branch = await db.currentBranch();
  const ref    = branch ? paint(C.cyan, branch) : paint(C.yellow, 'HEAD (detached)');
  const short  = commit.id.slice(0, 7);

  console.log(`[${ref}] ${paint(C.bold, short)}  ${message}`);
  console.log(paint(C.dim, `merkle  ${merkleRoot}`));
  console.log(paint(C.dim, `state   ${commit.state_hash}`));
}

async function cmdBranch(db, [name]) {
  if (!name) exitError('Usage: node cli.js branch <name>');
  await db.createBranch(name);
  console.log(`${paint(C.green, '✓')}  Created branch ${paint(C.bold, name)}`);
}

async function cmdCheckout(db, [target]) {
  if (!target) exitError('Usage: node cli.js checkout <hash_or_branch>');
  const commit = await db.checkout(target);
  await db.persistWorkingState();

  const branch = await db.currentBranch();
  const ref    = branch ? `branch ${paint(C.bold, branch)}`
                        : `detached HEAD at ${paint(C.bold, commit.id.slice(0, 7))}`;
  console.log(`${paint(C.green, 'Switched to')} ${ref}`);
  console.log(paint(C.dim, `  ${commit.message}`));
}

async function cmdLog(db, args) {
  const limitIndex = args.indexOf('--limit');
  const limit      = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 20;
  if (isNaN(limit) || limit < 1) exitError('--limit must be a positive integer');

  let history;
  try {
    history = await db.getHistory(limit);
  } catch (err) {
    if (err instanceof HeadNotInitialisedError) {
      console.log(paint(C.dim, 'No commits yet'));
      return;
    }
    throw err;
  }

  const headHash = await db.currentHead();
  const branch   = await db.currentBranch();

  // Print newest first.
  const display = [...history].reverse();

  for (let i = 0; i < display.length; i++) {
    const commit  = display[i];
    const isHead  = commit.id === headHash;
    const shortId = paint(C.yellow, commit.id.slice(0, 7));
    const date    = paint(C.dim, formatDate(commit.timestamp));

    let refs = '';
    if (isHead) {
      const ptr = branch
        ? `HEAD ${paint(C.dim, '->')} ${paint(C.bold + C.cyan, branch)}`
        : 'HEAD';
      refs = ` ${paint(C.cyan, `(${ptr})`)}`;
    }

    console.log(`${paint(C.yellow, '*')} ${shortId}${refs}  ${date}`);
    console.log(`${paint(C.dim, '|')}  ${commit.message}`);
    if (i < display.length - 1) {
      console.log(paint(C.dim, '|'));
    }
  }

  if (history.length === limit) {
    console.log(paint(C.dim, `\n(showing ${limit} commits — use --limit <n> for more)`));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const dbRoot  = join(process.cwd(), '.db');
  const db      = new NilesKV(dbRoot);

  await db.init();
  await db.loadWorkingState();

  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'insert':   await cmdInsert(db, args);   break;
    case 'delete':   await cmdDelete(db, args);   break;
    case 'status':   await cmdStatus(db);         break;
    case 'commit':   await cmdCommit(db, args);   break;
    case 'branch':   await cmdBranch(db, args);   break;
    case 'checkout': await cmdCheckout(db, args); break;
    case 'log':      await cmdLog(db, args);      break;

    case undefined:
    case '--help':
    case 'help':
      console.log([
        '',
        `  ${paint(C.bold, 'NilesKV')} — cryptographically verifiable version-controlled database`,
        '',
        `  ${paint(C.cyan, 'Commands:')}`,
        `    insert   <id> '<json>'        Stage a document`,
        `    delete   <id>                 Stage a deletion`,
        `    status                        Show staged changes vs HEAD`,
        `    commit   "<message>"          Snapshot working state into a commit`,
        `    branch   <name>               Create a branch at current HEAD`,
        `    checkout <hash_or_branch>     Restore state from a commit or branch`,
        `    log      [--limit <n>]        Show commit timeline`,
        '',
      ].join('\n'));
      break;

    default:
      exitError(`Unknown command: ${paint(C.bold, command)}\nRun ${paint(C.bold, 'node cli.js help')} to see available commands.`);
  }
}

main().catch((err) => {
  if (err instanceof InvalidDocumentError ||
      err instanceof BranchNotFoundError  ||
      err instanceof CommitNotFoundError  ||
      err instanceof HeadNotInitialisedError) {
    exitError(err.message);
  }
  // Unexpected errors get the full stack trace.
  process.stderr.write(`${paint(C.red, 'fatal')}  ${err.stack ?? err.message}\n`);
  process.exit(1);
});
