import { Router } from 'express';
import {
  listSwitches,
  getSwitch,
  createSwitch,
  updateSwitch,
  deleteSwitch,
  listPorts,
  listMacEntries,
  getSwitchVlans,
  listAuditLog,
} from '../repositories.js';
import { pollSwitch } from '../services/switchService.js';
import { listDiscovery } from '../repositories.js';

export const switchesRouter = Router();

switchesRouter.get('/', (req, res) => {
  res.json(listSwitches());
});

switchesRouter.post('/', (req, res) => {
  const { name, host, sshPort, username, password, roleTemplate } = req.body;
  if (!name || !host || !username || !password) {
    return res.status(400).json({ error: 'name, host, username, password are required' });
  }
  const sw = createSwitch({ name, host, sshPort, username, password, roleTemplate, source: 'manual' });
  res.status(201).json(sw);
});

switchesRouter.get('/:id', (req, res) => {
  const sw = getSwitch(req.params.id);
  if (!sw) return res.status(404).json({ error: 'not found' });
  res.json(sw);
});

switchesRouter.patch('/:id', (req, res) => {
  const sw = updateSwitch(req.params.id, req.body);
  if (!sw) return res.status(404).json({ error: 'not found' });
  res.json(sw);
});

switchesRouter.delete('/:id', (req, res) => {
  deleteSwitch(req.params.id);
  res.status(204).end();
});

switchesRouter.post('/:id/poll', async (req, res) => {
  const result = await pollSwitch(req.params.id);
  res.json(result);
});

switchesRouter.get('/:id/ports', (req, res) => {
  const ports = listPorts(req.params.id);
  const discovery = listDiscovery();
  const discoveryByMac = Object.fromEntries(discovery.map((d) => [d.mac_address, d]));
  const macEntries = listMacEntries(req.params.id);

  const macByPort = {};
  for (const m of macEntries) {
    (macByPort[m.port_name] ||= []).push({
      macAddress: m.mac_address,
      vlan: m.vlan,
      type: m.type,
      ipAddress: discoveryByMac[m.mac_address]?.ip_address || null,
      hostname: discoveryByMac[m.mac_address]?.hostname || null,
      discoverySource: discoveryByMac[m.mac_address]?.discovery_source || null,
    });
  }

  res.json(
    ports.map((p) => ({
      ...p,
      macEntries: macByPort[p.port_name] || [],
    }))
  );
});

switchesRouter.get('/:id/vlans', (req, res) => {
  res.json(getSwitchVlans(req.params.id));
});

switchesRouter.get('/:id/audit-log', (req, res) => {
  res.json(listAuditLog(req.params.id));
});
