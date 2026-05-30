/**
 * NilesKV Public API Server
 *
 * A secure, thin Express layer exposing NilesKV over HTTP.
 * Security stack: helmet (headers) + express-rate-limit (throttle) + payload cap.
 * Durability:     node-cron checks free disk hourly; wipes .db/ only when free
 *                 space drops below 1 GB so NilesTime retains full history.
 */

import express        from 'express';
import helmet         from 'helmet';
import rateLimit      from 'express-rate-limit';
import cron           from 'node-cron';
import { rm, statfs } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join as pathJoin } from 'path';
import { NilesKV }    from './src/NilesKV.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '.db';

// ---------------------------------------------------------------------------
// Database — single shared instance
// ---------------------------------------------------------------------------

let db = new NilesKV(DB_PATH);
await db.init();

// Guard flag: blocks writes during the 48-hour wipe so no request lands
// mid-reset and corrupts state.
let wiping = false;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// --- Security headers (CSP, X-Frame-Options, HSTS, etc.) ---
app.use(helmet({
  contentSecurityPolicy: false, // Disabled so the frontend can load Google Fonts / inline scripts
}));

// --- Serve static frontend from /public ---
app.use(express.static(pathJoin(__dirname, 'public')));

// --- Block bodies larger than 5 KB ---
app.use(express.json({ limit: '5kb' }));

// --- Rate limiter: 30 requests / minute / IP ---
const limiter = rateLimit({
  windowMs:         60 * 1000,   // 1 minute
  max:              30,
  standardHeaders:  true,         // Return RateLimit-* headers
  legacyHeaders:    false,
  message: {
    error:   'Too Many Requests',
    message: 'You have exceeded 30 requests per minute. Please slow down.',
    retryAfter: '60 seconds',
  },
});
app.use(limiter);

// --- Wipe guard middleware: 503 during reset ---
app.use((req, res, next) => {
  if (wiping) {
    return res.status(503).json({
      error:   'Service Temporarily Unavailable',
      message: 'The database is being reset. Please retry in a few seconds.',
    });
  }
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /
 * Health check — confirms the API is alive and returns basic info.
 */
app.get('/', (_req, res) => {
  res.json({
    name:        'NilesKV API',
    version:     '1.5.0',
    description: 'Content-addressable, version-controlled document store',
    endpoints: {
      'POST /insert':        'Stage a document (does not commit)',
      'POST /commit':        'Snapshot staged state → returns Merkle root',
      'GET  /document/:id':  'Retrieve a document from working state',
      'GET  /proof/:id':     'Cryptographic Merkle inclusion proof for a document',
      'GET  /history':       'Recent commit log',
    },
    status: 'operational',
  });
});

/**
 * POST /insert
 * Body: { id: string, doc: object }
 * Stages a document into working state. Does NOT commit.
 */
app.post('/insert', (req, res) => {
  const { id, doc } = req.body ?? {};

  if (typeof id !== 'string' || id.trim().length === 0) {
    return res.status(400).json({
      error:   'Bad Request',
      message: 'Field "id" must be a non-empty string.',
    });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return res.status(400).json({
      error:   'Bad Request',
      message: 'Field "doc" must be a plain JSON object.',
    });
  }

  // Hard cap: document keys + values must be reasonable in size.
  // The 5 KB body limit already covers most abuse; this is an extra guard.
  if (Object.keys(doc).length > 50) {
    return res.status(400).json({
      error:   'Bad Request',
      message: 'Document may not have more than 50 top-level keys.',
    });
  }

  try {
    db.insert(id.trim(), doc);
    return res.status(200).json({
      ok:      true,
      message: `Document "${id.trim()}" staged successfully.`,
      hint:    'Call POST /commit to persist this to a snapshot.',
    });
  } catch (err) {
    return res.status(400).json({ error: 'Bad Request', message: err.message });
  }
});

/**
 * POST /commit
 * Body: { message: string }
 * Commits the current working state. Returns the new Merkle root and commit id.
 */
app.post('/commit', async (req, res) => {
  const { message } = req.body ?? {};

  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error:   'Bad Request',
      message: 'Field "message" must be a non-empty string.',
    });
  }
  if (message.length > 200) {
    return res.status(400).json({
      error:   'Bad Request',
      message: 'Commit message must be 200 characters or fewer.',
    });
  }

  try {
    const { commit, merkleRoot } = await db.commit(message.trim());
    return res.status(200).json({
      ok:          true,
      commitId:    commit.id,
      merkleRoot,
      parentHash:  commit.parent_hash,
      stateHash:   commit.state_hash,
      timestamp:   commit.timestamp,
      message:     commit.message,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /document/:id
 * Returns the current working-state value of a document.
 */
app.get('/document/:id', (req, res) => {
  const id  = req.params.id;
  const doc = db.get(id);

  if (doc === undefined) {
    return res.status(404).json({
      error:   'Not Found',
      message: `No document found with id "${id}" in the current working state.`,
    });
  }

  return res.status(200).json({ ok: true, id, doc });
});

/**
 * GET /proof/:id
 * Generates and returns a Merkle inclusion proof for the given document id,
 * based on the most recent commit.
 */
app.get('/proof/:id', async (req, res) => {
  const docId = req.params.id;

  // Resolve the latest commit hash.
  const headHash = await db.currentHead();
  if (!headHash) {
    return res.status(404).json({
      error:   'Not Found',
      message: 'No commits exist yet. Insert documents and call POST /commit first.',
    });
  }

  try {
    const proof = await db.generateProof(headHash, docId);
    const valid  = NilesKV.verifyProof(proof.docHash, proof.proof, proof.rootHash);

    return res.status(200).json({
      ok: true,
      ...proof,
      verified: valid,
      explanation: {
        what:  'This proof cryptographically demonstrates that the document was included in the committed database state.',
        how:   `Combine the docHash with each sibling in "proof" (respecting "position") using SHA-256. The final hash must equal "rootHash".`,
        steps: proof.proof.length,
      },
    });
  } catch (err) {
    if (err.message.includes('was not part of commit')) {
      return res.status(404).json({
        error:   'Not Found',
        message: `Document "${docId}" was not part of the latest commit. It may be staged but not yet committed.`,
      });
    }
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /history
 * Returns the last 10 commits in chronological order.
 */
app.get('/history', async (_req, res) => {
  try {
    const history = await db.getHistory(10);
    return res.status(200).json({
      ok:      true,
      count:   history.length,
      commits: history.map(c => ({
        id:         c.id,
        message:    c.message,
        merkleRoot: c.root_merkle_hash,
        parent:     c.parent_hash,
        timestamp:  c.timestamp,
        date:       new Date(c.timestamp).toISOString(),
      })),
    });
  } catch (err) {
    // No commits yet is not a server error.
    return res.status(200).json({ ok: true, count: 0, commits: [] });
  }
});

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    error:   'Not Found',
    message: 'That endpoint does not exist.',
    docs:    'Visit GET / for available endpoints.',
  });
});

// ---------------------------------------------------------------------------
// Global error handler — never leak stack traces to the client
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[NilesKV API Error]', err);
  res.status(500).json({
    error:   'Internal Server Error',
    message: 'Something went wrong. Please try again.',
  });
});

// ---------------------------------------------------------------------------
// Hourly disk-threshold guard
// Runs every hour: 0 * * * *
// Wipes .db/ and re-initialises only when free disk drops below 1 GB,
// preserving NilesTime history as long as disk allows.
// ---------------------------------------------------------------------------

const WIPE_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

cron.schedule('0 * * * *', async () => {
  let stat;
  try {
    stat = await statfs(DB_PATH);
  } catch {
    // DB_PATH doesn't exist yet (first boot) — nothing to wipe.
    return;
  }

  const freeBytes = stat.bavail * stat.bsize;
  const freeMB    = (freeBytes / (1024 * 1024)).toFixed(1);
  console.log(`[DISK] Free space: ${freeMB} MB`);

  if (freeBytes >= WIPE_THRESHOLD_BYTES) {
    console.log('[DISK] Above 1 GB threshold — skipping wipe.');
    return;
  }

  console.log('[WIPE] Free disk below 1 GB — starting database reset...');
  wiping = true;

  try {
    await rm(DB_PATH, { recursive: true, force: true });
    console.log('[WIPE] .db/ directory deleted.');

    db = new NilesKV(DB_PATH);
    await db.init();
    console.log('[WIPE] NilesKV re-initialised. Database is fresh.');
  } catch (err) {
    console.error('[WIPE] Reset failed:', err);
  } finally {
    wiping = false;
    console.log('[WIPE] API resumed. Reset complete at', new Date().toISOString());
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[NilesKV API] Running on port ${PORT}`);
  console.log(`[NilesKV API] Database path: ${DB_PATH}`);
  console.log(`[NilesKV API] Disk guard: hourly check, wipes only below 1 GB free`);
});
