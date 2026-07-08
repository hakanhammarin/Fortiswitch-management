// Dev/demo helper: registers the three mock switches started by
// `npm run mock-switch` into this app's own switch inventory so the UI has
// something to show without any real hardware. Not used in production.
import 'dotenv/config';
import { createSwitch, listSwitches, deleteSwitch } from './repositories.js';

const username = process.env.MOCK_SWITCH_USER || 'admin';
const password = process.env.MOCK_SWITCH_PASSWORD || 'admin123';

const fleet = [
  { name: 'SW11-ACCESS-1F', host: '127.0.0.1', sshPort: 2201 },
  { name: 'SW12-ACCESS-2F', host: '127.0.0.1', sshPort: 2202 },
  { name: 'SW13-ACCESS-3F', host: '127.0.0.1', sshPort: 2203 },
];

for (const existing of listSwitches()) {
  if (existing.source === 'seed-demo') deleteSwitch(existing.id);
}

for (const sw of fleet) {
  const created = createSwitch({ ...sw, username, password, roleTemplate: 'default', source: 'seed-demo' });
  console.log(`seeded ${created.name} (${created.id}) -> ${sw.host}:${sw.sshPort}`);
}
