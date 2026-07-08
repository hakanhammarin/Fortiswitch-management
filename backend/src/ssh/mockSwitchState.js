// In-memory model of a FortiSwitch device used by the mock SSH server.
// Mirrors the subset of FortiSwitchOS state this app cares about: physical
// ports, PoE, VLANs, and the MAC address table.

const MAC_POOL_HOSTS = [
  'DESK-ANNA', 'DESK-BJORN', 'PRINTER-2F', 'AP-LOBBY', 'AP-HALLWAY', 'CAM-ENTRANCE',
  'PHONE-201', 'PHONE-202', 'NAS-BACKUP', 'DESK-CARL', 'AP-KITCHEN', 'TV-CONFROOM',
];

function randomMac(seed) {
  const bytes = [0x00, 0x1c, 0x2e];
  let x = seed * 2654435761 % 2 ** 32;
  for (let i = 0; i < 3; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 32;
    bytes.push(Math.floor((x / 2 ** 32) * 256));
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

export function createDefaultState({ name = 'FS-MOCK-01', model = 'FortiSwitch-124F-POE', portCount = 24 } = {}) {
  const vlans = [
    { id: 1, name: 'default' },
    { id: 10, name: 'corp-users' },
    { id: 20, name: 'voip' },
    { id: 30, name: 'guest' },
    { id: 99, name: 'mgmt' },
  ];

  const ports = [];
  for (let i = 1; i <= portCount; i++) {
    const portName = `port${i}`;
    const isUplink = i > portCount - 2;
    const hasDevice = !isUplink && i - 1 < MAC_POOL_HOSTS.length;
    ports.push({
      portName,
      adminStatus: 'up',
      operStatus: isUplink || hasDevice ? 'up' : 'down',
      speed: isUplink ? '1000full' : hasDevice ? '1000full' : 'auto',
      duplex: 'full',
      nativeVlan: isUplink ? 99 : hasDevice && i % 4 === 0 ? 20 : 10,
      allowedVlans: isUplink ? [1, 10, 20, 30, 99] : [],
      poeEnabled: !isUplink,
      poeWatts: hasDevice ? Number((3 + (i % 5) * 2.7).toFixed(1)) : 0,
      poeClass: hasDevice ? `class${1 + (i % 4)}` : null,
      description: isUplink ? 'uplink-to-core' : hasDevice ? `${MAC_POOL_HOSTS[i - 1]}` : '',
    });
  }

  const macEntries = [];
  ports.forEach((p, idx) => {
    if (p.operStatus === 'up' && !p.description.startsWith('uplink')) {
      macEntries.push({
        portName: p.portName,
        macAddress: randomMac(idx + 1),
        vlan: p.nativeVlan,
        type: 'dynamic',
      });
    }
  });
  // A few MACs learned on the uplink (devices beyond the switch, e.g. downstream AP clients)
  macEntries.push({ portName: `port${portCount}`, macAddress: randomMac(999), vlan: 10, type: 'dynamic' });
  macEntries.push({ portName: `port${portCount}`, macAddress: randomMac(998), vlan: 20, type: 'dynamic' });

  return {
    hostname: name,
    model,
    version: 'v7.4.4,build0668',
    serial: `S124FP${(1000 + Math.floor(Math.random() * 8999))}TB000000`,
    vlans,
    ports,
    macEntries,
  };
}

export function renderRunningConfig(state) {
  const lines = [];
  lines.push('#config-version=' + state.model.toLowerCase() + '-7.4.4-FW-build0668-240101:opmode=0:vdom=0');
  lines.push(`#hostname="${state.hostname}"`);
  lines.push('');
  lines.push('config switch vlan');
  for (const v of state.vlans) {
    lines.push(`    edit ${v.id}`);
    lines.push(`        set name "${v.name}"`);
    lines.push('    next');
  }
  lines.push('end');
  lines.push('');
  lines.push('config switch interface');
  for (const p of state.ports) {
    lines.push(`    edit "${p.portName}"`);
    lines.push(`        set native-vlan ${p.nativeVlan}`);
    if (p.allowedVlans?.length) lines.push(`        set allowed-vlans ${p.allowedVlans.join(',')}`);
    lines.push(`        set poe-status ${p.poeEnabled ? 'enable' : 'disable'}`);
    if (p.description) lines.push(`        set description "${p.description}"`);
    lines.push(`        set status ${p.adminStatus}`);
    lines.push('    next');
  }
  lines.push('end');
  return lines.join('\n');
}
