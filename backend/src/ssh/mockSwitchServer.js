import ssh2 from 'ssh2';
const { Server } = ssh2;
import { generateKeyPairSync } from 'node:crypto';
import { createDefaultState } from './mockSwitchState.js';
import { FortiSwitchCliSession } from './fortiSwitchCli.js';

function ephemeralHostKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

/**
 * Starts a single mock FortiSwitch SSH endpoint. This stands in for real
 * hardware during development/demo: same wire protocol (SSH password auth +
 * interactive shell) and the same FortiSwitchOS-style CLI grammar that
 * sshClient.js speaks to real switches.
 */
export function startMockSwitch({ port, username, password, state, hostKey }) {
  const deviceState = state || createDefaultState({ name: `MOCK-${port}` });
  const server = new Server({ hostKeys: [hostKey || ephemeralHostKey()] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
          ctx.accept();
        } else {
          ctx.reject(['password']);
        }
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (accept2) => accept2 && accept2());
          session.on('shell', (accept2) => {
            const stream = accept2();
            const cli = new FortiSwitchCliSession(deviceState);
            let inputBuffer = '';

            stream.write(`\r\nWelcome to ${deviceState.hostname} (mock FortiSwitchOS)\r\n`);
            stream.write(cli.prompt());

            stream.on('data', (data) => {
              inputBuffer += data.toString('utf8');
              let idx;
              while ((idx = inputBuffer.indexOf('\n')) !== -1) {
                const line = inputBuffer.slice(0, idx).replace(/\r$/, '');
                inputBuffer = inputBuffer.slice(idx + 1);
                const output = cli.handle(line);
                if (output) stream.write(output.replace(/\n/g, '\r\n') + '\r\n');
                stream.write(cli.prompt());
              }
            });
            stream.on('close', () => client.end());
          });
        });
      })
      .on('close', () => {});
  });
  server.listen(port, '0.0.0.0', function () {
    console.log(`[mock-switch] ${deviceState.hostname} listening on 0.0.0.0:${this.address().port}`);
  });
  return { server, state: deviceState };
}

// Standalone dev fleet: `npm run mock-switch`
if (import.meta.url === `file://${process.argv[1]}`) {
  const username = process.env.MOCK_SWITCH_USER || 'admin';
  const password = process.env.MOCK_SWITCH_PASSWORD || 'admin123';
  const hostKey = ephemeralHostKey();

  const fleet = [
    { port: 2201, name: 'SW11-ACCESS-1F', model: 'FortiSwitch-124F-POE' },
    { port: 2202, name: 'SW12-ACCESS-2F', model: 'FortiSwitch-124F-POE' },
    { port: 2203, name: 'SW13-ACCESS-3F', model: 'FortiSwitch-448E-POE' },
  ];

  for (const sw of fleet) {
    startMockSwitch({
      port: sw.port,
      username,
      password,
      hostKey,
      state: createDefaultState({ name: sw.name, model: sw.model }),
    });
  }

  console.log(`[mock-switch] credentials: ${username} / ${password}`);
}
