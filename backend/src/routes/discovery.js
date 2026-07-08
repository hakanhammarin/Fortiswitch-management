import { Router } from 'express';
import { listDiscovery } from '../repositories.js';

export const discoveryRouter = Router();

discoveryRouter.get('/', (req, res) => {
  res.json(listDiscovery());
});
