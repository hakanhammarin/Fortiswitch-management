import { Router } from 'express';
import { getSwitch } from '../repositories.js';
import { getBackupHistory, getConfigAtCommit, diffCommits } from '../services/backupService.js';

export const backupsRouter = Router();

backupsRouter.get('/:switchId', (req, res) => {
  res.json(getBackupHistory(req.params.switchId));
});

backupsRouter.get('/:switchId/config/:commitHash', async (req, res) => {
  const sw = getSwitch(req.params.switchId);
  if (!sw) return res.status(404).json({ error: 'switch not found' });
  try {
    const text = await getConfigAtCommit(sw.name, req.params.commitHash);
    res.type('text/plain').send(text);
  } catch (err) {
    res.status(404).json({ error: `commit/config not found: ${err.message}` });
  }
});

backupsRouter.get('/:switchId/diff', async (req, res) => {
  const sw = getSwitch(req.params.switchId);
  if (!sw) return res.status(404).json({ error: 'switch not found' });
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to commit hashes are required' });
  try {
    const text = await diffCommits(sw.name, from, to);
    res.type('text/plain').send(text);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
