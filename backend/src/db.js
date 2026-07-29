import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'fortiswitch.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS switches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  role_template TEXT DEFAULT 'default',
  source TEXT DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS switch_status (
  switch_id TEXT PRIMARY KEY REFERENCES switches(id) ON DELETE CASCADE,
  reachable INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  last_error TEXT,
  system_info_json TEXT,
  vlans_json TEXT,
  global_config_json TEXT
);

CREATE TABLE IF NOT EXISTS ports (
  switch_id TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  port_name TEXT NOT NULL,
  admin_status TEXT,
  oper_status TEXT,
  speed TEXT,
  duplex TEXT,
  native_vlan INTEGER,
  allowed_vlans TEXT,
  poe_enabled INTEGER,
  poe_watts REAL,
  poe_class TEXT,
  description TEXT,
  stp_state TEXT,
  edge_port TEXT,
  lldp_profile TEXT,
  speed_config TEXT,
  lldp_neighbor_device TEXT,
  lldp_neighbor_port_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (switch_id, port_name)
);

-- vlan is part of the key: a routed trunk port (e.g. a switch's own "internal"
-- management interface) legitimately shows the same MAC once per VLAN it
-- carries, not once per port.
CREATE TABLE IF NOT EXISTS mac_entries (
  switch_id TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  port_name TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  vlan INTEGER NOT NULL,
  type TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (switch_id, port_name, mac_address, vlan)
);

CREATE TABLE IF NOT EXISTS discovery_cache (
  mac_address TEXT PRIMARY KEY,
  ip_address TEXT,
  hostname TEXT,
  discovery_source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  yaml_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  switch_id TEXT,
  port_name TEXT,
  action TEXT NOT NULL,
  detail_json TEXT,
  result TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  switch_id TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  commit_hash TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// CREATE TABLE IF NOT EXISTS above only applies to brand-new databases; add
// columns introduced after a table already existed on disk.
function ensureColumn(table, column, ddlType) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

ensureColumn('switch_status', 'global_config_json', 'TEXT');
ensureColumn('ports', 'stp_state', 'TEXT');
ensureColumn('ports', 'edge_port', 'TEXT');
ensureColumn('ports', 'lldp_profile', 'TEXT');
ensureColumn('ports', 'speed_config', 'TEXT');
ensureColumn('ports', 'lldp_neighbor_device', 'TEXT');
ensureColumn('ports', 'lldp_neighbor_port_id', 'TEXT');

export function nowIso() {
  return new Date().toISOString();
}
