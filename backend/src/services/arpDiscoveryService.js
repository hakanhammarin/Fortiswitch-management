import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listMacEntries, upsertDiscovery, listDiscovery } from '../repositories.js';

// Best-effort real discovery first (works when this backend runs on the
// management LAN with the switches): the kernel neighbor/ARP table for
// IP<->MAC, plus mDNS (avahi-browse) and NetBIOS (nbtscan) for hostnames.
// Falls back to a clearly-labeled simulated mapping when none of those are
// available (e.g. this sandbox, which has no LAN to broadcast on).

function tryArpTable() {
  try {
    const out = execSync('ip neigh show', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const entries = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+.*lladdr\s+([0-9a-fA-F:]+)/);
      if (m) entries.push({ ip: m[1], mac: m[2].toLowerCase() });
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

function simulatedEntryFor(mac, portDescription, vlan) {
  const hash = createHash('md5').update(mac).digest();
  const subnet = { 10: 10, 20: 20, 30: 30, 99: 99 }[vlan] || 50;
  const ip = `10.${subnet}.${hash[0]}.${hash[1] || 1}`;
  const hostname = portDescription && portDescription.trim() ? portDescription.trim() : `host-${mac.replace(/:/g, '').slice(-6)}`;
  return { ip, hostname, source: 'simulated (no LAN broadcast domain reachable from this backend)' };
}

/**
 * Correlates every MAC currently seen in a switch's MAC address table with an
 * IP (from ARP/neighbor discovery) and a friendly name (from mDNS/NetBIOS
 * broadcast discovery), caching results in discovery_cache. Ports carry their
 * own `description` as a fallback label when nothing was discovered on the
 * broadcast domain.
 */
export function runDiscoveryCycle(portsBySwitch) {
  const arp = tryArpTable();
  const mdns = tryMdnsNames();
  const netbios = tryNetbiosNames();
  const arpByMac = Object.fromEntries(arp.map((e) => [e.mac, e.ip]));

  const allMacEntries = [];
  for (const switchId of Object.keys(portsBySwitch)) {
    allMacEntries.push(...listMacEntries(switchId).map((e) => ({ ...e, ports: portsBySwitch[switchId] })));
  }

  const results = [];
  for (const entry of allMacEntries) {
    const port = entry.ports?.find((p) => p.port_name === entry.port_name || p.portName === entry.port_name);
    const description = port?.description;
    let ip = arpByMac[entry.mac_address];
    let hostname = ip ? mdns[ip] || netbios[ip] : undefined;
    let source = ip ? (hostname ? 'arp+mdns/netbios' : 'arp') : undefined;

    if (!ip) {
      const sim = simulatedEntryFor(entry.mac_address, description, entry.vlan);
      ip = sim.ip;
      hostname = hostname || sim.hostname;
      source = sim.source;
    } else if (!hostname) {
      hostname = description || null;
      source = 'arp+port-description';
    }

    results.push({ macAddress: entry.mac_address, ipAddress: ip, hostname, discoverySource: source });
  }

  if (results.length) upsertDiscovery(results);
  return listDiscovery();
}
