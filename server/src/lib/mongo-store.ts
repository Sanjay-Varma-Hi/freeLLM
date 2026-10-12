/**
 * MongoDB persistence for hosts with an ephemeral disk (Render free tier wipes
 * the SQLite file whenever the service sleeps or redeploys).
 *
 * Two things live in MongoDB (database MONGODB_DB, default "freellmapi"):
 *
 *  1. A full snapshot of the SQLite database in GridFS (bucket "sqlite_backups").
 *     It is gzipped and AES-256-GCM encrypted by db-backup.ts with
 *     FREEAPI_DB_BACKUP_KEY / ENCRYPTION_KEY before it leaves the process, and it
 *     is what boot restores from — accounts, password hashes, provider keys,
 *     unified key, fallback chains, settings, everything.
 *
 *  2. Readable per-account mirrors, refreshed with every snapshot:
 *       accounts       — one doc per dashboard login (email + scrypt hash)
 *       provider_keys  — one doc per provider key, tagged with the owning
 *                        account email; the key itself stays AES-encrypted
 *                        exactly as it is in SQLite (never plaintext).
 *     If the snapshot is ever missing, boot re-seeds accounts and provider keys
 *     from these mirrors so you never have to sign up again.
 */
import { MongoClient, GridFSBucket, type Db as MongoDb } from 'mongodb';
import type { Db } from '../db/types.js';

const SNAPSHOT_FILENAME = 'freellmapi.sqlite.enc';
const KEEP_SNAPSHOTS = 3;
const CONNECT_TIMEOUT_MS = 20_000;

let clientPromise: Promise<MongoClient> | null = null;

export function mongoUri(): string | null {
  const raw = (process.env.MONGODB_URI ?? process.env.FREEAPI_MONGODB_URI ?? '').trim();
  return raw.length > 0 ? raw : null;
}

export function isMongoConfigured(): boolean {
  return mongoUri() !== null;
}

/** Safe for logs: host only, never the username or password. */
export function mongoLabel(): string {
  const uri = mongoUri();
  if (!uri) return 'MongoDB';
  const m = uri.match(/@([^/?]+)/);
  return `MongoDB (${m ? m[1] : 'cluster'})`;
}

async function getMongo(): Promise<MongoDb> {
  const uri = mongoUri();
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      appName: 'freellmapi',
    });
    clientPromise = client.connect().catch(async (err) => {
      clientPromise = null; // let the next call retry instead of caching the failure
      await client.close().catch(() => {});
      throw err;
    });
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB?.trim() || 'freellmapi');
}

/**
 * Turn a driver/TLS error into an actionable message. The most common failure
 * on a new deploy is Atlas refusing the host's IP: Atlas answers the TLS
 * handshake with "tlsv1 alert internal error" (SSL alert number 80) instead of
 * a readable error, which is impossible to diagnose from the log alone.
 */
export function explainMongoError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/alert number 80|tlsv1 alert internal error|ssl3_read_bytes|ServerSelection|timed out|ECONNRESET|ECONNREFUSED/i.test(msg)) {
    return `${mongoLabel()} refused the connection. In MongoDB Atlas open Security → Network Access and add 0.0.0.0/0 `
      + `("Allow access from anywhere") — Render has no fixed outbound IP. (driver said: ${msg.slice(0, 160)})`;
  }
  if (/bad auth|authentication failed|auth failed/i.test(msg)) {
    return `${mongoLabel()} rejected the username/password in MONGODB_URI. Check Atlas → Database Access, and URL-encode special characters in the password. (driver said: ${msg.slice(0, 160)})`;
  }
  if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `Could not resolve the cluster host in MONGODB_URI — check it was copied completely. (driver said: ${msg.slice(0, 160)})`;
  }
  return `${mongoLabel()}: ${msg}`;
}

// ---------------------------------------------------------------- snapshot ---

export async function readMongoSnapshot(): Promise<Buffer | null> {
  const db = await getMongo();
  const bucket = new GridFSBucket(db, { bucketName: 'sqlite_backups' });
  const [latest] = await bucket.find({ filename: SNAPSHOT_FILENAME }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!latest) return null;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    bucket.openDownloadStream(latest._id)
      .on('data', (c: Buffer) => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return Buffer.concat(chunks);
}

export async function writeMongoSnapshot(payload: Buffer, meta: { sha256: string; bytes: number }): Promise<void> {
  const db = await getMongo();
  const bucket = new GridFSBucket(db, { bucketName: 'sqlite_backups' });
  await new Promise<void>((resolve, reject) => {
    const up = bucket.openUploadStream(SNAPSHOT_FILENAME, { metadata: { ...meta, encrypted: true, format: 'FAPIBK1+gzip' } });
    up.on('error', reject).on('finish', () => resolve());
    up.end(payload);
  });
  // Keep a few previous versions for safety, drop the rest.
  const old = await bucket.find({ filename: SNAPSHOT_FILENAME }).sort({ uploadDate: -1 }).skip(KEEP_SNAPSHOTS).toArray();
  for (const f of old) await bucket.delete(f._id).catch(() => {});
}

// ----------------------------------------------------------------- mirrors ---

interface UserRow { id: number; email: string; password_hash: string; created_at: string }

function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** Upsert the readable per-account mirrors from the live SQLite database. */
export async function syncMongoMirrors(db: Db): Promise<{ accounts: number; keys: number }> {
  const mdb = await getMongo();
  const users = db.prepare('SELECT id, email, password_hash, created_at FROM users ORDER BY id').all() as UserRow[];
  const keys = db.prepare('SELECT * FROM api_keys ORDER BY id').all() as Array<Record<string, unknown>>;
  // FreeLLMAPI is single-tenant: provider keys belong to the instance, which is
  // owned by its first dashboard account. Tag every key with that owner.
  // Safety: a database without any account is a fresh/unclaimed one. Never let
  // it prune the mirrors — that would erase the very data a later boot needs.
  if (users.length === 0) return { accounts: 0, keys: 0 };
  const owner = users[0]?.email ?? null;
  const now = new Date();

  const accounts = mdb.collection<{ _id: string } & Record<string, unknown>>('accounts');
  if (users.length) {
    await accounts.bulkWrite(users.map((u) => ({
      updateOne: {
        filter: { _id: u.email },
        update: { $set: { email: u.email, passwordHash: u.password_hash, createdAt: u.created_at, role: u.email === owner ? 'owner' : 'member', updatedAt: now } },
        upsert: true,
      },
    })));
  }
  await accounts.deleteMany({ _id: { $nin: users.map((u) => u.email) } });

  const providerKeys = mdb.collection<{ _id: string } & Record<string, unknown>>('provider_keys');
  const keyIds: string[] = [];
  if (keys.length) {
    await providerKeys.bulkWrite(keys.map((k) => {
      const id = `${k.platform}:${k.id}`;
      keyIds.push(id);
      return {
        updateOne: {
          filter: { _id: id },
          update: { $set: { account: owner, platform: k.platform, label: k.label, enabled: k.enabled === 1, status: k.status, row: k, updatedAt: now } },
          upsert: true,
        },
      };
    }));
  }
  await providerKeys.deleteMany({ _id: { $nin: keyIds } });
  return { accounts: users.length, keys: keys.length };
}

/**
 * Fallback for a database that came up empty with no snapshot to restore:
 * re-create dashboard accounts and provider keys from the mirrors. Rows are
 * inserted with the columns the current schema still has, so a mirror written
 * by an older build restores cleanly.
 */
export async function seedFromMongoMirrors(db: Db): Promise<{ accounts: number; keys: number }> {
  const hasUsers = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c > 0;
  const hasKeys = (db.prepare('SELECT COUNT(*) AS c FROM api_keys').get() as { c: number }).c > 0;
  if (hasUsers && hasKeys) return { accounts: 0, keys: 0 };
  const mdb = await getMongo();
  let accounts = 0;
  let keys = 0;

  if (!hasUsers) {
    const docs = await mdb.collection('accounts').find({}).sort({ createdAt: 1 }).toArray();
    const insert = db.prepare('INSERT OR IGNORE INTO users (email, password_hash, created_at) VALUES (?, ?, ?)');
    for (const d of docs) {
      if (typeof d.email === 'string' && typeof d.passwordHash === 'string') {
        accounts += insert.run(d.email, d.passwordHash, d.createdAt ?? new Date().toISOString()).changes;
      }
    }
  }

  if (!hasKeys) {
    const cols = new Set(tableColumns(db, 'api_keys'));
    cols.delete('id');
    const docs = await mdb.collection('provider_keys').find({}).toArray();
    for (const d of docs) {
      const row = (d.row ?? {}) as Record<string, unknown>;
      const names = Object.keys(row).filter((c) => cols.has(c));
      if (!names.includes('encrypted_key')) continue;
      db.prepare(`INSERT INTO api_keys (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
        .run(...names.map((n) => row[n] as never));
      keys++;
    }
  }
  return { accounts, keys };
}

export async function closeMongo(): Promise<void> {
  if (!clientPromise) return;
  const p = clientPromise;
  clientPromise = null;
  await (await p).close().catch(() => {});
}
