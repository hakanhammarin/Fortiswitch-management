import { execCommands, withSession } from './sshClient.js';
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
} from './fortiSwitchParser.js';

const READ_COMMANDS = [
  'get system status',
  'diagnose switch physical-ports summary',
  'show full-configuration switch physical-port',
  'show full-configuration switch interface',
  'get switch vlan',
  'diagnose switch mac-address list',
  'get system arp', // the switch's own ARP table - authoritative IP<->MAC for its routed VLANs
  'get switch lldp neighbors-summary', // per-port LLDP neighbor (remote device-name/port-id)
  'show', // full non-default system+switch config, used only for the git backup snapshot
];

function parseSystemStatus(text) {
  const info = {};
  text.split('\n').forEach((line) => {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) info[m[1].trim()] = m[2].trim();
  });
  return info;
}

// No summary command reports live PoE draw per port - it has to be queried
// one port at a time (`diagnose switch poe status <port>`). Only asking for
// PoE-enabled ports keeps this proportional (typically <=8 extra commands on
// an FS108) rather than querying every port including ones that can't carry
// PoE at all (uplinks, "internal").
async function fetchPoeStatus(send, portNames) {
  if (!portNames.length) return {};
  const outputs = await send(portNames.map((p) => `diagnose switch poe status ${p}`));
  const result = {};
  portNames.forEach((portName, i) => {
    const parsed = parsePoeStatus(outputs[i]);
    if (parsed) result[portName] = parsed;
  });
  return result;
}

// Reads the full switch state over one persistent SSH session: the main
// batch, then (once the PoE-enabled port list is known) one extra round trip
// for their live PoE draw. Deliberately NOT two separate connections -
// reconnecting for a second batch right after the first closes has been
// observed to get rejected with "All configured authentication methods
// failed" against a real FortiSwitch-108E-FPOE, even with valid credentials
// (see withSession() in sshClient.js).
export async function fetchSwitchState(conn) {
  return withSession(conn, async (send) => {
    const [sysText, opSummaryText, physPortConfigText, interfaceConfigText, vlanText, macText, arpText, lldpText, runningConfig] =
      await send(READ_COMMANDS);
    const opSummary = parsePortSummary(opSummaryText);
    const physicalPortConfig = parsePhysicalPortConfig(physPortConfigText);
    const interfaceConfig = parseInterfaceConfig(interfaceConfigText);
    const vlans = parseVlanTable(vlanText);
    const macEntries = parseMacTable(macText);
    const arpEntries = parseArpTable(arpText);
    const lldpNeighbors = parseLldpNeighbors(lldpText);
    const ports = mergePortState({ opSummary, physicalPortConfig, interfaceConfig, lldpNeighbors });

    const poeStatusByPort = await fetchPoeStatus(send, ports.filter((p) => p.poeEnabled).map((p) => p.portName));
    for (const port of ports) {
      const poe = poeStatusByPort[port.portName];
      if (poe) {
        port.poeWatts = poe.watts;
        port.poeClass = poe.poeClass != null ? `class${poe.poeClass}` : port.poeClass;
      }
    }

    // The bare `show` we already fetch for the git backup snapshot also carries
    // the site-wide switch/system settings - no extra round trip needed.
    const globalConfig = {
      switchGlobal: parseSwitchGlobalConfig(runningConfig),
      autoNetwork: parseAutoNetworkConfig(runningConfig),
      dns: parseDnsConfig(runningConfig),
      ntp: parseNtpConfig(runningConfig),
      systemGlobal: parseSystemGlobalConfig(runningConfig),
    };
    return { systemInfo: parseSystemStatus(sysText), ports, vlans, macEntries, arpEntries, runningConfig, globalConfig };
  });
}

// Rejects anything that could break out of a quoted CLI argument or inject a
// second command via an embedded newline.
function sanitizeCliString(value) {
  if (/[\r\n"]/.test(value)) {
    throw new Error('value contains disallowed characters (quotes/newlines)');
  }
  return value;
}

/**
 * Applies a whitelisted set of port-level changes in one SSH session, then
 * immediately re-reads the running-config in the same session so the caller
 * can back it up without a second connection.
 *
 * native-vlan/allowed-vlans/description/stp-state/edge-port live under
 * `config switch interface`; PoE/admin-status/lldp-profile/speed live under
 * the separate `config switch physical-port` scope (confirmed against a real
 * FortiSwitch-108E-FPOE - `set poe-status` is not a recognized keyword under
 * `config switch interface`), so each touched scope gets its own
 * edit/next/end block.
 */
export async function applyPortChange(conn, portName, changes) {
  sanitizeCliString(portName);
  const commands = [];

  const interfaceChanges = [];
  if (changes.nativeVlan !== undefined) {
    if (!Number.isInteger(changes.nativeVlan) || changes.nativeVlan < 1 || changes.nativeVlan > 4094) {
      throw new Error('nativeVlan must be an integer between 1 and 4094');
    }
    interfaceChanges.push(`set native-vlan ${changes.nativeVlan}`);
  }
  if (changes.allowedVlans !== undefined) {
    interfaceChanges.push(`set allowed-vlans ${changes.allowedVlans.join(',')}`);
  }
  if (changes.description !== undefined) {
    interfaceChanges.push(`set description "${sanitizeCliString(changes.description)}"`);
  }
  if (changes.stpState !== undefined) {
    interfaceChanges.push(`set stp-state ${changes.stpState}`);
  }
  if (changes.edgePort !== undefined) {
    interfaceChanges.push(`set edge-port ${changes.edgePort}`);
  }
  if (interfaceChanges.length) {
    commands.push('config switch interface', `edit ${portName}`, ...interfaceChanges, 'next', 'end');
  }

  const physicalPortChanges = [];
  if (changes.poeEnabled !== undefined) {
    physicalPortChanges.push(`set poe-status ${changes.poeEnabled ? 'enable' : 'disable'}`);
  }
  if (changes.adminStatus !== undefined) {
    physicalPortChanges.push(`set status ${changes.adminStatus}`);
  }
  if (changes.lldpProfile !== undefined) {
    physicalPortChanges.push(`set lldp-profile "${sanitizeCliString(changes.lldpProfile)}"`);
  }
  if (changes.speedConfig !== undefined) {
    physicalPortChanges.push(`set speed ${changes.speedConfig}`);
  }
  if (physicalPortChanges.length) {
    commands.push('config switch physical-port', `edit ${portName}`, ...physicalPortChanges, 'next', 'end');
  }

  commands.push('show');
  const outputs = await execCommands(conn, commands);
  return { runningConfig: outputs[outputs.length - 1] };
}

/**
 * Applies site-wide (non-per-port) switch/system settings, each in its own
 * scope. NTP's server lives in a nested `config ntpserver / edit 1` block
 * inside `config system ntp` (see parseNtpConfig()'s note on real
 * FortiSwitchOS nesting the same way).
 */
export async function applyGlobalChange(conn, changes) {
  const commands = [];

  if (changes['switchGlobal.autoIsl'] !== undefined) {
    commands.push('config switch global', `set auto-isl ${changes['switchGlobal.autoIsl']}`, 'end');
  }
  if (changes['autoNetwork.status'] !== undefined) {
    commands.push('config switch auto-network', `set status ${changes['autoNetwork.status']}`, 'end');
  }
  if (changes['dns.primary'] !== undefined || changes['dns.secondary'] !== undefined) {
    const dnsCommands = [];
    if (changes['dns.primary'] !== undefined) dnsCommands.push(`set primary ${sanitizeCliString(changes['dns.primary'])}`);
    if (changes['dns.secondary'] !== undefined) dnsCommands.push(`set secondary ${sanitizeCliString(changes['dns.secondary'])}`);
    commands.push('config system dns', ...dnsCommands, 'end');
  }
  if (changes['ntp.server'] !== undefined || changes['ntp.sync'] !== undefined) {
    const ntpCommands = [];
    if (changes['ntp.server'] !== undefined) {
      ntpCommands.push('config ntpserver', 'edit 1', `set server "${sanitizeCliString(changes['ntp.server'])}"`, 'next', 'end');
    }
    if (changes['ntp.sync'] !== undefined) ntpCommands.push(`set ntpsync ${changes['ntp.sync']}`);
    commands.push('config system ntp', ...ntpCommands, 'end');
  }
  if (changes['systemGlobal.adminLockoutDuration'] !== undefined || changes['systemGlobal.adminLockoutThreshold'] !== undefined) {
    const sysGlobalCommands = [];
    if (changes['systemGlobal.adminLockoutDuration'] !== undefined) {
      sysGlobalCommands.push(`set admin-lockout-duration ${changes['systemGlobal.adminLockoutDuration']}`);
    }
    if (changes['systemGlobal.adminLockoutThreshold'] !== undefined) {
      sysGlobalCommands.push(`set admin-lockout-threshold ${changes['systemGlobal.adminLockoutThreshold']}`);
    }
    commands.push('config system global', ...sysGlobalCommands, 'end');
  }

  commands.push('show');
  const outputs = await execCommands(conn, commands);
  return { runningConfig: outputs[outputs.length - 1] };
}

// Hostname lives under `config system global`, a different scope than the
// `config switch global`/`auto-network`/`dns`/`ntp` settings above (verified
// against a real FortiSwitch-108E-FPOE - "set hostname" appears in that
// switch's own `config system global` block).
export async function applyHostname(conn, hostname) {
  const commands = ['config system global', `set hostname "${sanitizeCliString(hostname)}"`, 'end', 'show'];
  const outputs = await execCommands(conn, commands);
  return { runningConfig: outputs[outputs.length - 1] };
}
