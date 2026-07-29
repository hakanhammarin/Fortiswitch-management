import yaml from 'js-yaml';
import {
  listPorts,
  getSwitch,
  getSwitchVlans,
  getSwitchGlobalConfig,
  getTemplate,
  upsertTemplate,
  listTemplates,
} from '../repositories.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function ensureDefaultTemplate() {
  if (listTemplates().length > 0) return;
  const body = fs.readFileSync(path.join(__dirname, '..', 'templates', 'default.yaml'), 'utf8');
  const parsed = yaml.load(body);
  upsertTemplate({ name: parsed.name, description: parsed.description, yamlBody: body });
}

function matchesRule(port, rule) {
  const value = rule.matchBy === 'description' ? port.description || '' : port.port_name;
  const re = new RegExp(rule.match, 'i');
  return re.test(value);
}

// Every violation carries `field`/`current`/`expected` (for the diff view and
// for enforceSwitch() in configService.js to know exactly what to change) in
// addition to a human-readable `message`. `enforceable: false` marks
// violations with no single correct value to set (e.g. "one of [...]").
function violation(field, current, expected, message, enforceable = true) {
  return { field, current, expected, message, enforceable };
}

function checkExpectations(port, expect) {
  const violations = [];
  if (expect.adminStatus !== undefined && port.admin_status !== expect.adminStatus) {
    violations.push(violation('adminStatus', port.admin_status, expect.adminStatus, `admin-status is "${port.admin_status}", expected "${expect.adminStatus}"`));
  }
  if (expect.poeEnabled !== undefined && Boolean(port.poe_enabled) !== expect.poeEnabled) {
    violations.push(violation('poeEnabled', Boolean(port.poe_enabled), expect.poeEnabled, `poe-status is "${port.poe_enabled ? 'enable' : 'disable'}", expected "${expect.poeEnabled ? 'enable' : 'disable'}"`));
  }
  if (expect.nativeVlan !== undefined && port.native_vlan !== expect.nativeVlan) {
    violations.push(violation('nativeVlan', port.native_vlan, expect.nativeVlan, `native-vlan is ${port.native_vlan}, expected ${expect.nativeVlan}`));
  }
  if (expect.nativeVlanIn !== undefined && !expect.nativeVlanIn.includes(port.native_vlan)) {
    violations.push(
      violation('nativeVlanIn', port.native_vlan, null, `native-vlan is ${port.native_vlan}, expected one of [${expect.nativeVlanIn.join(', ')}]`, false)
    );
  }
  if (expect.allowedVlans !== undefined) {
    const current = [...port.allowedVlans].sort((a, b) => a - b);
    const wanted = [...expect.allowedVlans].sort((a, b) => a - b);
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      violations.push(violation('allowedVlans', current, wanted, `allowed-vlans is [${current.join(', ')}], expected [${wanted.join(', ')}]`));
    }
  }
  if (expect.stpState !== undefined && port.stp_state !== expect.stpState) {
    violations.push(violation('stpState', port.stp_state, expect.stpState, `stp-state is "${port.stp_state}", expected "${expect.stpState}"`));
  }
  if (expect.edgePort !== undefined && port.edge_port !== expect.edgePort) {
    violations.push(violation('edgePort', port.edge_port, expect.edgePort, `edge-port is "${port.edge_port}", expected "${expect.edgePort}"`));
  }
  if (expect.lldpProfile !== undefined && port.lldp_profile !== expect.lldpProfile) {
    violations.push(violation('lldpProfile', port.lldp_profile, expect.lldpProfile, `lldp-profile is "${port.lldp_profile}", expected "${expect.lldpProfile}"`));
  }
  if (expect.speedConfig !== undefined && port.speed_config !== expect.speedConfig) {
    violations.push(violation('speedConfig', port.speed_config, expect.speedConfig, `speed is "${port.speed_config}", expected "${expect.speedConfig}"`));
  }
  return violations;
}

/**
 * Compares site-wide switch/system settings (not per-port) against the
 * template's `global` section. Settings the device has never explicitly set
 * read back as null (FortiSwitchOS's `show` only prints non-default values),
 * which is reported as "not set (default)" rather than guessing what that
 * default actually is.
 */
function checkGlobalConfig(current, expect) {
  const violations = [];
  if (!expect) return violations;
  const c = current || {};

  const compare = (field, actual, wanted, label) => {
    if (wanted === undefined) return;
    if (actual !== wanted) {
      violations.push(
        violation(field, actual, wanted, `${label} is ${actual === null || actual === undefined ? 'not set (default)' : actual}, expected ${wanted}`)
      );
    }
  };

  compare('switchGlobal.autoIsl', c.switchGlobal?.autoIsl, expect.switchGlobal?.autoIsl, 'switch global auto-isl');
  compare('autoNetwork.status', c.autoNetwork?.status, expect.autoNetwork?.status, 'switch auto-network status');
  compare('dns.primary', c.dns?.primary, expect.dns?.primary, 'dns primary');
  compare('dns.secondary', c.dns?.secondary, expect.dns?.secondary, 'dns secondary');
  compare('ntp.server', c.ntp?.server, expect.ntp?.server, 'ntp server');
  compare('ntp.sync', c.ntp?.sync, expect.ntp?.sync, 'ntp sync');
  compare('systemGlobal.adminLockoutDuration', c.systemGlobal?.adminLockoutDuration, expect.systemGlobal?.adminLockoutDuration, 'system global admin-lockout-duration');
  compare('systemGlobal.adminLockoutThreshold', c.systemGlobal?.adminLockoutThreshold, expect.systemGlobal?.adminLockoutThreshold, 'system global admin-lockout-threshold');

  return violations;
}

/**
 * Compares a switch's cached running state against a desired-state template
 * and returns a compliance report: overall status, VLAN-level drift, and
 * per-port drift with the specific fields/values that don't match.
 */
export function validateSwitch(switchId, templateName = null) {
  const sw = getSwitch(switchId);
  if (!sw) throw new Error('switch not found');
  const template = getTemplate(templateName || sw.role_template || 'default');
  if (!template) throw new Error(`template not found: ${templateName || sw.role_template}`);
  const spec = yaml.load(template.yaml_body);

  const ports = listPorts(switchId);
  const currentVlans = getSwitchVlans(switchId).map((v) => v.id);
  const requiredVlans = spec.vlans?.required || [];
  const missingVlans = requiredVlans.filter((v) => !currentVlans.includes(v));
  const globalViolations = checkGlobalConfig(getSwitchGlobalConfig(switchId), spec.global);

  const portReports = ports.map((port) => {
    const rule = (spec.rules || []).find((r) => matchesRule(port, r));
    if (!rule) return { portName: port.port_name, compliant: true, matchedRule: null, violations: [] };
    const violations = checkExpectations(port, rule.expect || {});
    return {
      portName: port.port_name,
      matchedRule: rule.match,
      compliant: violations.length === 0,
      violations,
    };
  });

  const nonCompliantPorts = portReports.filter((p) => !p.compliant);
  return {
    switchId,
    templateName: template.name,
    compliant: missingVlans.length === 0 && nonCompliantPorts.length === 0 && globalViolations.length === 0,
    missingVlans,
    globalViolations,
    ports: portReports,
    summary: {
      totalPorts: portReports.length,
      compliantPorts: portReports.length - nonCompliantPorts.length,
      nonCompliantPorts: nonCompliantPorts.length,
    },
  };
}

export function validateAllSwitches(switches) {
  return switches.map((s) => {
    try {
      return validateSwitch(s.id);
    } catch (err) {
      return { switchId: s.id, error: err.message };
    }
  });
}
