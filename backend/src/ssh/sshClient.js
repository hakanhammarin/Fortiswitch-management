import ssh2 from 'ssh2';
const { Client } = ssh2;

const PROMPT_REGEX = /[#$>]\s*$/;

// Disables FortiSwitchOS's "--More--" pager. Without this, any command whose
// output exceeds the pty's row count (24 by default) blocks waiting for a
// keypress we never send, and the session just hangs until timeoutMs - hit
// in practice by the bare `show` command against a real switch's full config.
const DISABLE_PAGER_COMMANDS = ['config system console', 'set output standard', 'end'];

/**
 * Opens one interactive SSH shell (the "sshpass equivalent" for FortiSwitchOS:
 * no OS-level sshpass binary needed, ssh2 authenticates with a password
 * directly) and hands the caller a `send(commands)` function to run any
 * number of sequential command batches over it, resolving each with that
 * batch's captured outputs. The pager is disabled once, automatically,
 * before `run` is invoked.
 *
 * Reusing one session across batches matters: reconnecting for a second
 * batch right after the first closes has been observed to get rejected with
 * "All configured authentication methods failed" against a real
 * FortiSwitch-108E-FPOE - the device appears to rate-limit rapid
 * re-authentication even when every attempt uses valid credentials.
 *
 * Works against both the bundled mock FortiSwitch server and real FortiSwitchOS
 * devices, which use the same edit/config/end CLI style and a trailing "#" prompt.
 */
export function withSession({ host, port = 22, username, password, timeoutMs = 15000 }, run) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let stream;
    let timer;

    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(new Error(`SSH session to ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

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

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      resolve(result);
    }

    // Runs one batch of commands sequentially over the already-open stream.
    function send(commands) {
      return new Promise((res) => {
        const outputs = [];
        let buffer = '';
        let cmdIndex = -1;

        function onData(data) {
          buffer += data.toString('utf8');
          if (PROMPT_REGEX.test(buffer)) {
            outputs.push(stripEcho(commands[cmdIndex], buffer));
            sendNext();
          }
        }

        function sendNext() {
          cmdIndex += 1;
          if (cmdIndex >= commands.length) {
            stream.removeListener('data', onData);
            res(outputs);
            return;
          }
          buffer = '';
          resetTimer();
          stream.write(commands[cmdIndex] + '\n');
        }

        stream.on('data', onData);
        sendNext();
      });
    }

    // The post-login banner/prompt arrives unprompted, before any command is
    // sent. Attaching a 'data' listener flushes whatever's already buffered
    // via process.nextTick - which runs *after* the synchronous send() call
    // that follows it has already written the first real command - so
    // without this, the banner/prompt gets misattributed as that command's
    // response and every subsequent output shifts by one. Consuming it here,
    // via its own one-shot listener before any batch starts, mirrors what the
    // old single-batch code did with a `cmdIndex >= 0` guard.
    function awaitInitialPrompt() {
      return new Promise((res) => {
        let initialBuffer = '';
        function onInitialData(data) {
          initialBuffer += data.toString('utf8');
          if (PROMPT_REGEX.test(initialBuffer)) {
            stream.removeListener('data', onInitialData);
            res();
          }
        }
        stream.on('data', onInitialData);
      });
    }

    resetTimer();
    conn
      .on('ready', () => {
        conn.shell((err, str) => {
          if (err) return fail(err);
          stream = str;
          stream.on('close', () => fail(new Error('SSH session closed unexpectedly')));

          awaitInitialPrompt()
            .then(() => send(DISABLE_PAGER_COMMANDS))
            .then(() => run(send))
            .then(finish, fail);
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

// Single-batch convenience wrapper for callers that only need one round of
// commands (everything except fetchSwitchState's extra PoE-status pass).
export function execCommands(connConfig, commands) {
  return withSession(connConfig, (send) => send(commands));
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
