// Parses raw FortiSwitchOS CLI text (as produced by sshClient.execCommands) into
// structured JSON. Kept separate from the transport layer so the same parsing
// logic applies whether the text came from the mock server or a real switch.
//
// Command/format choices here are verified against a real standalone
// FortiSwitch-108E-FPOE running v7.4.9 - FortiSwitchOS has no single command
// that reports admin-status/PoE-enabled/native-vlan/allowed-vlans together,
// so port state is assembled from three separate reads (see fortiSwitchDevice.js).

function parseTable(text, columns) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    const row = {};
    columns.forEach((col, i) => {
      row[col] = i === columns.length - 1 ? parts.slice(i).join(' ') : parts[i];
    });
    return row;
  });
}

// `diagnose switch physical-ports summary` - oper status/tag-vlan/duplex/speed
// only. No admin-status or PoE here; those live in the config blocks below.
export function parsePortSummary(text) {
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!/^\S+\s+(up|down)\s+/.test(line)) continue; // skips header/underline/Flags legend
    const [portName, operStatus, , vlanTag, duplex, speed] = line.split(/\s+/);
    rows.push({ portName, operStatus, vlanTag: Number(vlanTag), duplex, speed });
  }
  return rows;
}

// Extracts `edit "name" ... next` blocks under `config <blockName>` from a
// show/show-full-configuration text dump.
function parseConfigBlocks(configText, blockName) {
  const blockMatch = configText.match(new RegExp(`config ${blockName}\\b([\\s\\S]*?)\\nend\\b`));
  if (!blockMatch) return [];
  const body = blockMatch[1];
  const blocks = [];
  const editRegex = /edit "?([^"\n]+?)"?\s*\n([\s\S]*?)\n\s*next\b/g;
  let m;
  while ((m = editRegex.exec(body))) {
    blocks.push({ name: m[1], body: m[2] });
  }
  return blocks;
}

function extractSetValue(body, key) {
  const m = body.match(new RegExp(`^\\s*set ${key} (.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

// Extracts the body of a top-level `config <header> ... end` block, tracking
// nested config/end depth (e.g. `config system ntp` wraps a nested
// `config ntpserver ... end`). parseConfigBlocks()'s edit/next scanning
// doesn't need this since "next" unambiguously closes each edit regardless of
// what's nested inside, but singleton blocks close with a bare "end" that a
// naive non-greedy regex would match on the *inner* block's "end" instead.
function extractConfigBlock(configText, header) {
  const startIdx = configText.indexOf(`config ${header}`);
  if (startIdx === -1) return null;
  const lines = configText.slice(startIdx).split('\n');
  let depth = 0;
  const body = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      depth = 1; // the "config <header>" line itself
      continue;
    }
    const trimmed = lines[i].trim();
    if (/^config\s+/.test(trimmed)) depth++;
    else if (trimmed === 'end') {
      depth--;
      if (depth === 0) break;
    }
    body.push(lines[i]);
  }
  return body.join('\n');
}

// `show full-configuration switch physical-port` - admin-status and PoE live
// here, not under `config switch interface`.
export function parsePhysicalPortConfig(text) {
  return parseConfigBlocks(text, 'switch physical-port').map(({ name, body }) => ({
    portName: name,
    adminStatus: extractSetValue(body, 'status') || 'up',
    poeEnabled: extractSetValue(body, 'poe-status') === 'enable',
    lldpProfile: extractSetValue(body, 'lldp-profile') || '',
    speedConfig: extractSetValue(body, 'speed') || 'auto',
  }));
}

// `config switch global` - site-wide switch settings (e.g. auto-isl).
export function parseSwitchGlobalConfig(configText) {
  const body = extractConfigBlock(configText, 'switch global') || '';
  return { autoIsl: extractSetValue(body, 'auto-isl') };
}

// `config switch auto-network` - automatic device/port detection.
export function parseAutoNetworkConfig(configText) {
  const body = extractConfigBlock(configText, 'switch auto-network') || '';
  return { status: extractSetValue(body, 'status') };
}

// `config system dns`.
export function parseDnsConfig(configText) {
  const body = extractConfigBlock(configText, 'system dns') || '';
  return { primary: extractSetValue(body, 'primary'), secondary: extractSetValue(body, 'secondary') };
}

// `config system ntp` (wraps a nested `config ntpserver ... end`).
export function parseNtpConfig(configText) {
  const body = extractConfigBlock(configText, 'system ntp') || '';
  const serverMatch = body.match(/set server "([^"]+)"/);
  return { server: serverMatch ? serverMatch[1] : null, sync: extractSetValue(body, 'ntpsync') };
}

// `config system global` - hostname (also read back via `get system status`)
// plus admin-lockout hardening (failed-login threshold/duration).
export function parseSystemGlobalConfig(configText) {
  const body = extractConfigBlock(configText, 'system global') || '';
  const duration = extractSetValue(body, 'admin-lockout-duration');
  const threshold = extractSetValue(body, 'admin-lockout-threshold');
  return {
    hostname: extractSetValue(body, 'hostname'),
    adminLockoutDuration: duration !== null ? Number(duration) : null,
    adminLockoutThreshold: threshold !== null ? Number(threshold) : null,
  };
}

// `show full-configuration switch interface` - native-vlan/allowed-vlans/
// description/STP/edge-port live here.
export function parseInterfaceConfig(text) {
  return parseConfigBlocks(text, 'switch interface').map(({ name, body }) => {
    const allowed = extractSetValue(body, 'allowed-vlans');
    return {
      portName: name,
      nativeVlan: Number(extractSetValue(body, 'native-vlan') ?? 1),
      allowedVlans: allowed ? allowed.split(',').map(Number) : [],
      description: extractSetValue(body, 'description') || '',
      stpState: extractSetValue(body, 'stp-state') || 'enabled',
      edgePort: extractSetValue(body, 'edge-port') || 'disabled',
    };
  });
}

export function parseVlanTable(text) {
  const rows = parseTable(text, ['id', 'name']);
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

// `get system arp` - the switch's own ARP table for its routed VLANs
// (100/200/300-style L3 sub-interfaces). Authoritative IP<->MAC mapping for
// discovery, independent of whatever network this backend itself sits on.
export function parseArpTable(text) {
  const rows = parseTable(text, ['ipAddress', 'ageMinutes', 'macAddress', 'iface']);
  return rows.map((r) => ({
    ipAddress: r.ipAddress,
    ageMinutes: Number(r.ageMinutes),
    macAddress: r.macAddress.toLowerCase(),
    iface: r.iface,
  }));
}

// `get switch lldp neighbors-summary` - lists every port (Status here is
// link status, Up/Down - NOT "has a neighbor"), with "-" placeholders in
// every remaining column when that port has no active LLDP neighbor. Verified
// against a real switch: an Up port with nothing plugged into it still gets
// a row, just an all-dashes one.
export function parseLldpNeighbors(text) {
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!/^\S+\s+(up|down)\s+/i.test(line)) continue; // skips header/underline rows
    const [portName, status, deviceName, ttl, capability, medType, remotePortId] = line.split(/\s+/);
    if (deviceName === '-') continue; // no active neighbor on this port
    rows.push({
      portName,
      status,
      deviceName,
      ttl: Number(ttl),
      capability,
      medType,
      remotePortId,
    });
  }
  return rows;
}

// `diagnose switch poe status <port>` - per-port live PoE draw, e.g.:
//   Port(4) Power:8.40W,	Power-Status: Delivering Power
//   Power-Up Mode: Pre-IEEE802.3at Mode
//   ...
//   Power Class: 4
// Queried one port at a time (no summary command exists), and only for
// PoE-enabled ports - see fetchPoeStatus() in fortiSwitchDevice.js. Returns
// null for a non-PoE-capable port (empty response) or any unparsable text.
export function parsePoeStatus(text) {
  const wattsMatch = text.match(/Power:\s*([\d.]+)W/);
  if (!wattsMatch) return null;
  const statusMatch = text.match(/Power-Status:\s*([^\n,]+)/);
  const classMatch = text.match(/Power Class:\s*(\d+)/);
  return {
    watts: Number(wattsMatch[1]),
    status: statusMatch ? statusMatch[1].trim() : null,
    poeClass: classMatch ? Number(classMatch[1]) : null,
  };
}

// `diagnose switch mac-address list` - one text block per entry, e.g.:
//   MAC: 9c:eb:e8:e9:ec:c4	VLAN: 1 Port: port6(port-id 6)
//     Flags: 0x00000041 [ hit dynamic ]
export function parseMacTable(text) {
  const entries = [];
  const re = /MAC:\s*(\S+)\s+VLAN:\s*(\d+)\s+Port:\s*(\S+?)\(port-id[^)]*\)\s*\r?\n\s*Flags:[^[]*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const flags = m[4].trim();
    entries.push({
      portName: m[3],
      macAddress: m[1],
      vlan: Number(m[2]),
      type: flags.includes('static') ? 'static' : 'dynamic',
    });
  }
  return entries;
}

// Merges the separate reads into one port-centric structure. Driven by
// interfaceConfig since that's the authoritative, complete port/trunk list.
export function mergePortState({ opSummary, physicalPortConfig, interfaceConfig, lldpNeighbors = [] }) {
  const opByPort = Object.fromEntries(opSummary.map((p) => [p.portName, p]));
  const physByPort = Object.fromEntries(physicalPortConfig.map((p) => [p.portName, p]));
  const lldpByPort = Object.fromEntries(lldpNeighbors.map((n) => [n.portName, n]));
  return interfaceConfig.map((iface) => {
    const op = opByPort[iface.portName] || {};
    const phys = physByPort[iface.portName] || {};
    const lldp = lldpByPort[iface.portName];
    return {
      portName: iface.portName,
      adminStatus: phys.adminStatus || 'up',
      operStatus: op.operStatus || 'down',
      speed: op.speed || '-',
      duplex: op.duplex || null,
      nativeVlan: iface.nativeVlan,
      allowedVlans: iface.allowedVlans,
      poeEnabled: phys.poeEnabled ?? false,
      // Live wattage/class needs one `diagnose switch poe status <port>` call
      // per port; not fetched during a routine poll to keep it a single
      // round trip. Compliance only needs the enabled/disabled state above.
      poeWatts: 0,
      poeClass: null,
      description: iface.description,
      stpState: iface.stpState,
      edgePort: iface.edgePort,
      lldpProfile: phys.lldpProfile || '',
      speedConfig: phys.speedConfig || 'auto',
      lldpNeighborDevice: lldp?.deviceName || null,
      lldpNeighborPortId: lldp?.remotePortId || null,
    };
  });
}
