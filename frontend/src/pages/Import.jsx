import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import AddSwitchModal from '../components/AddSwitchModal.jsx';

export default function Import() {
  const [source, setSource] = useState(null);
  const [importing, setImporting] = useState(null);
  const [imported, setImported] = useState(new Set());

  function load() {
    api.importCandidates().then(setSource);
  }

  useEffect(load, []);

  return (
    <div>
      <div className="toolbar">
        <h1>Import from 10mila_monitoring</h1>
      </div>

      <div className="card">
        <p className="muted" style={{ fontSize: 13 }}>
          Read-only integration: candidates below come from{' '}
          <span className="mono">hakanhammarin/10mila_monitoring</span>'s CI inventory (names matching the
          switch naming convention). This app never writes back to that repository &mdash; importing a
          candidate only creates a row in this app's own switch inventory, with SSH credentials you supply here.
        </p>
        {source && (
          <p className="muted" style={{ fontSize: 12 }}>
            Source: {source.cisFile || <em>not configured (set MONITORING_REPO_PATH on the backend)</em>}
          </p>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Suggested name</th>
              <th>Host</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {source?.candidates?.map((c) => (
              <tr key={c.ciIndex}>
                <td>{c.suggestedName}</td>
                <td>{c.host}</td>
                <td>
                  {imported.has(c.ciIndex) ? (
                    <span className="badge ok">imported</span>
                  ) : (
                    <button className="small" onClick={() => setImporting(c)}>Import...</button>
                  )}
                </td>
              </tr>
            ))}
            {source && source.candidates?.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">No matching candidates found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {importing && (
        <AddSwitchModal
          initial={{
            title: `Import ${importing.suggestedName}`,
            name: importing.suggestedName,
            host: importing.host,
            onImport: (form) =>
              api.importCandidate({
                suggestedName: form.name,
                host: form.host,
                sshPort: Number(form.sshPort),
                username: form.username,
                password: form.password,
                roleTemplate: form.roleTemplate,
              }),
          }}
          onClose={() => setImporting(null)}
          onCreated={() => {
            setImported((s) => new Set([...s, importing.ciIndex]));
            setImporting(null);
          }}
        />
      )}
    </div>
  );
}
