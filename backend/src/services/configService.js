import { applyPortChange as sshApplyPortChange } from '../ssh/fortiSwitchDevice.js';
import { getSwitch, getSwitchWithCredentials, getSwitchVlans, getPort, addAuditEntry } from '../repositories.js';
import { pollSwitch } from './switchService.js';
import { backupSwitchConfig, recordBackup } from './backupService.js';

// Only these fields may be changed from the UI. Anything else on a port
// (trunking mode, STP, LACP, etc.) is intentionally out of reach here.
const EDITABLE_FIELDS = new Set(['nativeVlan', 'poeEnabled', 'description']);

export function validateChangeRequest(switchId, changes) {
  const keys = Object.keys(changes);
  const disallowed = keys.filter((k) => !EDITABLE_FIELDS.has(k));
  if (disallowed.length) {
    throw new Error(`Field(s) not editable via this UI: ${disallowed.join(', ')}`);
  }
  if (changes.nativeVlan !== undefined) {
    const knownVlans = getSwitchVlans(switchId).map((v) => v.id);
    if (knownVlans.length && !knownVlans.includes(changes.nativeVlan)) {
      throw new Error(
        `VLAN ${changes.nativeVlan} does not exist on this switch (known VLANs: ${knownVlans.join(', ')}). ` +
          `Create the VLAN on the switch first if this is intentional.`
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
    validateChangeRequest(switchId, changes);
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
    const backupResult = await backupSwitchConfig(sw.name, runningConfig, reason);
    if (backupResult.committed) {
      recordBackup({ switchId, commitHash: backupResult.commitHash, reason });
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
