// D1 data access for requests and shipments.

export interface RequestRow {
  id: number;
  title: string;
  details: string | null;
  company: string | null;
  contact: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_date: string | null;
  created_by: string;
  assigned_to: string | null;
  channel_id: string | null;
  message_ts: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ShipmentRow {
  id: number;
  ship_date: string;
  description: string;
  notes: string | null;
  status: 'scheduled' | 'cancelled';
  created_by: string;
  created_at: string;
}

export interface NewRequest {
  title: string;
  details?: string | null;
  company?: string | null;
  contact?: string | null;
  priority?: string;
  due_date?: string | null;
  created_by: string;
  channel_id?: string | null;
}

export async function createRequest(env: Env, req: NewRequest): Promise<RequestRow> {
  const result = await env.DB.prepare(
    `INSERT INTO requests (title, details, company, contact, priority, due_date, created_by, channel_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      req.title,
      req.details ?? null,
      req.company ?? null,
      req.contact ?? null,
      req.priority ?? 'normal',
      req.due_date ?? null,
      req.created_by,
      req.channel_id ?? null,
      new Date().toISOString()
    )
    .run();
  const row = await getRequest(env, result.meta.last_row_id as number);
  if (!row) throw new Error('failed to read back created request');
  return row;
}

export async function getRequest(env: Env, id: number): Promise<RequestRow | null> {
  return env.DB.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first<RequestRow>();
}

export async function setRequestMessage(env: Env, id: number, channelId: string, ts: string): Promise<void> {
  await env.DB.prepare('UPDATE requests SET channel_id = ?1, message_ts = ?2 WHERE id = ?3')
    .bind(channelId, ts, id)
    .run();
}

export async function setRequestStatus(
  env: Env,
  id: number,
  status: RequestRow['status']
): Promise<RequestRow | null> {
  await env.DB.prepare(
    'UPDATE requests SET status = ?1, completed_at = ?2 WHERE id = ?3'
  )
    .bind(status, status === 'done' ? new Date().toISOString() : null, id)
    .run();
  return getRequest(env, id);
}

/** Fields that /edit can change. `null` clears a value; `undefined` leaves it alone. */
export interface RequestEdits {
  title?: string;
  due_date?: string | null;
  priority?: string;
  company?: string | null;
  assigned_to?: string | null;
  status?: RequestRow['status'];
}

export async function updateRequest(env: Env, id: number, edits: RequestEdits): Promise<RequestRow | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [column, value] of Object.entries(edits)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?${binds.length + 1}`);
    binds.push(value);
  }
  if (sets.length > 0) {
    await env.DB.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?${binds.length + 1}`)
      .bind(...binds, id)
      .run();
  }
  return getRequest(env, id);
}

export async function assignRequest(env: Env, id: number, userId: string): Promise<RequestRow | null> {
  await env.DB.prepare(
    "UPDATE requests SET assigned_to = ?1, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?2"
  )
    .bind(userId, id)
    .run();
  return getRequest(env, id);
}

/** All open / in-progress requests, most urgent first. */
export async function listOpenRequests(env: Env): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requests
     WHERE status IN ('open', 'in_progress')
     ORDER BY due_date IS NULL, due_date ASC,
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       id ASC`
  ).all<RequestRow>();
  return results;
}

export async function listRecentDone(env: Env, limit = 10): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM requests WHERE status = 'done' ORDER BY completed_at DESC LIMIT ?1"
  )
    .bind(limit)
    .all<RequestRow>();
  return results;
}

export async function createShipment(
  env: Env,
  shipDate: string,
  description: string,
  notes: string | null,
  createdBy: string
): Promise<ShipmentRow> {
  const result = await env.DB.prepare(
    `INSERT INTO shipments (ship_date, description, notes, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(shipDate, description, notes, createdBy, new Date().toISOString())
    .run();
  const row = await env.DB.prepare('SELECT * FROM shipments WHERE id = ?1')
    .bind(result.meta.last_row_id as number)
    .first<ShipmentRow>();
  if (!row) throw new Error('failed to read back created shipment');
  return row;
}

export async function cancelShipment(env: Env, id: number): Promise<ShipmentRow | null> {
  await env.DB.prepare("UPDATE shipments SET status = 'cancelled' WHERE id = ?1").bind(id).run();
  return env.DB.prepare('SELECT * FROM shipments WHERE id = ?1').bind(id).first<ShipmentRow>();
}

// --- Customer directory (contacts = people, companies = who they request for) ---

export interface DirectoryRow {
  id: number;
  name: string;
  created_at: string;
}

export type DirectoryKind = 'contacts' | 'companies';

// Table names are interpolated into SQL, so they come only from this allowlist.
function directoryTable(kind: DirectoryKind): string {
  return kind === 'contacts' ? 'contacts' : 'companies';
}

export async function listDirectory(env: Env, kind: DirectoryKind): Promise<DirectoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${directoryTable(kind)} ORDER BY name COLLATE NOCASE ASC`
  ).all<DirectoryRow>();
  return results;
}

/** Add a directory entry; returns 'duplicate' if the name already exists (case-insensitive). */
export async function addDirectoryEntry(
  env: Env,
  kind: DirectoryKind,
  name: string
): Promise<DirectoryRow | 'duplicate'> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO ${directoryTable(kind)} (name, created_at) VALUES (?1, ?2)`
    )
      .bind(name, new Date().toISOString())
      .run();
    return { id: result.meta.last_row_id as number, name, created_at: '' };
  } catch (err) {
    if (String(err).includes('UNIQUE')) return 'duplicate';
    throw err;
  }
}

export async function getDirectoryEntryById(
  env: Env,
  kind: DirectoryKind,
  id: number
): Promise<DirectoryRow | null> {
  return env.DB.prepare(`SELECT * FROM ${directoryTable(kind)} WHERE id = ?1`).bind(id).first<DirectoryRow>();
}

export async function getDirectoryEntryByName(
  env: Env,
  kind: DirectoryKind,
  name: string
): Promise<DirectoryRow | null> {
  return env.DB.prepare(`SELECT * FROM ${directoryTable(kind)} WHERE name = ?1 COLLATE NOCASE`)
    .bind(name)
    .first<DirectoryRow>();
}

/** Remove an entry by numeric id or exact name (case-insensitive). Returns the removed row. */
export async function removeDirectoryEntry(
  env: Env,
  kind: DirectoryKind,
  idOrName: string
): Promise<DirectoryRow | null> {
  const table = directoryTable(kind);
  const row = /^\d+$/.test(idOrName)
    ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(Number(idOrName)).first<DirectoryRow>()
    : await getDirectoryEntryByName(env, kind, idOrName);
  if (!row) return null;
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(row.id).run();
  const linkColumn = kind === 'contacts' ? 'contact_id' : 'company_id';
  await env.DB.prepare(`DELETE FROM contact_companies WHERE ${linkColumn} = ?1`).bind(row.id).run();
  return row;
}

/** Link a contact to a company (idempotent). */
export async function linkContactCompany(env: Env, contactId: number, companyId: number): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO contact_companies (contact_id, company_id) VALUES (?1, ?2)'
  )
    .bind(contactId, companyId)
    .run();
}

export async function unlinkContactCompany(env: Env, contactId: number, companyId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM contact_companies WHERE contact_id = ?1 AND company_id = ?2')
    .bind(contactId, companyId)
    .run();
}

/** Companies linked to a contact (by contact name, case-insensitive). Empty = no links. */
export async function companiesForContact(env: Env, contactName: string): Promise<DirectoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM companies c
     JOIN contact_companies cc ON cc.company_id = c.id
     JOIN contacts p ON p.id = cc.contact_id
     WHERE p.name = ?1 COLLATE NOCASE
     ORDER BY c.name COLLATE NOCASE ASC`
  )
    .bind(contactName)
    .all<DirectoryRow>();
  return results;
}

/**
 * Canonicalize free-typed company text against the directory: an exact
 * (case-insensitive) match wins; otherwise a unique substring match; otherwise
 * null (caller keeps the raw text).
 */
export async function matchCompany(env: Env, text: string): Promise<string | null> {
  const exact = await env.DB.prepare('SELECT name FROM companies WHERE name = ?1 COLLATE NOCASE')
    .bind(text)
    .first<{ name: string }>();
  if (exact) return exact.name;
  const { results } = await env.DB.prepare(
    "SELECT name FROM companies WHERE name LIKE '%' || ?1 || '%' LIMIT 2"
  )
    .bind(text)
    .all<{ name: string }>();
  return results.length === 1 ? results[0].name : null;
}

/** Remember a Slack user's display name (used by the wallboard). */
export async function upsertUser(env: Env, id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, name, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  )
    .bind(id, name, new Date().toISOString())
    .run();
}

/** Map of Slack user id -> display name for everyone we've seen. */
export async function getUserNames(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare('SELECT id, name FROM users').all<{ id: string; name: string }>();
  return new Map(results.map((r) => [r.id, r.name]));
}

/** Scheduled shipments between two dates inclusive, soonest first. */
export async function listShipments(env: Env, fromDate: string, toDate: string): Promise<ShipmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM shipments
     WHERE status = 'scheduled' AND ship_date >= ?1 AND ship_date <= ?2
     ORDER BY ship_date ASC, id ASC`
  )
    .bind(fromDate, toDate)
    .all<ShipmentRow>();
  return results;
}
