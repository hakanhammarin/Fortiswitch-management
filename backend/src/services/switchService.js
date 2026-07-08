import { fetchSwitchState } from '../ssh/fortiSwitchDevice.js';
import {
  listSwitches,
  getSwitchWithCredentials,
  setSwitchStatus,
  replacePorts,
  replaceMacEntries,
  listPorts,
  addAuditEntry,
  listBackups,
} from '../repositories.js';
import { runDiscoveryCycle } from './arpDiscoveryService.js';
import { backupSwitchConfig, recordBackup } from './backupService.js';

export async function pollSwitch(switchId) {
  const sw = getSwitchWithCredentials(switchId);
  if (!sw) throw new Error('switch not found');
  try {
    const state = await fetchSwitchState({
      host: sw.host,
      port: sw.ssh_port,
      username: sw.username,
      password: sw.password,
    });
    replacePorts(
      switchId,
      state.ports.map((p) => ({ ...p, switchId }))
    );
    replaceMacEntries(switchId, state.macEntries);
    setSwitchStatus(switchId, { reachable: true, systemInfo: state.systemInfo, vlans: state.vlans });
    addAuditEntry({ switchId, action: 'poll', result: 'success' });

    if (listBackups(switchId).length === 0) {
      const backupResult = await backupSwitchConfig(sw.name, state.runningConfig, `${sw.name}: baseline backup on first poll`);
      if (backupResult.committed) {
        recordBackup({ switchId, commitHash: backupResult.commitHash, reason: 'baseline backup on first poll' });
      }
    }

    return { ok: true, state };
  } catch (err) {
    setSwitchStatus(switchId, { reachable: false, lastError: err.message });
    addAuditEntry({ switchId, action: 'poll', result: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
}

export async function pollAllSwitches() {
  const switches = listSwitches();
  const results = await Promise.all(switches.map((s) => pollSwitch(s.id)));

  const portsBySwitch = {};
  for (const s of switches) portsBySwitch[s.id] = listPorts(s.id);
  runDiscoveryCycle(portsBySwitch);

  return results;
}

let pollTimer = null;

export function startPollingLoop(intervalMs = 30000) {
  if (pollTimer) clearInterval(pollTimer);
  pollAllSwitches().catch((err) => console.error('[poll] initial poll failed:', err));
  pollTimer = setInterval(() => {
    pollAllSwitches().catch((err) => console.error('[poll] cycle failed:', err));
  }, intervalMs);
  return pollTimer;
}

export function stopPollingLoop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
