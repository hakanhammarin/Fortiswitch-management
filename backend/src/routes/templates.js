import { Router } from 'express';
import yaml from 'js-yaml';
import { listTemplates, upsertTemplate } from '../repositories.js';
import { validateSwitch, validateAllSwitches } from '../services/desiredStateService.js';
import { listSwitches } from '../repositories.js';

export const templatesRouter = Router();

templatesRouter.get('/', (req, res) => {
  res.json(listTemplates());
});

templatesRouter.post('/', (req, res) => {
  const { name, description, yamlBody } = req.body;
  if (!name || !yamlBody) return res.status(400).json({ error: 'name and yamlBody are required' });
  try {
    yaml.load(yamlBody); // validate it parses
  } catch (err) {
    return res.status(400).json({ error: `invalid YAML: ${err.message}` });
  }
  res.status(201).json(upsertTemplate({ name, description, yamlBody }));
});

templatesRouter.get('/compliance', (req, res) => {
  res.json(validateAllSwitches(listSwitches()));
});

templatesRouter.get('/compliance/:switchId', (req, res) => {
  try {
    res.json(validateSwitch(req.params.switchId, req.query.template || null));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
