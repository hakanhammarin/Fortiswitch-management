import yaml from 'js-yaml';
import { listPorts, getSwitch, getSwitchVlans, getTemplate, upsertTemplate, listTemplates } from '../repositories.js';
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

function checkExpectations(port, expect) {
  const violations = [];
  if (expect.adminStatus !== undefined && port.admin_status !== expect.adminStatus) {
    violations.push(`admin-status is "${port.admin_status}", expected "${expect.adminStatus}"`);
  }
  if (expect.poeEnabled !== undefined && Boolean(port.poe_enabled) !== expect.poeEnabled) {
    violations.push(`poe-status is "${port.poe_enabled ? 'enable' : 'disable'}", expected "${expect.poeEnabled ? 'enable' : 'disable'}"`);
  }
  if (expect.nativeVlan !== undefined && port.native_vlan !== expect.nativeVlan) {
    violations.push(`native-vlan is ${port.native_vlan}, expected ${expect.nativeVlan}`);
  }
  if (expect.nativeVlanIn !== undefined && !expect.nativeVlanIn.includes(port.native_vlan)) {
    violations.push(`native-vlan is ${port.native_vlan}, expected one of [${expect.nativeVlanIn.join(', ')}]`);
  }
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
    compliant: missingVlans.length === 0 && nonCompliantPorts.length === 0,
    missingVlans,
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
