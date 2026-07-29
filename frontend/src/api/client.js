const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error((isJson && body.error) || `Request failed: ${res.status}`);
  }
  return body;
}

export const api = {
  listSwitches: () => request('/switches'),
  getSwitch: (id) => request(`/switches/${id}`),
  createSwitch: (data) => request('/switches', { method: 'POST', body: JSON.stringify(data) }),
  updateSwitch: (id, data) => request(`/switches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSwitch: (id) => request(`/switches/${id}`, { method: 'DELETE' }),
  pollSwitch: (id) => request(`/switches/${id}/poll`, { method: 'POST' }),
  renameSwitch: (id, name, user) => request(`/switches/${id}/rename`, { method: 'POST', body: JSON.stringify({ name, user }) }),
  listPorts: (id) => request(`/switches/${id}/ports`),
  listVlans: (id) => request(`/switches/${id}/vlans`),
  listAuditLog: (id) => request(`/switches/${id}/audit-log`),

  changePort: (switchId, portName, changes, user) =>
    request(`/ports/${switchId}/${portName}`, { method: 'PATCH', body: JSON.stringify({ ...changes, user }) }),
  editableFields: () => request('/ports/editable-fields'),

  listTemplates: () => request('/templates'),
  saveTemplate: (data) => request('/templates', { method: 'POST', body: JSON.stringify(data) }),
  complianceAll: () => request('/templates/compliance'),
  complianceFor: (switchId) => request(`/templates/compliance/${switchId}`),
  enforceCompliance: (switchId, user) => request(`/templates/enforce/${switchId}`, { method: 'POST', body: JSON.stringify({ user }) }),

  backupHistory: (switchId) => request(`/backups/${switchId}`),
  backupConfig: (switchId, commitHash) =>
    fetch(`${BASE}/backups/${switchId}/config/${commitHash}`).then((r) => r.text()),
  backupDiff: (switchId, from, to) =>
    fetch(`${BASE}/backups/${switchId}/diff?from=${from}&to=${to}`).then((r) => r.text()),

  discovery: () => request('/discovery'),

  importCandidates: () => request('/import/candidates'),
  importCandidate: (data) => request('/import/candidates/import', { method: 'POST', body: JSON.stringify(data) }),
};
