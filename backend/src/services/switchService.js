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

// FortiSwitchOS rejects a second concurrent SSH session per account (the pty
// request comes back as "Unable to request a pseudo-terminal", sometimes with
// the first session getting ECONNRESET). The background loop and a manual
// "poll now" from the frontend can otherwise both dial the same switch at
// once, so in-flight polls are deduped per switch id.
const inFlightPolls = new Map();

export function pollSwitch(switchId) {
  const existing = inFlightPolls.get(switchId);
  if (existing) return existing;

  const promise = pollSwitchNow(switchId).finally(() => inFlightPolls.delete(switchId));
  inFlightPolls.set(switchId, promise);
  return promise;
}

async function pollSwitchNow(switchId) {
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
    setSwitchStatus(switchId, {
      reachable: true,
      systemInfo: state.systemInfo,
      vlans: state.vlans,
      globalConfig: state.globalConfig,
    });
    addAuditEntry({ switchId, action: 'poll', result: 'success' });

    // Isolated from the poll's own try/catch: a rejected/invalid backup
    // (see backupSwitchConfig's validity check) shouldn't flip an otherwise
    // successful poll to "unreachable" - it's recorded as its own audit entry
    // so it stays visible instead of silently never happening.
    if (listBackups(switchId).length === 0) {
      try {
        const backupResult = await backupSwitchConfig(sw.name, state.runningConfig, `${sw.name}: baseline backup on first poll`);
        if (backupResult.committed) {
          recordBackup({ switchId, commitHash: backupResult.commitHash, reason: 'baseline backup on first poll' });
        }
      } catch (backupErr) {
        addAuditEntry({ switchId, action: 'baseline-backup', result: 'error', error: backupErr.message });
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
  // results[i] corresponds to switches[i] - Promise.all preserves input order.
  const arpBySwitch = {};
  switches.forEach((s, i) => {
    if (results[i].ok) arpBySwitch[s.id] = results[i].state.arpEntries;
  });
  runDiscoveryCycle(portsBySwitch, arpBySwitch);

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
