#!/usr/bin/env bun
/**
 * Batch-imports the claude-mem backup SQLite DB directly into the live worker
 * via /api/import, posting in chunks to avoid OOM from large JSON blobs.
 *
 * The backup's sdk_sessions.user_prompt field contains multi-MB transcript
 * blobs (avg 1.17 MB). This script truncates that field to 512 chars, which
 * matches live DB behaviour (avg 20 KB, display-only metadata).
 *
 * Usage:
 *   CLAUDE_MEM_WORKER_PORT=37790 bun run scripts/batch-import-from-db.ts
 *
 * Produces D:/tmp/claude-mem-merge/import-stdout.log
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, createWriteStream } from 'fs';
import type { WriteStream } from 'fs';

const BACKUP_DB =
  'C:/Users/mlokupathirage/.claude-mem/backups/claude-mem-pre-12.4.3-2026-05-17T09-30-39-848Z.db';
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37790';
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const LOG_FILE = 'D:/tmp/claude-mem-merge/import-stdout.log';
const SESSION_BATCH = 500;
const GENERAL_BATCH = 500;
// prompt_text in the backup can be multi-MB transcript blobs (avg 1.17 MB).
// Truncate to 8 KB and use small batches to stay under the worker's 5 MB body limit.
const PROMPT_BATCH = 50;
const PROMPT_TEXT_MAX = 8192;

// ---- Log helper ----
mkdirSync('D:/tmp/claude-mem-merge', { recursive: true });
const logStream: WriteStream = createWriteStream(LOG_FILE, { flags: 'w', encoding: 'utf-8' });
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function normaliseStatus(raw: string | null | undefined): string {
  if (raw === 'active' || raw === 'completed' || raw === 'failed') return raw as string;
  return 'completed';
}

// ---- Health check ----
log(`Checking worker at ${WORKER_URL}/api/stats ...`);
const health = await fetch(`${WORKER_URL}/api/stats`);
if (!health.ok) {
  log(`ERROR: Worker not responding (${health.status})`);
  process.exit(1);
}
const healthJson = await health.json() as { database?: { observations?: number; sessions?: number; summaries?: number } };
log(`Worker OK. Pre-import counts: ${JSON.stringify(healthJson.database || {})}`);

// ---- Open backup DB ----
log(`Opening backup DB (read-only): ${BACKUP_DB}`);
const db = new Database(BACKUP_DB, { readonly: true });

// ---- Row counts ----
const counts = {
  sessions: (db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n,
  summaries: (db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get() as { n: number }).n,
  observations: (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n,
  prompts: (db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n,
};
log(`Backup counts: sessions=${counts.sessions}, summaries=${counts.summaries}, observations=${counts.observations}, prompts=${counts.prompts}`);

// ---- Accumulated stats ----
const stats = {
  sessionsImported: 0, sessionsSkipped: 0,
  summariesImported: 0, summariesSkipped: 0,
  observationsImported: 0, observationsSkipped: 0,
  promptsImported: 0, promptsSkipped: 0,
};

// ---- Post a batch to /api/import ----
async function postBatch(payload: {
  sessions?: unknown[];
  summaries?: unknown[];
  observations?: unknown[];
  prompts?: unknown[];
}): Promise<void> {
  const body = JSON.stringify(payload);
  const resp = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Import POST failed ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const result = await resp.json() as { stats: typeof stats };
  const s = result.stats;
  stats.sessionsImported += s.sessionsImported || 0;
  stats.sessionsSkipped += s.sessionsSkipped || 0;
  stats.summariesImported += s.summariesImported || 0;
  stats.summariesSkipped += s.summariesSkipped || 0;
  stats.observationsImported += s.observationsImported || 0;
  stats.observationsSkipped += s.observationsSkipped || 0;
  stats.promptsImported += s.promptsImported || 0;
  stats.promptsSkipped += s.promptsSkipped || 0;
}

// ============================================================
// PHASE 1: sdk_sessions (batched, user_prompt truncated to 512)
// ============================================================
log(`--- Phase 1: sdk_sessions (batch=${SESSION_BATCH}) ---`);
const sessionStmt = db.prepare(
  `SELECT
     content_session_id,
     memory_session_id,
     project,
     SUBSTR(COALESCE(user_prompt, ''), 1, 512) AS user_prompt,
     started_at,
     started_at_epoch,
     completed_at,
     completed_at_epoch,
     status
   FROM sdk_sessions`
);

let batch: unknown[] = [];
let processed = 0;
for (const row of sessionStmt.iterate() as IterableIterator<Record<string, unknown>>) {
  batch.push({
    content_session_id: row.content_session_id,
    memory_session_id: row.memory_session_id,
    project: row.project,
    user_prompt: row.user_prompt,
    started_at: row.started_at,
    started_at_epoch: row.started_at_epoch,
    completed_at: row.completed_at ?? null,
    completed_at_epoch: row.completed_at_epoch ?? null,
    status: normaliseStatus(row.status as string | null),
  });
  if (batch.length >= SESSION_BATCH) {
    await postBatch({ sessions: batch, summaries: [], observations: [], prompts: [] });
    processed += batch.length;
    log(`  sessions: ${processed}/${counts.sessions} posted (imported=${stats.sessionsImported} skipped=${stats.sessionsSkipped})`);
    batch = [];
  }
}
if (batch.length > 0) {
  await postBatch({ sessions: batch, summaries: [], observations: [], prompts: [] });
  processed += batch.length;
  log(`  sessions: ${processed}/${counts.sessions} posted (imported=${stats.sessionsImported} skipped=${stats.sessionsSkipped})`);
  batch = [];
}
log(`Phase 1 done. imported=${stats.sessionsImported} skipped=${stats.sessionsSkipped}`);

// ============================================================
// PHASE 2: session_summaries
// ============================================================
log(`--- Phase 2: session_summaries (batch=${GENERAL_BATCH}) ---`);
const summaryStmt = db.prepare(
  `SELECT
     memory_session_id, project, request, investigated, learned, completed,
     next_steps, files_read, files_edited, notes, prompt_number,
     COALESCE(discovery_tokens, 0) AS discovery_tokens, created_at, created_at_epoch
   FROM session_summaries`
);
processed = 0;
for (const row of summaryStmt.iterate() as IterableIterator<Record<string, unknown>>) {
  batch.push(row);
  if (batch.length >= GENERAL_BATCH) {
    await postBatch({ sessions: [], summaries: batch, observations: [], prompts: [] });
    processed += batch.length;
    log(`  summaries: ${processed}/${counts.summaries} posted (imported=${stats.summariesImported} skipped=${stats.summariesSkipped})`);
    batch = [];
  }
}
if (batch.length > 0) {
  await postBatch({ sessions: [], summaries: batch, observations: [], prompts: [] });
  processed += batch.length;
  log(`  summaries: ${processed}/${counts.summaries} posted (imported=${stats.summariesImported} skipped=${stats.summariesSkipped})`);
  batch = [];
}
log(`Phase 2 done. imported=${stats.summariesImported} skipped=${stats.summariesSkipped}`);

// ============================================================
// PHASE 3: observations
// ============================================================
log(`--- Phase 3: observations (batch=${GENERAL_BATCH}) ---`);
const obsStmt = db.prepare(
  `SELECT
     memory_session_id, project, text, type, title, subtitle, facts, narrative,
     concepts, files_read, files_modified, prompt_number,
     COALESCE(discovery_tokens, 0) AS discovery_tokens,
     created_at, created_at_epoch, agent_type, agent_id
   FROM observations`
);
processed = 0;
for (const row of obsStmt.iterate() as IterableIterator<Record<string, unknown>>) {
  batch.push(row);
  if (batch.length >= GENERAL_BATCH) {
    await postBatch({ sessions: [], summaries: [], observations: batch, prompts: [] });
    processed += batch.length;
    log(`  observations: ${processed}/${counts.observations} posted (imported=${stats.observationsImported} skipped=${stats.observationsSkipped})`);
    batch = [];
  }
}
if (batch.length > 0) {
  await postBatch({ sessions: [], summaries: [], observations: batch, prompts: [] });
  processed += batch.length;
  log(`  observations: ${processed}/${counts.observations} posted (imported=${stats.observationsImported} skipped=${stats.observationsSkipped})`);
  batch = [];
}
log(`Phase 3 done. imported=${stats.observationsImported} skipped=${stats.observationsSkipped}`);

// ============================================================
// PHASE 4: user_prompts
// prompt_text can be multi-MB in the backup; truncate and use small batches.
// ============================================================
log(`--- Phase 4: user_prompts (batch=${PROMPT_BATCH}, prompt_text_max=${PROMPT_TEXT_MAX}) ---`);
const promptStmt = db.prepare(
  `SELECT
     content_session_id, prompt_number,
     SUBSTR(COALESCE(prompt_text, ''), 1, ${PROMPT_TEXT_MAX}) AS prompt_text,
     created_at, created_at_epoch
   FROM user_prompts`
);
processed = 0;
for (const row of promptStmt.iterate() as IterableIterator<Record<string, unknown>>) {
  batch.push(row);
  if (batch.length >= PROMPT_BATCH) {
    await postBatch({ sessions: [], summaries: [], observations: [], prompts: batch });
    processed += batch.length;
    if (processed % 5000 === 0 || processed === counts.prompts) {
      log(`  prompts: ${processed}/${counts.prompts} posted (imported=${stats.promptsImported} skipped=${stats.promptsSkipped})`);
    }
    batch = [];
  }
}
if (batch.length > 0) {
  await postBatch({ sessions: [], summaries: [], observations: [], prompts: batch });
  processed += batch.length;
  log(`  prompts: ${processed}/${counts.prompts} posted (imported=${stats.promptsImported} skipped=${stats.promptsSkipped})`);
  batch = [];
}
log(`Phase 4 done. imported=${stats.promptsImported} skipped=${stats.promptsSkipped}`);

// ============================================================
// Final summary
// ============================================================
db.close();

log('');
log('=== Import Complete ===');
log(`Sessions:     ${stats.sessionsImported} imported, ${stats.sessionsSkipped} skipped`);
log(`Summaries:    ${stats.summariesImported} imported, ${stats.summariesSkipped} skipped`);
log(`Observations: ${stats.observationsImported} imported, ${stats.observationsSkipped} skipped`);
log(`Prompts:      ${stats.promptsImported} imported, ${stats.promptsSkipped} skipped`);

// Post-import stats from worker
const postStats = await fetch(`${WORKER_URL}/api/stats`);
const postJson = await postStats.json() as { database?: Record<string, unknown> };
log(`Post-import worker stats: ${JSON.stringify(postJson.database || {})}`);

await new Promise<void>((resolve) => logStream.end(resolve));
