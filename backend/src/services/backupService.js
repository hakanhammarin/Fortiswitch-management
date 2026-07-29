import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBackupRecord, listBackups } from '../repositories.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_REPO_DIR = process.env.BACKUP_REPO_DIR || path.join(__dirname, '..', '..', 'data', 'config-backups');

async function git(args, opts = {}) {
  return execFileAsync('git', args, { cwd: BACKUP_REPO_DIR, ...opts });
}

let initialized = false;

async function ensureRepo() {
  if (initialized) return;
  fs.mkdirSync(BACKUP_REPO_DIR, { recursive: true });
  if (!fs.existsSync(path.join(BACKUP_REPO_DIR, '.git'))) {
    await git(['init']);
    await git(['config', 'user.email', 'fortiswitch-management@local']);
    await git(['config', 'user.name', 'FortiSwitch Management']);
  }
  initialized = true;
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// A single shared git working tree backs every switch's backup, and multiple
// switches get polled/changed concurrently, so all git-mutating operations
// are serialized through this queue to avoid index.lock contention.
let gitQueue = Promise.resolve();
function enqueueGit(task) {
  const result = gitQueue.then(task, task);
  gitQueue = result.catch(() => {});
  return result;
}

// A failed CLI command (wrong syntax, session drop mid-read, pager hang) can
// still produce text that gets passed here as "the running-config" - e.g.
// FortiSwitchOS's own "no object in the end\nCommand fail. Return code -160"
// for an invalid command. Silently committing that as a backup is worse than
// not backing up at all (a real config edit could get masked behind it), so
// anything that isn't recognizably a config dump is rejected instead of saved.
const CLI_ERROR_MARKERS = [/Command fail\. Return code/i, /command parse error/i, /no object in the end/i];

function looksLikeValidConfig(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (CLI_ERROR_MARKERS.some((re) => re.test(text))) return false;
  return /^config \S/m.test(text);
}

/**
 * Writes a switch's full running-config to a dedicated git repository (kept
 * separate from the application's own source repo) and commits it. Every
 * applied port change results in one commit here, giving a versioned,
 * diffable audit trail of every switch's configuration over time.
 */
export async function backupSwitchConfig(switchName, runningConfig, reason) {
  if (!looksLikeValidConfig(runningConfig)) {
    throw new Error(
      `refusing to back up ${switchName}: captured text doesn't look like a valid running-config ` +
        `(got: ${JSON.stringify(String(runningConfig).slice(0, 120))})`
    );
  }
  return enqueueGit(async () => {
    await ensureRepo();
    const dir = path.join(BACKUP_REPO_DIR, safeFileName(switchName));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'running-config.conf');
    fs.writeFileSync(file, runningConfig, 'utf8');

    const relPath = path.join(safeFileName(switchName), 'running-config.conf');
    await git(['add', relPath]);

    const { stdout: statusOut } = await git(['status', '--porcelain', '--', relPath]);
    if (!statusOut.trim()) {
      return { committed: false, commitHash: null };
    }

    const message = reason || `Backup ${switchName} running-config`;
    await git(['commit', '-m', message, '--', relPath]);
    const { stdout: hashOut } = await git(['rev-parse', 'HEAD']);
    const commitHash = hashOut.trim();

    return { committed: true, commitHash };
  });
}

export function recordBackup({ switchId, commitHash, reason }) {
  addBackupRecord({ switchId, commitHash, reason });
}

export function getBackupHistory(switchId) {
  return listBackups(switchId);
}

// Finds the running-config path actually present in a given commit, rather
// than assuming it from the switch's *current* name - a switch rename moves
// its backups to a new folder going forward (see renameSwitch in
// configService.js), so a commit made before a rename lives under the old
// name and would be unreachable if looked up by the current one instead.
async function findConfigPath(commitHash) {
  const { stdout } = await git(['show', '--name-only', '--pretty=format:', commitHash]);
  const relPath = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith('running-config.conf'));
  if (!relPath) throw new Error(`no running-config.conf found in commit ${commitHash}`);
  return relPath;
}

export async function getConfigAtCommit(commitHash) {
  await ensureRepo();
  const relPath = await findConfigPath(commitHash);
  const { stdout } = await git(['show', `${commitHash}:${relPath}`]);
  return stdout;
}

export async function diffCommits(fromHash, toHash) {
  await ensureRepo();
  const [fromPath, toPath] = await Promise.all([findConfigPath(fromHash), findConfigPath(toHash)]);
  const { stdout } = await git(['diff', `${fromHash}:${fromPath}`, `${toHash}:${toPath}`]);
  return stdout;
}

export function getBackupRepoDir() {
  return BACKUP_REPO_DIR;
}
