import fs from 'node:fs';
import path from 'node:path';

// Read-only integration with the separate `10mila_monitoring` repository's CI
// (configuration item) inventory. This service only ever reads files from
// that checkout — it never writes to it, commits to it, or calls any GitHub
// write API on it. Importing a candidate only creates a row in this app's own
// switches table; the source repo is untouched.

const CANDIDATE_NAME_PATTERN = process.env.MONITORING_SWITCH_NAME_REGEX || '^SW\\d+';

function resolveMonitoringRepoPath() {
  const candidates = [process.env.MONITORING_REPO_PATH, '/workspace/10mila_monitoring'].filter(Boolean);
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir)) return dir;
  }
  return null;
}

function resolveCisFile(repoDir) {
  if (process.env.MONITORING_CIS_FILE && fs.existsSync(process.env.MONITORING_CIS_FILE)) {
    return process.env.MONITORING_CIS_FILE;
  }
  for (const fname of ['cis_10mila.json', 'cis.json']) {
    const p = path.join(repoDir, fname);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getMonitoringSource() {
  const repoDir = resolveMonitoringRepoPath();
  const cisFile = repoDir ? resolveCisFile(repoDir) : null;
  return {
    configured: Boolean(cisFile),
    repoDir,
    cisFile,
    note: 'Read-only source: hakanhammarin/10mila_monitoring. This app never writes to that repository.',
  };
}

/**
 * Lists CIs from the monitoring repo's inventory whose name matches the
 * switch naming convention (default: /^SW\d+/, e.g. "SW11", "SW12"), as
 * import candidates for this app's own switch inventory.
 */
export function listImportCandidates() {
  const source = getMonitoringSource();
  if (!source.cisFile) return { ...source, candidates: [] };

  const raw = JSON.parse(fs.readFileSync(source.cisFile, 'utf8'));
  const re = new RegExp(CANDIDATE_NAME_PATTERN, 'i');
  const candidates = raw
    .filter((ci) => ci.type === 'icmp' && re.test(ci.name))
    .map((ci) => ({
      ciIndex: ci.index,
      suggestedName: ci.name,
      host: ci.ip,
    }));

  return { ...source, candidates };
}
