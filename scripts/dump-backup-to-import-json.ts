#!/usr/bin/env bun
/**
 * Dumps the claude-mem backup SQLite DB into the JSON shape expected by
 * scripts/import-memories.ts / /api/import handler.
 *
 * Uses cursor iteration (stmt.iterate()) + WriteStream to avoid OOM on large
 * tables (31K sessions, 34K prompts).
 *
 * Usage:
 *   bun run scripts/dump-backup-to-import-json.ts
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, createWriteStream, WriteStream } from 'fs';
import { dirname } from 'path';

const BACKUP_DB =
  'C:/Users/mlokupathirage/.claude-mem/backups/claude-mem-pre-12.4.3-2026-05-17T09-30-39-848Z.db';
const OUTPUT_FILE = 'D:/tmp/claude-mem-merge/backup-dump.json';

function normaliseStatus(raw: string | null | undefined): string {
  if (raw === 'active' || raw === 'completed' || raw === 'failed') return raw as string;
  return 'completed';
}

// --- Write helpers ---

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    if (!stream.write(chunk, 'utf-8')) {
      stream.once('drain', resolve);
    } else {
      resolve();
    }
  });
}

/**
 * Streams rows from an SQLite iterator as a JSON array into the write stream.
 * Returns the count of rows written.
 */
async function streamArray(
  stream: WriteStream,
  name: string,
  stmt: ReturnType<InstanceType<typeof Database>['prepare']>,
  transform: (row: Record<string, unknown>) => Record<string, unknown>,
  isLast: boolean
): Promise<number> {
  await writeChunk(stream, `"${name}":[`);
  let count = 0;
  for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
    const obj = transform(row);
    if (count > 0) await writeChunk(stream, ',');
    await writeChunk(stream, JSON.stringify(obj));
    count++;
  }
  await writeChunk(stream, isLast ? ']' : '],');
  return count;
}

// --- Open DB ---
console.log('Opening backup DB (read-only):', BACKUP_DB);
const db = new Database(BACKUP_DB, { readonly: true });

// --- Count rows first (fast, no data fetch) ---
const counts = {
  sessions: (db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions').get() as { n: number }).n,
  summaries: (db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get() as { n: number }).n,
  observations: (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n,
  prompts: (db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n,
};
console.log(
  `Counts: sessions=${counts.sessions}, summaries=${counts.summaries}, observations=${counts.observations}, prompts=${counts.prompts}`
);

// --- Prepare statements ---
// user_prompt in the backup can be multi-MB (full transcript blobs).
// Truncate to first 512 chars for storage - it is display-only metadata.
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

const summaryStmt = db.prepare(
  `SELECT
     memory_session_id,
     project,
     request,
     investigated,
     learned,
     completed,
     next_steps,
     files_read,
     files_edited,
     notes,
     prompt_number,
     COALESCE(discovery_tokens, 0) AS discovery_tokens,
     created_at,
     created_at_epoch
   FROM session_summaries`
);

const obsStmt = db.prepare(
  `SELECT
     memory_session_id,
     project,
     text,
     type,
     title,
     subtitle,
     facts,
     narrative,
     concepts,
     files_read,
     files_modified,
     prompt_number,
     COALESCE(discovery_tokens, 0) AS discovery_tokens,
     created_at,
     created_at_epoch,
     agent_type,
     agent_id
   FROM observations`
);

// prompt_text in the backup can be multi-MB transcript blobs.
// Truncate to 8 KB to keep the dump file manageable.
const promptStmt = db.prepare(
  `SELECT
     content_session_id,
     prompt_number,
     SUBSTR(COALESCE(prompt_text, ''), 1, 8192) AS prompt_text,
     created_at,
     created_at_epoch
   FROM user_prompts`
);

// --- Open output stream ---
console.log('Writing output to', OUTPUT_FILE);
mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
const stream = createWriteStream(OUTPUT_FILE, { encoding: 'utf-8' });

const exportedAt = new Date().toISOString();

// Write header (uses the COUNT(*) values so they're accurate up front)
await writeChunk(
  stream,
  `{"exportedAt":${JSON.stringify(exportedAt)},"query":"full-backup-merge",` +
    `"totalSessions":${counts.sessions},"totalSummaries":${counts.summaries},` +
    `"totalObservations":${counts.observations},"totalPrompts":${counts.prompts},`
);

// --- Stream each table ---
console.log('Streaming sdk_sessions...');
const writtenSessions = await streamArray(
  stream,
  'sessions',
  sessionStmt,
  (r) => ({
    content_session_id: r.content_session_id,
    memory_session_id: r.memory_session_id,
    project: r.project,
    user_prompt: r.user_prompt,
    started_at: r.started_at,
    started_at_epoch: r.started_at_epoch,
    completed_at: r.completed_at ?? null,
    completed_at_epoch: r.completed_at_epoch ?? null,
    status: normaliseStatus(r.status as string | null),
  }),
  false
);
console.log(`  -> ${writtenSessions} rows written`);

console.log('Streaming session_summaries...');
const writtenSummaries = await streamArray(
  stream,
  'summaries',
  summaryStmt,
  (r) => r,
  false
);
console.log(`  -> ${writtenSummaries} rows written`);

console.log('Streaming observations...');
const writtenObs = await streamArray(
  stream,
  'observations',
  obsStmt,
  (r) => r,
  false
);
console.log(`  -> ${writtenObs} rows written`);

console.log('Streaming user_prompts...');
const writtenPrompts = await streamArray(
  stream,
  'prompts',
  promptStmt,
  (r) => r,
  true
);
console.log(`  -> ${writtenPrompts} rows written`);

await writeChunk(stream, '}');
await new Promise<void>((resolve) => stream.end(resolve));

db.close();
console.log('DB closed.');

const stat = Bun.file(OUTPUT_FILE);
const size = await stat.size;
const sizeMB = (size / 1024 / 1024).toFixed(1);
console.log(`Done. File size: ${sizeMB} MB (${size} bytes)`);
console.log(
  `Summary: sessions=${writtenSessions}, summaries=${writtenSummaries}, observations=${writtenObs}, prompts=${writtenPrompts}`
);
