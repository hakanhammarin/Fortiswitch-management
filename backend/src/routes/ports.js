import { Router } from 'express';
import { changePort, getEditableFields } from '../services/configService.js';

export const portsRouter = Router();

portsRouter.get('/editable-fields', (req, res) => {
  res.json({ fields: getEditableFields() });
});

portsRouter.patch('/:switchId/:portName', async (req, res) => {
  try {
    const user = req.header('X-User') || req.body.user || 'ui-user';
    const { user: _u, ...changes } = req.body;
    const result = await changePort(req.params.switchId, req.params.portName, changes, { user });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
