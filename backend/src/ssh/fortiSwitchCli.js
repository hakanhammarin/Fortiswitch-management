import { renderRunningConfig, renderInterfaceConfig, renderPhysicalPortConfig } from './mockSwitchState.js';

// Emulates the subset of the real FortiSwitchOS CLI grammar this app needs.
// Command set and per-scope grouping (native-vlan/allowed-vlans/description
// under `config switch interface`; admin-status/PoE under the separate
// `config switch physical-port`) are verified against a real standalone
// FortiSwitch-108E-FPOE (v7.4.9) - `set poe-status` is not a recognized
// keyword under `config switch interface` on real hardware.

export class FortiSwitchCliSession {
  constructor(state) {
    this.state = state;
    this.modeStack = []; // e.g. [{mode:'interface'}, {mode:'edit', port:'port1', draft:{...}}]
  }

  prompt() {
    const top = this.modeStack[this.modeStack.length - 1];
    if (!top) return `${this.state.hostname} # `;
    if (top.mode === 'interface') return `${this.state.hostname} (interface) # `;
    if (top.mode === 'physical-port') return `${this.state.hostname} (physical-port) # `;
    if (top.mode === 'edit') return `${this.state.hostname} (${top.port}) # `;
    if (top.mode === 'vlan') return `${this.state.hostname} (vlan) # `;
    if (top.mode === 'vlan-edit') return `${this.state.hostname} (${top.vlanId}) # `;
    return `${this.state.hostname} # `;
  }

  handle(rawLine) {
    const line = rawLine.trim();
    if (line === '') return '';
    const top = this.modeStack[this.modeStack.length - 1];

    if (!top) return this.handleTop(line);
    if (top.mode === 'interface') return this.handleInterfaceMode(line);
    if (top.mode === 'physical-port') return this.handlePhysicalPortMode(line);
    if (top.mode === 'edit') return this.handleEditMode(line, top);
    if (top.mode === 'vlan') return this.handleVlanMode(line);
    if (top.mode === 'vlan-edit') return this.handleVlanEditMode(line, top);
    if (top.mode === 'switch-global') return this.handleSwitchGlobalMode(line);
    if (top.mode === 'auto-network') return this.handleAutoNetworkMode(line);
    if (top.mode === 'dns') return this.handleDnsMode(line);
    if (top.mode === 'ntp') return this.handleNtpMode(line);
    if (top.mode === 'ntpserver') return this.handleNtpServerMode(line);
    if (top.mode === 'ntpserver-edit') return this.handleNtpServerEditMode(line, top);
    if (top.mode === 'system-global') return this.handleSystemGlobalMode(line);
    return `Unknown mode`;
  }

  // ---- top level ----
  handleTop(line) {
    if (line === 'set output standard' || line === 'config system console' || line === 'end') return '';
    if (line === 'get system status') {
      const s = this.state;
      return [
        `Version: ${s.model} ${s.version}`,
        `Serial-Number: ${s.serial}`,
        `Hostname: ${s.hostname}`,
      ].join('\n');
    }
    if (line === 'diagnose switch physical-ports summary') {
      return this.renderPortSummary();
    }
    if (line === 'show full-configuration switch physical-port') {
      return renderPhysicalPortConfig(this.state);
    }
    if (line === 'show full-configuration switch interface') {
      return renderInterfaceConfig(this.state);
    }
    if (line === 'get switch vlan') {
      return this.renderVlanTable();
    }
    if (line === 'get system arp') {
      return 'Address           Age(min)   Hardware Addr      Interface';
    }
    if (line === 'get switch lldp neighbors-summary') {
      return ' Portname    Status   Device-name                 TTL   Capability  MED-type  Port-ID';
    }
    const poeMatch = line.match(/^diagnose switch poe status (\S+)$/);
    if (poeMatch) {
      const p = this.state.ports.find((x) => x.portName === poeMatch[1]);
      if (!p || !p.poeEnabled) return '';
      const classNum = p.poeClass ? Number(p.poeClass.replace('class', '')) : 0;
      return [
        `Port(${poeMatch[1]}) Power:${(p.poeWatts || 0).toFixed(2)}W,\tPower-Status: ${p.poeWatts ? 'Delivering Power' : 'Searching'}`,
        `Power Class: ${classNum}`,
      ].join('\n');
    }
    if (line === 'diagnose switch mac-address list') {
      return this.renderMacTable();
    }
    if (line === 'show' || line === 'show full-configuration') {
      return renderRunningConfig(this.state);
    }
    if (line === 'config switch interface') {
      this.modeStack.push({ mode: 'interface' });
      return '';
    }
    if (line === 'config switch physical-port') {
      this.modeStack.push({ mode: 'physical-port' });
      return '';
    }
    if (line === 'config switch vlan') {
      this.modeStack.push({ mode: 'vlan' });
      return '';
    }
    if (line === 'config switch global') {
      this.modeStack.push({ mode: 'switch-global' });
      return '';
    }
    if (line === 'config switch auto-network') {
      this.modeStack.push({ mode: 'auto-network' });
      return '';
    }
    if (line === 'config system dns') {
      this.modeStack.push({ mode: 'dns' });
      return '';
    }
    if (line === 'config system ntp') {
      this.modeStack.push({ mode: 'ntp' });
      return '';
    }
    if (line === 'config system global') {
      this.modeStack.push({ mode: 'system-global' });
      return '';
    }
    return `Command fail. Return code -61 (unrecognized command: "${line}")`;
  }

  // ---- config system global (hostname) ----
  handleSystemGlobalMode(line) {
    const m = line.match(/^set\s+hostname\s+"(.*)"$/);
    if (m) {
      this.state.hostname = m[1];
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- config switch interface (native-vlan/allowed-vlans/description) ----
  handleInterfaceMode(line) {
    const editMatch = line.match(/^edit\s+"?([^"\s]+)"?$/);
    if (editMatch) {
      const portName = editMatch[1];
      const existing = this.state.ports.find((p) => p.portName === portName);
      if (!existing) return `entry not found`;
      this.modeStack.push({ mode: 'edit', scope: 'interface', port: portName, draft: { ...existing } });
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- config switch physical-port (admin-status/PoE) ----
  handlePhysicalPortMode(line) {
    const editMatch = line.match(/^edit\s+"?([^"\s]+)"?$/);
    if (editMatch) {
      const portName = editMatch[1];
      const existing = this.state.ports.find((p) => p.portName === portName);
      if (!existing) return `entry not found`;
      this.modeStack.push({ mode: 'edit', scope: 'physical-port', port: portName, draft: { ...existing } });
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleEditMode(line, top) {
    let m;
    if (top.scope === 'interface') {
      if ((m = line.match(/^set\s+native-vlan\s+(\d+)$/))) {
        top.draft.nativeVlan = Number(m[1]);
        return '';
      }
      if ((m = line.match(/^set\s+allowed-vlans\s+([\d,]+)$/))) {
        top.draft.allowedVlans = m[1].split(',').map(Number);
        return '';
      }
      if ((m = line.match(/^set\s+description\s+"(.*)"$/))) {
        top.draft.description = m[1];
        return '';
      }
      if ((m = line.match(/^set\s+stp-state\s+(enabled|disabled)$/))) {
        top.draft.stpState = m[1];
        return '';
      }
      if ((m = line.match(/^set\s+edge-port\s+(enabled|disabled)$/))) {
        top.draft.edgePort = m[1];
        return '';
      }
    }
    if (top.scope === 'physical-port') {
      if ((m = line.match(/^set\s+poe-status\s+(enable|disable)$/))) {
        top.draft.poeEnabled = m[1] === 'enable';
        if (!top.draft.poeEnabled) top.draft.poeWatts = 0;
        return '';
      }
      if ((m = line.match(/^set\s+status\s+(up|down)$/))) {
        top.draft.adminStatus = m[1];
        return '';
      }
      if ((m = line.match(/^set\s+lldp-profile\s+"(.*)"$/))) {
        top.draft.lldpProfile = m[1];
        return '';
      }
      if ((m = line.match(/^set\s+speed\s+(\S+)$/))) {
        top.draft.speedConfig = m[1];
        return '';
      }
    }
    if (line === 'next') {
      const idx = this.state.ports.findIndex((p) => p.portName === top.port);
      if (idx >= 0) this.state.ports[idx] = top.draft;
      this.modeStack.pop();
      return '';
    }
    if (line === 'end') {
      const idx = this.state.ports.findIndex((p) => p.portName === top.port);
      if (idx >= 0) this.state.ports[idx] = top.draft;
      this.modeStack = [];
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- config switch vlan (read-only for this app, but modeled for completeness) ----
  handleVlanMode(line) {
    const editMatch = line.match(/^edit\s+(\d+)$/);
    if (editMatch) {
      const vlanId = Number(editMatch[1]);
      let existing = this.state.vlans.find((v) => v.id === vlanId);
      if (!existing) {
        existing = { id: vlanId, name: `vlan${vlanId}` };
        this.state.vlans.push(existing);
      }
      this.modeStack.push({ mode: 'vlan-edit', vlanId, draft: { ...existing } });
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleVlanEditMode(line, top) {
    let m;
    if ((m = line.match(/^set\s+name\s+"(.*)"$/))) {
      top.draft.name = m[1];
      return '';
    }
    if (line === 'next' || line === 'end') {
      const idx = this.state.vlans.findIndex((v) => v.id === top.vlanId);
      if (idx >= 0) this.state.vlans[idx] = top.draft;
      if (line === 'next') this.modeStack.pop();
      else this.modeStack = [];
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- config switch global / config switch auto-network / config system dns ----
  handleSwitchGlobalMode(line) {
    const m = line.match(/^set\s+auto-isl\s+(enable|disable)$/);
    if (m) {
      this.state.globalConfig.switchGlobal.autoIsl = m[1];
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleAutoNetworkMode(line) {
    const m = line.match(/^set\s+status\s+(enable|disable)$/);
    if (m) {
      this.state.globalConfig.autoNetwork.status = m[1];
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleDnsMode(line) {
    let m;
    if ((m = line.match(/^set\s+primary\s+(\S+)$/))) {
      this.state.globalConfig.dns.primary = m[1];
      return '';
    }
    if ((m = line.match(/^set\s+secondary\s+(\S+)$/))) {
      this.state.globalConfig.dns.secondary = m[1];
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- config system ntp (wraps a nested config ntpserver / edit 1) ----
  handleNtpMode(line) {
    if (line === 'config ntpserver') {
      this.modeStack.push({ mode: 'ntpserver' });
      return '';
    }
    const m = line.match(/^set\s+ntpsync\s+(enable|disable)$/);
    if (m) {
      this.state.globalConfig.ntp.sync = m[1];
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleNtpServerMode(line) {
    if (/^edit\s+\d+$/.test(line)) {
      this.modeStack.push({ mode: 'ntpserver-edit', draft: {} });
      return '';
    }
    if (line === 'end') {
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  handleNtpServerEditMode(line, top) {
    const m = line.match(/^set\s+server\s+"([^"]+)"$/);
    if (m) {
      top.draft.server = m[1];
      return '';
    }
    if (line === 'next' || line === 'end') {
      this.state.globalConfig.ntp.server = top.draft.server;
      this.modeStack.pop();
      return '';
    }
    return `Command fail. Return code -61`;
  }

  // ---- renderers ----
  renderPortSummary() {
    const header = '  Portname    Status  Tpid  Vlan  Duplex  Speed  Flags         Discard';
    const rows = this.state.ports.map((p) =>
      [
        '  ' + p.portName.padEnd(10),
        p.operStatus.padEnd(6),
        '8100',
        String(p.nativeVlan).padEnd(4),
        (p.duplex || 'full').padEnd(6),
        (p.speed || '-').padEnd(5),
        'QS,  ,       ',
        'none',
      ].join(' ')
    );
    return [header, ...rows].join('\n');
  }

  renderVlanTable() {
    const header = 'VLAN-ID  Name';
    const rows = this.state.vlans.map((v) => `${String(v.id).padEnd(8)} ${v.name}`);
    return [header, ...rows].join('\n');
  }

  renderMacTable() {
    return this.state.macEntries
      .map(
        (e) =>
          `MAC: ${e.macAddress}\tVLAN: ${e.vlan} Port: ${e.portName}(port-id 1)\n  Flags: 0x00000041 [ hit ${e.type} ]`
      )
      .join('\n\n');
  }
}
