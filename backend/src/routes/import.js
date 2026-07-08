import { Router } from 'express';
import { listImportCandidates } from '../services/inventoryImportService.js';
import { createSwitch } from '../repositories.js';

export const importRouter = Router();

// Read-only listing of switch CIs found in the (also read-only) 10mila_monitoring
// inventory. Importing only writes to this app's own switches table.
importRouter.get('/candidates', (req, res) => {
  res.json(listImportCandidates());
});

importRouter.post('/candidates/import', (req, res) => {
  const { suggestedName, host, username, password, sshPort, roleTemplate } = req.body;
  if (!suggestedName || !host || !username || !password) {
    return res.status(400).json({ error: 'suggestedName, host, username, password are required' });
  }
  const sw = createSwitch({
    name: suggestedName,
    host,
    sshPort,
    username,
    password,
    roleTemplate,
    source: '10mila_monitoring',
  });
  res.status(201).json(sw);
});
