import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import AddSwitchModal from '../components/AddSwitchModal.jsx';

export default function Dashboard() {
  const [switches, setSwitches] = useState([]);
  const [compliance, setCompliance] = useState({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [sw, comp] = await Promise.all([api.listSwitches(), api.complianceAll()]);
      setSwitches(sw);
      setCompliance(Object.fromEntries(comp.map((c) => [c.switchId, c])));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function pollNow(id) {
    await api.pollSwitch(id);
    load();
  }

  async function remove(id) {
    if (!confirm('Remove this switch from inventory? (does not affect the device itself)')) return;
    await api.deleteSwitch(id);
    load();
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Switch Fleet</h1>
        <button onClick={() => setShowAdd(true)}>+ Add switch</button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {loading && <p className="muted">Loading...</p>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Host</th>
              <th>Status</th>
              <th>Last poll</th>
              <th>Compliance</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {switches.map((s) => {
              const comp = compliance[s.id];
              return (
                <tr key={s.id}>
                  <td>
                    <Link to={`/switches/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>{s.host}:{s.ssh_port}</td>
                  <td>
                    <span className={`badge ${s.reachable ? 'up' : 'error'}`}>
                      {s.reachable ? 'reachable' : 'unreachable'}
                    </span>
                    {!s.reachable && s.last_error && (
                      <div className="muted" style={{ fontSize: 11, maxWidth: 260, whiteSpace: 'normal' }}>
                        {s.last_error}
                      </div>
                    )}
                  </td>
                  <td className="muted">{s.last_poll_at || '-'}</td>
                  <td>
                    {comp && !comp.error ? (
                      <span className={`badge ${comp.compliant ? 'compliant' : 'non-compliant'}`}>
                        {comp.summary.compliantPorts}/{comp.summary.totalPorts} ports OK
                      </span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td className="muted">{s.source}</td>
                  <td>
                    <button className="secondary small" onClick={() => pollNow(s.id)}>Poll now</button>{' '}
                    <button className="secondary small" onClick={() => remove(s.id)}>Remove</button>
                  </td>
                </tr>
              );
            })}
            {switches.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="muted">
                  No switches yet. Add one manually or import candidates from 10mila_monitoring.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddSwitchModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </div>
  );
}
