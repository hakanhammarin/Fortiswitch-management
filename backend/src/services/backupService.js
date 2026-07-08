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

/**
 * Writes a switch's full running-config to a dedicated git repository (kept
 * separate from the application's own source repo) and commits it. Every
 * applied port change results in one commit here, giving a versioned,
 * diffable audit trail of every switch's configuration over time.
 */
export async function backupSwitchConfig(switchName, runningConfig, reason) {
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

export async function getConfigAtCommit(switchName, commitHash) {
  await ensureRepo();
  const relPath = path.join(safeFileName(switchName), 'running-config.conf');
  const { stdout } = await git(['show', `${commitHash}:${relPath}`]);
  return stdout;
}

export async function diffCommits(switchName, fromHash, toHash) {
  await ensureRepo();
  const relPath = path.join(safeFileName(switchName), 'running-config.conf');
  const { stdout } = await git(['diff', fromHash, toHash, '--', relPath]);
  return stdout;
}

export function getBackupRepoDir() {
  return BACKUP_REPO_DIR;
}
