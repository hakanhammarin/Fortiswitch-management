import { renderRunningConfig } from './mockSwitchState.js';

// Emulates the subset of the FortiSwitchOS CLI grammar this app needs:
// get/diagnose/show read commands, and the config/edit/set/next/end
// block style used to change per-port settings.

export class FortiSwitchCliSession {
  constructor(state) {
    this.state = state;
    this.modeStack = []; // e.g. [{mode:'interface'}, {mode:'edit', port:'port1', draft:{...}}]
  }

  prompt() {
    const top = this.modeStack[this.modeStack.length - 1];
    if (!top) return `${this.state.hostname} # `;
    if (top.mode === 'interface') return `${this.state.hostname} (interface) # `;
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
    if (top.mode === 'edit') return this.handleEditMode(line, top);
    if (top.mode === 'vlan') return this.handleVlanMode(line);
    if (top.mode === 'vlan-edit') return this.handleVlanEditMode(line, top);
    return `Unknown mode`;
  }

  // ---- top level ----
  handleTop(line) {
    if (line === 'set output standard' || line === 'config system console') return '';
    if (line === 'get system status') {
      const s = this.state;
      return [
        `Version: ${s.model} ${s.version}`,
        `Serial-Number: ${s.serial}`,
        `Hostname: ${s.hostname}`,
      ].join('\n');
    }
    if (line === 'get switch physical-port-summary' || line === 'diagnose switch physical-ports summary') {
      return this.renderPortSummary();
    }
    if (line === 'diagnose switch physical-ports poe-status' || line === 'get switch poe-status') {
      return this.renderPoeStatus();
    }
    if (line === 'get switch vlan') {
      return this.renderVlanTable();
    }
    if (line === 'diagnose switch mac-address list' || line === 'get switch mac-address-table') {
      return this.renderMacTable();
    }
    if (line === 'show full-configuration switch' || line === 'show' || line === 'show full-configuration') {
      return renderRunningConfig(this.state);
    }
    if (line === 'config switch interface') {
      this.modeStack.push({ mode: 'interface' });
      return '';
    }
    if (line === 'config switch vlan') {
      this.modeStack.push({ mode: 'vlan' });
      return '';
    }
    return `Command fail. Return code -61 (unrecognized command: "${line}")`;
  }

  // ---- config switch interface ----
  handleInterfaceMode(line) {
    const editMatch = line.match(/^edit\s+"?([^"\s]+)"?$/);
    if (editMatch) {
      const portName = editMatch[1];
      const existing = this.state.ports.find((p) => p.portName === portName);
      if (!existing) return `entry not found`;
      this.modeStack.push({ mode: 'edit', port: portName, draft: { ...existing } });
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
    if ((m = line.match(/^set\s+native-vlan\s+(\d+)$/))) {
      top.draft.nativeVlan = Number(m[1]);
      return '';
    }
    if ((m = line.match(/^set\s+allowed-vlans\s+([\d,]+)$/))) {
      top.draft.allowedVlans = m[1].split(',').map(Number);
      return '';
    }
    if ((m = line.match(/^set\s+poe-status\s+(enable|disable)$/))) {
      top.draft.poeEnabled = m[1] === 'enable';
      if (!top.draft.poeEnabled) top.draft.poeWatts = 0;
      return '';
    }
    if ((m = line.match(/^set\s+description\s+"(.*)"$/))) {
      top.draft.description = m[1];
      return '';
    }
    if ((m = line.match(/^set\s+status\s+(up|down)$/))) {
      top.draft.adminStatus = m[1];
      return '';
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

  // ---- renderers ----
  renderPortSummary() {
    const header = 'Port      Admin    Oper    Speed/Duplex  Native-Vlan  Description';
    const rows = this.state.ports.map((p) =>
      [
        p.portName.padEnd(9),
        p.adminStatus.padEnd(8),
        p.operStatus.padEnd(7),
        (p.speed || '-').padEnd(13),
        String(p.nativeVlan).padEnd(12),
        p.description || '-',
      ].join(' ')
    );
    return [header, ...rows].join('\n');
  }

  renderPoeStatus() {
    const header = 'Port      PoE-Status  Power(W)  Class';
    const rows = this.state.ports.map((p) =>
      [
        p.portName.padEnd(9),
        (p.poeEnabled ? 'enabled' : 'disabled').padEnd(11),
        String(p.poeWatts ?? 0).padEnd(9),
        p.poeClass || '-',
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
    const header = 'Port      MAC-Address        VLAN  Type';
    const rows = this.state.macEntries.map((e) =>
      [e.portName.padEnd(9), e.macAddress.padEnd(18), String(e.vlan).padEnd(5), e.type].join(' ')
    );
    return [header, ...rows].join('\n');
  }
}
