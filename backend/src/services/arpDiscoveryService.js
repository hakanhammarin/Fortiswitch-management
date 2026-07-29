import { execSync } from 'node:child_process';
import os from 'node:os';
import { listMacEntries, upsertDiscovery, listDiscovery } from '../repositories.js';

// Best-effort real discovery: the switch's own ARP table, then this backend
// host's local ARP/neighbor cache, then mDNS (avahi-browse) and NetBIOS
// (nbtscan) for hostnames. When none of those have an answer, the MAC is
// recorded with no IP/hostname rather than a fabricated placeholder - a
// made-up IP that happens to look real is worse than an honest "unknown".

// Both `ip neigh`'s and macOS `arp -a`'s MAC formatting can drop leading
// zeros per octet (macOS: "4:d5:90:ba:a4:78" instead of "04:d5:..."), which
// would silently fail to match against the switch's own zero-padded MAC
// table entries if left un-normalized.
function normalizeMac(mac) {
  return mac
    .toLowerCase()
    .split(':')
    .map((o) => o.padStart(2, '0'))
    .join(':');
}

function tryArpTable() {
  try {
    // `ip neigh show` is Linux-only (iproute2); macOS has no such command and
    // uses BSD `arp -a` instead, with a different output format.
    if (os.platform() === 'darwin') {
      const out = execSync('arp -a', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const entries = [];
      for (const line of out.split('\n')) {
        const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]+)/);
        if (m) entries.push({ ip: m[1], mac: normalizeMac(m[2]) });
      }
      return entries;
    }
    const out = execSync('ip neigh show', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const entries = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+.*lladdr\s+([0-9a-fA-F:]+)/);
      if (m) entries.push({ ip: m[1], mac: normalizeMac(m[2]) });
    }
    return entries;
  } catch {
    return [];
  }
}

function tryMdnsNames() {
  try {
    const out = execSync('avahi-browse -art --terminate', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const names = {};
    const hostMatches = out.matchAll(/hostname = \[([^\]]+)\]\s*\n\s*address = \[([^\]]+)\]/g);
    for (const m of hostMatches) names[m[2]] = m[1].replace(/\.local$/, '');
    return names; // ip -> hostname
  } catch {
    return {};
  }
}

function tryNetbiosNames() {
  try {
    const out = execSync('nbtscan -q 0.0.0.0/24', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const names = {};
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)/);
      if (m) names[m[1]] = m[2];
    }
    return names;
  } catch {
    return {};
  }
}

/**
 * Correlates every MAC currently seen in a switch's MAC address table with an
 * IP and a friendly name, caching results in discovery_cache. IP lookup tries,
 * in order: the switch's own ARP table (arpBySwitch - authoritative for its
 * routed VLANs, from `get system arp`), then this backend host's local
 * ARP/neighbor cache (only useful if it happens to share a broadcast domain
 * with the device). Hostnames come from mDNS/NetBIOS when available, else the
 * port's own `description`. A MAC with no real IP anywhere is recorded as
 * such (null ip/hostname) - never a fabricated placeholder.
 */
export function runDiscoveryCycle(portsBySwitch, arpBySwitch = {}) {
  const localArpByMac = Object.fromEntries(tryArpTable().map((e) => [e.mac, e.ip]));
  const mdns = tryMdnsNames();
  const netbios = tryNetbiosNames();

  const results = [];
  for (const switchId of Object.keys(portsBySwitch)) {
    const ports = portsBySwitch[switchId];
    const switchArpByMac = Object.fromEntries(
      (arpBySwitch[switchId] || []).map((e) => [normalizeMac(e.macAddress), e.ipAddress])
    );

    for (const entry of listMacEntries(switchId)) {
      const port = ports?.find((p) => p.port_name === entry.port_name || p.portName === entry.port_name);
      const description = port?.description;
      const mac = normalizeMac(entry.mac_address);

      let ip = switchArpByMac[mac];
      let source = ip ? 'switch-arp' : undefined;
      if (!ip) {
        ip = localArpByMac[mac];
        source = ip ? 'local-arp' : undefined;
      }

      let hostname = ip ? mdns[ip] || netbios[ip] : undefined;
      if (ip && hostname) source += '+mdns/netbios';

      if (!ip) {
        hostname = description || null;
        source = 'no discovery data';
      } else if (!hostname) {
        hostname = description || null;
        source += '+port-description';
      }

      results.push({ macAddress: entry.mac_address, ipAddress: ip ?? null, hostname, discoverySource: source });
    }
  }

  if (results.length) upsertDiscovery(results);
  return listDiscovery();
}
