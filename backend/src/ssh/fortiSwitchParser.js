// Parses raw FortiSwitchOS CLI text (as produced by sshClient.execCommands) into
// structured JSON. Kept separate from the transport layer so the same parsing
// logic applies whether the text came from the mock server or a real switch.

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

export function parsePortSummary(text) {
  const rows = parseTable(text, ['portName', 'adminStatus', 'operStatus', 'speed', 'nativeVlan', 'description']);
  return rows.map((r) => ({
    portName: r.portName,
    adminStatus: r.adminStatus,
    operStatus: r.operStatus,
    speed: r.speed,
    nativeVlan: Number(r.nativeVlan),
    description: r.description === '-' ? '' : r.description,
  }));
}

export function parsePoeStatus(text) {
  const rows = parseTable(text, ['portName', 'poeStatus', 'poeWatts', 'poeClass']);
  return rows.map((r) => ({
    portName: r.portName,
    poeEnabled: r.poeStatus === 'enabled',
    poeWatts: Number(r.poeWatts) || 0,
    poeClass: r.poeClass === '-' ? null : r.poeClass,
  }));
}

export function parseVlanTable(text) {
  const rows = parseTable(text, ['id', 'name']);
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export function parseMacTable(text) {
  const rows = parseTable(text, ['portName', 'macAddress', 'vlan', 'type']);
  return rows.map((r) => ({
    portName: r.portName,
    macAddress: r.macAddress,
    vlan: Number(r.vlan),
    type: r.type,
  }));
}

// Merges the four separate reads into one port-centric structure.
export function mergePortState({ portSummary, poeStatus, allowedVlansByPort = {} }) {
  const poeByPort = Object.fromEntries(poeStatus.map((p) => [p.portName, p]));
  return portSummary.map((p) => ({
    portName: p.portName,
    adminStatus: p.adminStatus,
    operStatus: p.operStatus,
    speed: p.speed,
    duplex: null,
    nativeVlan: p.nativeVlan,
    allowedVlans: allowedVlansByPort[p.portName] || [],
    poeEnabled: poeByPort[p.portName]?.poeEnabled ?? false,
    poeWatts: poeByPort[p.portName]?.poeWatts ?? 0,
    poeClass: poeByPort[p.portName]?.poeClass ?? null,
    description: p.description,
  }));
}

// Extracts allowed-vlans per port from `show full-configuration switch` text.
export function parseAllowedVlansFromConfig(configText) {
  const result = {};
  const interfaceBlockMatch = configText.match(/config switch interface([\s\S]*?)\nend/);
  if (!interfaceBlockMatch) return result;
  const block = interfaceBlockMatch[1];
  const editRegex = /edit "([^"]+)"([\s\S]*?)next/g;
  let m;
  while ((m = editRegex.exec(block))) {
    const portName = m[1];
    const body = m[2];
    const allowedMatch = body.match(/set allowed-vlans ([\d,]+)/);
    result[portName] = allowedMatch ? allowedMatch[1].split(',').map(Number) : [];
  }
  return result;
}
