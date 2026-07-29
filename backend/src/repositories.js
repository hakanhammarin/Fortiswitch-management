import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';

// Plain SQL/string sort puts port_name "port10" before "port2" (lexicographic).
// Splits into alternating digit/non-digit chunks and compares numeric chunks
// as numbers, so port1 < port2 < ... < port10.
function naturalCompare(a, b) {
  const aParts = a.match(/(\d+|\D+)/g) || [];
  const bParts = b.match(/(\d+|\D+)/g) || [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? '';
    const bp = bParts[i] ?? '';
    if (ap === bp) continue;
    const an = /^\d+$/.test(ap) ? Number(ap) : null;
    const bn = /^\d+$/.test(bp) ? Number(bp) : null;
    if (an !== null && bn !== null) return an - bn;
    return ap < bp ? -1 : 1;
  }
  return 0;
}

// ---- Switches ----

export function listSwitches() {
  return db
    .prepare(
      `SELECT s.id, s.name, s.host, s.ssh_port, s.username, s.role_template, s.source,
              s.created_at, s.updated_at,
              st.reachable, st.last_poll_at, st.last_error, st.system_info_json
       FROM switches s
       LEFT JOIN switch_status st ON st.switch_id = s.id
       ORDER BY s.name`
    )
    .all();
}

export function getSwitch(id) {
  return db
    .prepare(
      `SELECT s.*, st.reachable, st.last_poll_at, st.last_error, st.system_info_json
       FROM switches s
       LEFT JOIN switch_status st ON st.switch_id = s.id
       WHERE s.id = ?`
    )
    .get(id);
}

export function getSwitchWithCredentials(id) {
  const row = db.prepare(`SELECT * FROM switches WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, password: decryptSecret(row.password_enc) };
}

export function createSwitch({ name, host, sshPort, username, password, roleTemplate, source }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO switches (id, name, host, ssh_port, username, password_enc, role_template, source)
     VALUES (@id, @name, @host, @sshPort, @username, @passwordEnc, @roleTemplate, @source)`
  ).run({
    id,
    name,
    host,
    sshPort: sshPort || 22,
    username,
    passwordEnc: encryptSecret(password),
    roleTemplate: roleTemplate || 'default',
    source: source || 'manual',
  });
  db.prepare(`INSERT INTO switch_status (switch_id, reachable) VALUES (?, 0)`).run(id);
  return getSwitch(id);
}

export function updateSwitch(id, fields) {
  const current = db.prepare(`SELECT * FROM switches WHERE id = ?`).get(id);
  if (!current) return null;
  const next = {
    name: fields.name ?? current.name,
    host: fields.host ?? current.host,
    sshPort: fields.sshPort ?? current.ssh_port,
    username: fields.username ?? current.username,
    passwordEnc: fields.password ? encryptSecret(fields.password) : current.password_enc,
    roleTemplate: fields.roleTemplate ?? current.role_template,
  };
  db.prepare(
    `UPDATE switches SET name=@name, host=@host, ssh_port=@sshPort, username=@username,
       password_enc=@passwordEnc, role_template=@roleTemplate, updated_at=datetime('now')
     WHERE id=@id`
  ).run({ ...next, id });
  return getSwitch(id);
}

export function deleteSwitch(id) {
  db.prepare(`DELETE FROM switches WHERE id = ?`).run(id);
}

export function setSwitchStatus(id, { reachable, lastError, systemInfo, vlans, globalConfig }) {
  const current = db.prepare(`SELECT vlans_json, global_config_json FROM switch_status WHERE switch_id = ?`).get(id);
  db.prepare(
    `INSERT INTO switch_status (switch_id, reachable, last_poll_at, last_error, system_info_json, vlans_json, global_config_json)
     VALUES (@id, @reachable, datetime('now'), @lastError, @systemInfo, @vlans, @globalConfig)
     ON CONFLICT(switch_id) DO UPDATE SET
       reachable=@reachable, last_poll_at=datetime('now'), last_error=@lastError,
       system_info_json=@systemInfo, vlans_json=@vlans, global_config_json=@globalConfig`
  ).run({
    id,
    reachable: reachable ? 1 : 0,
    lastError: lastError || null,
    systemInfo: systemInfo ? JSON.stringify(systemInfo) : null,
    vlans: vlans ? JSON.stringify(vlans) : current?.vlans_json || null,
    globalConfig: globalConfig ? JSON.stringify(globalConfig) : current?.global_config_json || null,
  });
}

export function getSwitchVlans(id) {
  const row = db.prepare(`SELECT vlans_json FROM switch_status WHERE switch_id = ?`).get(id);
  return row?.vlans_json ? JSON.parse(row.vlans_json) : [];
}

export function getSwitchGlobalConfig(id) {
  const row = db.prepare(`SELECT global_config_json FROM switch_status WHERE switch_id = ?`).get(id);
  return row?.global_config_json ? JSON.parse(row.global_config_json) : {};
}

// ---- Ports ----

export function replacePorts(switchId, ports) {
  const del = db.prepare(`DELETE FROM ports WHERE switch_id = ?`);
  const ins = db.prepare(
    `INSERT INTO ports (switch_id, port_name, admin_status, oper_status, speed, duplex,
        native_vlan, allowed_vlans, poe_enabled, poe_watts, poe_class, description,
        stp_state, edge_port, lldp_profile, speed_config, lldp_neighbor_device, lldp_neighbor_port_id)
     VALUES (@switchId, @portName, @adminStatus, @operStatus, @speed, @duplex,
        @nativeVlan, @allowedVlans, @poeEnabled, @poeWatts, @poeClass, @description,
        @stpState, @edgePort, @lldpProfile, @speedConfig, @lldpNeighborDevice, @lldpNeighborPortId)`
  );
  const tx = db.transaction((rows) => {
    del.run(switchId);
    for (const p of rows) {
      ins.run({
        switchId,
        portName: p.portName,
        adminStatus: p.adminStatus ?? null,
        operStatus: p.operStatus ?? null,
        speed: p.speed ?? null,
        duplex: p.duplex ?? null,
        nativeVlan: p.nativeVlan ?? null,
        allowedVlans: p.allowedVlans ? JSON.stringify(p.allowedVlans) : null,
        poeEnabled: p.poeEnabled ? 1 : 0,
        poeWatts: p.poeWatts ?? 0,
        poeClass: p.poeClass ?? null,
        description: p.description ?? null,
        stpState: p.stpState ?? null,
        edgePort: p.edgePort ?? null,
        lldpProfile: p.lldpProfile ?? null,
        speedConfig: p.speedConfig ?? null,
        lldpNeighborDevice: p.lldpNeighborDevice ?? null,
        lldpNeighborPortId: p.lldpNeighborPortId ?? null,
      });
    }
  });
  tx(ports);
}

export function listPorts(switchId) {
  return db
    .prepare(`SELECT * FROM ports WHERE switch_id = ?`)
    .all(switchId)
    .map((p) => ({ ...p, allowedVlans: p.allowed_vlans ? JSON.parse(p.allowed_vlans) : [] }))
    .sort((a, b) => naturalCompare(a.port_name, b.port_name));
}

export function getPort(switchId, portName) {
  const p = db.prepare(`SELECT * FROM ports WHERE switch_id = ? AND port_name = ?`).get(switchId, portName);
  if (!p) return null;
  return { ...p, allowedVlans: p.allowed_vlans ? JSON.parse(p.allowed_vlans) : [] };
}

// ---- MAC entries ----

export function replaceMacEntries(switchId, entries) {
  const del = db.prepare(`DELETE FROM mac_entries WHERE switch_id = ?`);
  const ins = db.prepare(
    `INSERT INTO mac_entries (switch_id, port_name, mac_address, vlan, type)
     VALUES (@switchId, @portName, @macAddress, @vlan, @type)`
  );
  const tx = db.transaction((rows) => {
    del.run(switchId);
    for (const e of rows) {
      ins.run({ switchId, portName: e.portName, macAddress: e.macAddress, vlan: e.vlan ?? null, type: e.type ?? 'dynamic' });
    }
  });
  tx(entries);
}

export function listMacEntries(switchId) {
  return db.prepare(`SELECT * FROM mac_entries WHERE switch_id = ? ORDER BY port_name, mac_address`).all(switchId);
}

// ---- Discovery cache (ARP / mDNS / NetBIOS) ----

export function upsertDiscovery(entries) {
  const ins = db.prepare(
    `INSERT INTO discovery_cache (mac_address, ip_address, hostname, discovery_source, updated_at)
     VALUES (@macAddress, @ipAddress, @hostname, @discoverySource, datetime('now'))
     ON CONFLICT(mac_address) DO UPDATE SET
       ip_address=@ipAddress, hostname=@hostname, discovery_source=@discoverySource, updated_at=datetime('now')`
  );
  const tx = db.transaction((rows) => {
    for (const e of rows) ins.run(e);
  });
  tx(entries);
}

export function getDiscoveryByMac(mac) {
  return db.prepare(`SELECT * FROM discovery_cache WHERE mac_address = ?`).get(mac);
}

export function listDiscovery() {
  return db.prepare(`SELECT * FROM discovery_cache ORDER BY hostname`).all();
}

// ---- Templates (desired state) ----

export function listTemplates() {
  return db.prepare(`SELECT * FROM templates ORDER BY name`).all();
}

export function getTemplate(idOrName) {
  return (
    db.prepare(`SELECT * FROM templates WHERE id = ?`).get(idOrName) ||
    db.prepare(`SELECT * FROM templates WHERE name = ?`).get(idOrName)
  );
}

export function upsertTemplate({ name, description, yamlBody }) {
  const existing = db.prepare(`SELECT id FROM templates WHERE name = ?`).get(name);
  const id = existing?.id || randomUUID();
  db.prepare(
    `INSERT INTO templates (id, name, description, yaml_body)
     VALUES (@id, @name, @description, @yamlBody)
     ON CONFLICT(id) DO UPDATE SET description=@description, yaml_body=@yamlBody, updated_at=datetime('now')`
  ).run({ id, name, description: description || '', yamlBody });
  return getTemplate(id);
}

// ---- Audit log ----

export function addAuditEntry({ switchId, portName, action, detail, result, error }) {
  db.prepare(
    `INSERT INTO audit_log (id, switch_id, port_name, action, detail_json, result, error)
     VALUES (@id, @switchId, @portName, @action, @detail, @result, @error)`
  ).run({
    id: randomUUID(),
    switchId: switchId || null,
    portName: portName || null,
    action,
    detail: detail ? JSON.stringify(detail) : null,
    result,
    error: error || null,
  });
}

export function listAuditLog(switchId, limit = 200) {
  if (switchId) {
    return db
      .prepare(`SELECT * FROM audit_log WHERE switch_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(switchId, limit);
  }
  return db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// ---- Backups ----

export function addBackupRecord({ switchId, commitHash, reason }) {
  db.prepare(`INSERT INTO backups (id, switch_id, commit_hash, reason) VALUES (?, ?, ?, ?)`).run(
    randomUUID(),
    switchId,
    commitHash,
    reason
  );
}

export function listBackups(switchId) {
  // created_at has only second-level granularity, so two backups made within
  // the same second (e.g. a rename's own backup landing right after a poll's
  // baseline one) sort ambiguously on that column alone; rowid (insertion
  // order) breaks the tie deterministically newest-first.
  return db
    .prepare(`SELECT * FROM backups WHERE switch_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(switchId);
}
