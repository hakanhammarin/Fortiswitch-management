import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { switchesRouter } from './routes/switches.js';
import { portsRouter } from './routes/ports.js';
import { templatesRouter } from './routes/templates.js';
import { backupsRouter } from './routes/backups.js';
import { discoveryRouter } from './routes/discovery.js';
import { importRouter } from './routes/import.js';
import { startPollingLoop } from './services/switchService.js';
import { ensureDefaultTemplate } from './services/desiredStateService.js';
import './db.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/switches', switchesRouter);
app.use('/api/ports', portsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/discovery', discoveryRouter);
app.use('/api/import', importRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

ensureDefaultTemplate();

app.listen(PORT, () => {
  console.log(`FortiSwitch management API listening on :${PORT}`);
  startPollingLoop(POLL_INTERVAL_MS);
});
