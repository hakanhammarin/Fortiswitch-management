import ssh2 from 'ssh2';
const { Client } = ssh2;

const PROMPT_REGEX = /[#$>]\s*$/;

/**
 * Opens an interactive SSH shell (the "sshpass equivalent" for FortiSwitchOS: no
 * OS-level sshpass binary needed, ssh2 authenticates with a password directly),
 * sends a sequence of CLI commands one at a time, and resolves with each
 * command's captured output once the prompt reappears.
 *
 * Works against both the bundled mock FortiSwitch server and real FortiSwitchOS
 * devices, which use the same edit/config/end CLI style and a trailing "#" prompt.
 */
export function execCommands({ host, port = 22, username, password, timeoutMs = 15000 }, commands) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let buffer = '';
    const outputs = [];
    let cmdIndex = -1; // -1 = waiting for the post-login banner/prompt
    let settled = false;
    let stream;

    const timer = setTimeout(() => {
      fail(new Error(`SSH session to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      reject(err);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      resolve(outputs);
    }

    function sendNext() {
      cmdIndex += 1;
      if (cmdIndex >= commands.length) {
        succeed();
        return;
      }
      buffer = '';
      stream.write(commands[cmdIndex] + '\n');
    }

    conn
      .on('ready', () => {
        conn.shell((err, str) => {
          if (err) return fail(err);
          stream = str;
          stream.on('data', (data) => {
            buffer += data.toString('utf8');
            if (PROMPT_REGEX.test(buffer)) {
              if (cmdIndex >= 0) {
                outputs.push(stripEcho(commands[cmdIndex], buffer));
              }
              sendNext();
            }
          });
          stream.on('close', () => {
            if (!settled) succeed();
          });
        });
      })
      .on('error', fail)
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: timeoutMs,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
        },
      });
  });
}

function stripEcho(command, raw) {
  const lines = raw.split(/\r?\n/);
  // Drop the first line (echo of what we typed) and the trailing prompt line.
  if (lines.length && lines[0].trim().startsWith(command.trim())) {
    lines.shift();
  }
  while (lines.length && (PROMPT_REGEX.test(lines[lines.length - 1]) || lines[lines.length - 1].trim() === '')) {
    lines.pop();
  }
  return lines.join('\n');
}
