import { execCommands } from './sshClient.js';
import {
  parsePortSummary,
  parsePoeStatus,
  parseVlanTable,
  parseMacTable,
  mergePortState,
  parseAllowedVlansFromConfig,
} from './fortiSwitchParser.js';

const READ_COMMANDS = [
  'get system status',
  'get switch physical-port-summary',
  'diagnose switch physical-ports poe-status',
  'get switch vlan',
  'diagnose switch mac-address list',
  'show full-configuration switch',
];

function parseSystemStatus(text) {
  const info = {};
  text.split('\n').forEach((line) => {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) info[m[1].trim()] = m[2].trim();
  });
  return info;
}

// Reads the full switch state in a single SSH session (one connect/auth round trip).
export async function fetchSwitchState(conn) {
  const [sysText, portSummaryText, poeText, vlanText, macText, configText] = await execCommands(
    conn,
    READ_COMMANDS
  );
  const portSummary = parsePortSummary(portSummaryText);
  const poeStatus = parsePoeStatus(poeText);
  const vlans = parseVlanTable(vlanText);
  const macEntries = parseMacTable(macText);
  const allowedVlansByPort = parseAllowedVlansFromConfig(configText);
  const ports = mergePortState({ portSummary, poeStatus, allowedVlansByPort });
  return { systemInfo: parseSystemStatus(sysText), ports, vlans, macEntries, runningConfig: configText };
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
 * immediately re-reads the full running-config in the same session so the
 * caller can back it up without a second connection.
 */
export async function applyPortChange(conn, portName, changes) {
  sanitizeCliString(portName);
  const commands = ['config switch interface', `edit ${portName}`];

  if (changes.nativeVlan !== undefined) {
    if (!Number.isInteger(changes.nativeVlan) || changes.nativeVlan < 1 || changes.nativeVlan > 4094) {
      throw new Error('nativeVlan must be an integer between 1 and 4094');
    }
    commands.push(`set native-vlan ${changes.nativeVlan}`);
  }
  if (changes.poeEnabled !== undefined) {
    commands.push(`set poe-status ${changes.poeEnabled ? 'enable' : 'disable'}`);
  }
  if (changes.description !== undefined) {
    commands.push(`set description "${sanitizeCliString(changes.description)}"`);
  }

  commands.push('next', 'end', 'show full-configuration switch');
  const outputs = await execCommands(conn, commands);
  return { runningConfig: outputs[outputs.length - 1] };
}
