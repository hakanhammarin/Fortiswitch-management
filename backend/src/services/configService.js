import {
  applyPortChange as sshApplyPortChange,
  applyGlobalChange as sshApplyGlobalChange,
  applyHostname as sshApplyHostname,
} from '../ssh/fortiSwitchDevice.js';
import { getSwitch, getSwitchWithCredentials, getSwitchVlans, getPort, updateSwitch, addAuditEntry } from '../repositories.js';
import { pollSwitch } from './switchService.js';
import { backupSwitchConfig, recordBackup } from './backupService.js';
import { validateSwitch } from './desiredStateService.js';

// FortiSwitchOS hostnames are restricted to letters/digits/hyphen/underscore.
const HOSTNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Only these fields may be changed from the UI. Anything else on a port
// (trunking mode, STP, LACP, etc.) is intentionally out of reach here.
const EDITABLE_FIELDS = new Set(['nativeVlan', 'poeEnabled', 'description']);

// A switch's VLANs can be known two ways: formally, via `config switch vlan`
// objects (getSwitchVlans - what a stacked/managed fleet typically has), or
// implicitly, via the `allowed-vlans` tags already set on a port (what a
// flat-trunk switch with routed L3 sub-interfaces has instead - e.g. a
// standalone FS108 with VLANs defined only under `config system interface`,
// never as switch-level VLAN objects). A port's own native-vlan choices
// should come from whichever of those actually has data.
export function validateChangeRequest(switchId, port, changes) {
  const keys = Object.keys(changes);
  const disallowed = keys.filter((k) => !EDITABLE_FIELDS.has(k));
  if (disallowed.length) {
    throw new Error(`Field(s) not editable via this UI: ${disallowed.join(', ')}`);
  }
  if (changes.nativeVlan !== undefined) {
    const switchVlans = getSwitchVlans(switchId).map((v) => v.id);
    const portVlans = port.allowedVlans || [];
    // VLAN 1 is FortiSwitchOS's default/untagged VLAN and isn't required to
    // be a member of allowed-vlans (native-vlan and allowed-vlans are
    // independent settings), so it's always a valid choice regardless of
    // what's tagged on this port.
    const known = new Set([1, ...switchVlans, ...portVlans]);
    if (!known.has(changes.nativeVlan)) {
      throw new Error(
        `VLAN ${changes.nativeVlan} isn't in this port's allowed-vlans ([${portVlans.join(', ')}])` +
          `${switchVlans.length ? ` or the switch's known VLANs ([${switchVlans.join(', ')}])` : ''}. ` +
          `Update allowed-vlans on the switch first if this is intentional.`
      );
    }
  }
  if (changes.description !== undefined && changes.description.length > 63) {
    throw new Error('description must be 63 characters or fewer');
  }
}

/**
 * Applies a whitelisted port-level change end-to-end: validate -> SSH apply ->
 * re-poll the switch to refresh cached state -> backup + git-commit the new
 * running-config -> audit log. Every step is recorded even on failure.
 */
export async function changePort(switchId, portName, changes, { user } = {}) {
  const sw = getSwitch(switchId);
  if (!sw) throw new Error('switch not found');
  const port = getPort(switchId, portName);
  if (!port) throw new Error('port not found');

  try {
    validateChangeRequest(switchId, port, changes);
  } catch (err) {
    addAuditEntry({
      switchId,
      portName,
      action: 'port-change-rejected',
      detail: { changes, user },
      result: 'error',
      error: err.message,
    });
    throw err;
  }

  const creds = getSwitchWithCredentials(switchId);
  try {
    const { runningConfig } = await sshApplyPortChange(
      { host: creds.host, port: creds.ssh_port, username: creds.username, password: creds.password },
      portName,
      changes
    );

    await pollSwitch(switchId);

    const reason = `${sw.name}: ${portName} -> ${Object.entries(changes)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')} (by ${user || 'unknown'})`;
    // The device change above already succeeded and was re-polled, so a
    // backup snag here is reported as its own audit entry rather than
    // turning an otherwise-successful port change into a reported failure.
    let backupResult = { committed: false };
    try {
      backupResult = await backupSwitchConfig(sw.name, runningConfig, reason);
      if (backupResult.committed) {
        recordBackup({ switchId, commitHash: backupResult.commitHash, reason });
      }
    } catch (backupErr) {
      addAuditEntry({ switchId, portName, action: 'backup', result: 'error', error: backupErr.message });
    }

    addAuditEntry({
      switchId,
      portName,
      action: 'port-change-applied',
      detail: { changes, user, commitHash: backupResult.commitHash },
      result: 'success',
    });

    return { ok: true, port: getPort(switchId, portName), backup: backupResult };
  } catch (err) {
    addAuditEntry({
      switchId,
      portName,
      action: 'port-change-applied',
      detail: { changes, user },
      result: 'error',
      error: err.message,
    });
    throw err;
  }
}

export function getEditableFields() {
  return [...EDITABLE_FIELDS];
}

/**
 * Pushes every enforceable violation from the switch's current compliance
 * report to the device in one go: one `config switch interface`/
 * `config switch physical-port` block per drifted port, plus one call for
 * any drifted site-wide (global) settings. Re-polls and re-validates
 * afterward so the caller gets the switch's actual resulting state back, not
 * just an echo of what was requested.
 *
 * Violations without a single correct value (e.g. nativeVlanIn's "one of
 * [...]") are skipped - see `enforceable` on desiredStateService's violation().
 */
export async function enforceSwitch(switchId, { user } = {}) {
  const sw = getSwitch(switchId);
  if (!sw) throw new Error('switch not found');

  const report = validateSwitch(switchId);

  const portChangesByPort = {};
  for (const p of report.ports) {
    const changes = {};
    for (const v of p.violations) {
      if (v.enforceable === false) continue;
      changes[v.field] = v.expected;
    }
    if (Object.keys(changes).length) portChangesByPort[p.portName] = changes;
  }

  const globalChanges = {};
  for (const v of report.globalViolations) {
    if (v.enforceable === false) continue;
    globalChanges[v.field] = v.expected;
  }

  if (!Object.keys(portChangesByPort).length && !Object.keys(globalChanges).length) {
    return { ok: true, applied: false, message: 'Already compliant with the assigned template; nothing to enforce.' };
  }

  const creds = getSwitchWithCredentials(switchId);
  const conn = { host: creds.host, port: creds.ssh_port, username: creds.username, password: creds.password };

  try {
    for (const [portName, changes] of Object.entries(portChangesByPort)) {
      await sshApplyPortChange(conn, portName, changes);
    }
    if (Object.keys(globalChanges).length) {
      await sshApplyGlobalChange(conn, globalChanges);
    }

    const pollResult = await pollSwitch(switchId);

    const reason =
      `${sw.name}: enforced desired state (${report.templateName}) - ` +
      [
        ...Object.entries(portChangesByPort).map(
          ([p, c]) => `${p}: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(',')}`
        ),
        Object.keys(globalChanges).length
          ? `global: ${Object.entries(globalChanges).map(([k, v]) => `${k}=${v}`).join(',')}`
          : null,
      ]
        .filter(Boolean)
        .join('; ') +
      ` (by ${user || 'unknown'})`;

    let backupResult = { committed: false };
    if (pollResult.ok) {
      try {
        backupResult = await backupSwitchConfig(sw.name, pollResult.state.runningConfig, reason);
        if (backupResult.committed) {
          recordBackup({ switchId, commitHash: backupResult.commitHash, reason });
        }
      } catch (backupErr) {
        addAuditEntry({ switchId, action: 'backup', result: 'error', error: backupErr.message });
      }
    }

    addAuditEntry({
      switchId,
      action: 'enforce-applied',
      detail: { portChanges: portChangesByPort, globalChanges, user, commitHash: backupResult.commitHash },
      result: 'success',
    });

    return {
      ok: true,
      applied: true,
      portChanges: portChangesByPort,
      globalChanges,
      report: validateSwitch(switchId),
    };
  } catch (err) {
    addAuditEntry({
      switchId,
      action: 'enforce-applied',
      detail: { portChanges: portChangesByPort, globalChanges, user },
      result: 'error',
      error: err.message,
    });
    throw err;
  }
}

/**
 * Renames a switch in this app's inventory AND syncs the device's own
 * hostname to match over SSH, so the two never drift apart. Applies the
 * hostname change first - if that fails, the in-app name is left untouched
 * rather than getting out of sync with the real device.
 */
export async function renameSwitch(switchId, newName, { user } = {}) {
  const sw = getSwitch(switchId);
  if (!sw) throw new Error('switch not found');
  if (!HOSTNAME_REGEX.test(newName)) {
    throw new Error('name may only contain letters, numbers, hyphens (-), and underscores (_)');
  }

  const oldName = sw.name;
  const creds = getSwitchWithCredentials(switchId);
  try {
    const { runningConfig } = await sshApplyHostname(
      { host: creds.host, port: creds.ssh_port, username: creds.username, password: creds.password },
      newName
    );

    updateSwitch(switchId, { name: newName });
    await pollSwitch(switchId);

    const reason = `${oldName} -> ${newName}: renamed, hostname synced on device (by ${user || 'unknown'})`;
    // Backups from before this rename are still reachable - see
    // findConfigPath() in backupService.js, which resolves a commit's config
    // path from that commit's own tree rather than the switch's current name.
    let backupResult = { committed: false };
    try {
      backupResult = await backupSwitchConfig(newName, runningConfig, reason);
      if (backupResult.committed) {
        recordBackup({ switchId, commitHash: backupResult.commitHash, reason });
      }
    } catch (backupErr) {
      addAuditEntry({ switchId, action: 'backup', result: 'error', error: backupErr.message });
    }

    addAuditEntry({
      switchId,
      action: 'switch-renamed',
      detail: { from: oldName, to: newName, user, commitHash: backupResult.commitHash },
      result: 'success',
    });

    return { ok: true, switch: getSwitch(switchId) };
  } catch (err) {
    addAuditEntry({
      switchId,
      action: 'switch-renamed',
      detail: { from: oldName, to: newName, user },
      result: 'error',
      error: err.message,
    });
    throw err;
  }
}
