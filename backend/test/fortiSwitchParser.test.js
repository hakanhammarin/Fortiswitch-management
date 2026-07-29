import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePortSummary,
  parsePhysicalPortConfig,
  parseInterfaceConfig,
  parseVlanTable,
  parseMacTable,
  mergePortState,
  parseSwitchGlobalConfig,
  parseAutoNetworkConfig,
  parseDnsConfig,
  parseNtpConfig,
  parseArpTable,
  parseLldpNeighbors,
  parsePoeStatus,
  parseSystemGlobalConfig,
} from '../src/ssh/fortiSwitchParser.js';

// Sample text below is captured verbatim from a real standalone
// FortiSwitch-108E-FPOE running FortiSwitchOS v7.4.9.

test('parsePortSummary', () => {
  const text = [
    '  Portname    Status  Tpid  Vlan  Duplex  Speed  Flags         Discard',
    '  __________  ______  ____  ____  ______  _____  ____________  _________',
    '',
    '  port1       down    8100  1     half    -      QS,  ,        none     ',
    '  port6       up      8100  1     full    1G     QS,  ,        none     ',
    '',
    '  Flags: QS(802.1Q) QE(802.1Q-in-Q,external) QI(802.1Q-in-Q,internal)',
  ].join('\n');
  const rows = parsePortSummary(text);
  assert.deepEqual(rows, [
    { portName: 'port1', operStatus: 'down', vlanTag: 1, duplex: 'half', speed: '-' },
    { portName: 'port6', operStatus: 'up', vlanTag: 1, duplex: 'full', speed: '1G' },
  ]);
});

test('parsePhysicalPortConfig', () => {
  const text = [
    'config switch physical-port',
    '    edit "port1"',
    '        set cdp-status disable',
    '        set lldp-profile "default"',
    '        set poe-status enable',
    '        set speed auto',
    '        set status up',
    '    next',
    '    edit "port9"',
    '        set poe-status disable',
    '        set speed 1000full',
    '        set status down',
    '    next',
    'end',
  ].join('\n');
  assert.deepEqual(parsePhysicalPortConfig(text), [
    { portName: 'port1', adminStatus: 'up', poeEnabled: true, lldpProfile: 'default', speedConfig: 'auto' },
    { portName: 'port9', adminStatus: 'down', poeEnabled: false, lldpProfile: '', speedConfig: '1000full' },
  ]);
});

test('parseInterfaceConfig', () => {
  const text = [
    'config switch interface',
    '    edit "port23"',
    '        set description \'\'',
    '        set native-vlan 99',
    '        set allowed-vlans 1,10,20,30,99',
    '        set stp-state disabled',
    '        set edge-port disabled',
    '    next',
    '    edit "port1"',
    '        set description \'uplink\'',
    '        set native-vlan 10',
    '    next',
    'end',
  ].join('\n');
  assert.deepEqual(parseInterfaceConfig(text), [
    { portName: 'port23', nativeVlan: 99, allowedVlans: [1, 10, 20, 30, 99], description: '', stpState: 'disabled', edgePort: 'disabled' },
    { portName: 'port1', nativeVlan: 10, allowedVlans: [], description: 'uplink', stpState: 'enabled', edgePort: 'disabled' },
  ]);
});

test('parseVlanTable', () => {
  const text = ['VLAN-ID  Name', '1        default', '10       corp-users'].join('\n');
  assert.deepEqual(parseVlanTable(text), [
    { id: 1, name: 'default' },
    { id: 10, name: 'corp-users' },
  ]);
});

test('parseArpTable', () => {
  const text = [
    'Address           Age(min)   Hardware Addr      Interface',
    '192.168.1.99      7          04:d5:90:60:3b:e0  internal',
    '192.168.1.11      0          9c:eb:e8:e9:ec:c4  internal',
  ].join('\n');
  assert.deepEqual(parseArpTable(text), [
    { ipAddress: '192.168.1.99', ageMinutes: 7, macAddress: '04:d5:90:60:3b:e0', iface: 'internal' },
    { ipAddress: '192.168.1.11', ageMinutes: 0, macAddress: '9c:eb:e8:e9:ec:c4', iface: 'internal' },
  ]);
});

test('parseLldpNeighbors skips dash-placeholder rows for ports with no neighbor', () => {
  // Real device output: every port gets a row (Status = link status, not
  // "has a neighbor"); ports with nothing detected show all-dash columns,
  // including ports that are themselves link-Up with nothing plugged in.
  const text = [
    ' Portname    Status   Device-name                 TTL   Capability  MED-type  Port-ID',
    '  __________  _______  __________________________  ____  __________  ________  _______',
    '  port1       Down     -                           -     -           -         -',
    '  port6       Up       SW38-BB_SPEAKER             120   BR          Network   port8',
    '  port7       Up       -                           -     -           -         -',
  ].join('\n');
  assert.deepEqual(parseLldpNeighbors(text), [
    { portName: 'port6', status: 'Up', deviceName: 'SW38-BB_SPEAKER', ttl: 120, capability: 'BR', medType: 'Network', remotePortId: 'port8' },
  ]);
});

test('parsePoeStatus - port actively delivering power', () => {
  const text = [
    'Port(4) Power:8.40W,\tPower-Status: Delivering Power',
    'Power-Up Mode: Pre-IEEE802.3at Mode',
    'PD type: Valid Resistor detected',
    'Remote Power Device Type: IEEE802.3AT PD',
    'Power Class: 4',
    'Defined Max Power: 30.0W, Priority: Low.',
    'Voltage: 55.30V',
    'Current: 153mA',
    'LLDP PoE negotiation enabled.',
  ].join('\n');
  assert.deepEqual(parsePoeStatus(text), { watts: 8.4, status: 'Delivering Power', poeClass: 4 });
});

test('parsePoeStatus - PoE-enabled port with nothing plugged in', () => {
  const text = [
    'Port(1) Power:0.00W,\tPower-Status: Searching',
    'Power-Up Mode: Pre-IEEE802.3at Mode',
    'Remote Power Device Type: PD None',
    'Power Class: 0',
    'Defined Max Power: 0.0W, Priority: Low.',
    'Voltage: 0.00V',
    'Current: 0mA',
    'LLDP PoE negotiation enabled.',
  ].join('\n');
  assert.deepEqual(parsePoeStatus(text), { watts: 0, status: 'Searching', poeClass: 0 });
});

test('parsePoeStatus - non-PoE-capable port returns null', () => {
  assert.equal(parsePoeStatus(''), null);
});

test('parseMacTable', () => {
  const text = [
    'MAC: 9c:eb:e8:e9:ec:c4\tVLAN: 1 Port: port6(port-id 6)',
    '  Flags: 0x00000041 [ hit dynamic ]',
    '',
    'MAC: 04:d5:90:ba:a4:78\tVLAN: 100 Port: internal(port-id 11)',
    '  Flags: 0x00000060 [ static ]',
  ].join('\n');
  assert.deepEqual(parseMacTable(text), [
    { portName: 'port6', macAddress: '9c:eb:e8:e9:ec:c4', vlan: 1, type: 'dynamic' },
    { portName: 'internal', macAddress: '04:d5:90:ba:a4:78', vlan: 100, type: 'static' },
  ]);
});

test('mergePortState combines oper/physical-port/interface reads', () => {
  const merged = mergePortState({
    opSummary: [{ portName: 'port1', operStatus: 'up', vlanTag: 1, duplex: 'full', speed: '1G' }],
    physicalPortConfig: [{ portName: 'port1', adminStatus: 'up', poeEnabled: true, lldpProfile: 'default', speedConfig: 'auto' }],
    interfaceConfig: [
      { portName: 'port1', nativeVlan: 1, allowedVlans: [100, 200, 300], description: '', stpState: 'disabled', edgePort: 'disabled' },
    ],
    lldpNeighbors: [{ portName: 'port1', deviceName: 'sw38', remotePortId: 'port6' }],
  });
  assert.deepEqual(merged, [
    {
      portName: 'port1',
      adminStatus: 'up',
      operStatus: 'up',
      speed: '1G',
      duplex: 'full',
      nativeVlan: 1,
      allowedVlans: [100, 200, 300],
      poeEnabled: true,
      poeWatts: 0,
      poeClass: null,
      description: '',
      stpState: 'disabled',
      edgePort: 'disabled',
      lldpProfile: 'default',
      speedConfig: 'auto',
      lldpNeighborDevice: 'sw38',
      lldpNeighborPortId: 'port6',
    },
  ]);
});

// Site-wide (non-per-port) settings, parsed out of the bare `show` dump
// already fetched for the git backup snapshot.

test('parseSwitchGlobalConfig', () => {
  const present = ['config switch global', '    set auto-isl disable', 'end'].join('\n');
  assert.deepEqual(parseSwitchGlobalConfig(present), { autoIsl: 'disable' });

  const empty = ['config switch global', 'end'].join('\n');
  assert.deepEqual(parseSwitchGlobalConfig(empty), { autoIsl: null });
});

test('parseSystemGlobalConfig', () => {
  const text = [
    'config system global',
    '    set dst enable',
    '    set hostname "sw37"',
    '    set admin-lockout-duration 1',
    '    set admin-lockout-threshold 10',
    '    set timezone 26',
    'end',
  ].join('\n');
  assert.deepEqual(parseSystemGlobalConfig(text), {
    hostname: 'sw37',
    adminLockoutDuration: 1,
    adminLockoutThreshold: 10,
  });

  const empty = ['config system global', 'end'].join('\n');
  assert.deepEqual(parseSystemGlobalConfig(empty), {
    hostname: null,
    adminLockoutDuration: null,
    adminLockoutThreshold: null,
  });
});

test('parseAutoNetworkConfig', () => {
  const present = ['config switch auto-network', '    set status disable', 'end'].join('\n');
  assert.deepEqual(parseAutoNetworkConfig(present), { status: 'disable' });

  assert.deepEqual(parseAutoNetworkConfig('config system global\nend'), { status: null });
});

test('parseDnsConfig', () => {
  const text = ['config system dns', '    set primary 192.168.1.1', '    set secondary 192.168.1.99', 'end'].join('\n');
  assert.deepEqual(parseDnsConfig(text), { primary: '192.168.1.1', secondary: '192.168.1.99' });
});

test('parseNtpConfig handles the nested config ntpserver block', () => {
  const text = [
    'config system ntp',
    '    config ntpserver',
    '        edit 1',
    '            set server "192.168.1.1"',
    '        next',
    '    end',
    '    set ntpsync enable',
    'end',
  ].join('\n');
  assert.deepEqual(parseNtpConfig(text), { server: '192.168.1.1', sync: 'enable' });
});
