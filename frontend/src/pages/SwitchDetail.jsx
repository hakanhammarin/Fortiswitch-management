import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import EditPortModal from '../components/EditPortModal.jsx';

const MAX_POE_W = 15.4; // 802.3af class reference for the bar scale

export default function SwitchDetail() {
  const { id } = useParams();
  const [sw, setSw] = useState(null);
  const [ports, setPorts] = useState([]);
  const [vlans, setVlans] = useState([]);
  const [compliance, setCompliance] = useState(null);
  const [tab, setTab] = useState('ports');
  const [backups, setBackups] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [editingPort, setEditingPort] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [swData, portsData, vlansData, complianceData] = await Promise.all([
        api.getSwitch(id),
        api.listPorts(id),
        api.listVlans(id),
        api.complianceFor(id).catch((e) => ({ error: e.message })),
      ]);
      setSw(swData);
      setPorts(portsData);
      setVlans(vlansData);
      setCompliance(complianceData);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (tab === 'backups') api.backupHistory(id).then(setBackups);
    if (tab === 'audit') api.listAuditLog(id).then(setAuditLog);
  }, [tab, id]);

  const complianceByPort = compliance && !compliance.error
    ? Object.fromEntries(compliance.ports.map((p) => [p.portName, p]))
    : {};

  if (error) return <div className="error-text">{error}</div>;
  if (!sw) return <p className="muted">Loading...</p>;

  return (
    <div>
      <div className="toolbar">
        <div>
          <Link to="/" className="muted">&larr; Switches</Link>
          <h1>{sw.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {sw.host}:{sw.ssh_port} &middot; {sw.system_info_json ? JSON.parse(sw.system_info_json).Version : 'unknown model'}
          </p>
        </div>
        <button onClick={() => api.pollSwitch(id).then(load)}>Poll now</button>
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, padding: 8 }}>
        {['ports', 'backups', 'audit'].map((t) => (
          <button key={t} className={t === tab ? '' : 'secondary'} onClick={() => setTab(t)}>
            {t === 'ports' ? 'Ports' : t === 'backups' ? 'Backup history' : 'Audit log'}
          </button>
        ))}
      </div>

      {tab === 'ports' && (
        <div className="card">
          {compliance?.missingVlans?.length > 0 && (
            <p className="error-text">Missing required VLANs: {compliance.missingVlans.join(', ')}</p>
          )}
          <table>
            <thead>
              <tr>
                <th>Port</th>
                <th>Status</th>
                <th>Native VLAN</th>
                <th>PoE</th>
                <th>Description</th>
                <th>MAC / discovered device</th>
                <th>Compliance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => {
                const pc = complianceByPort[p.port_name];
                return (
                  <tr key={p.port_name}>
                    <td>{p.port_name}</td>
                    <td>
                      <span className={`badge ${p.oper_status}`}>{p.oper_status}</span>
                    </td>
                    <td>{p.native_vlan}</td>
                    <td>
                      {p.poe_enabled ? (
                        <>
                          <span className="poe-bar">
                            <div style={{ width: `${Math.min(100, (p.poe_watts / MAX_POE_W) * 100)}%` }} />
                          </span>
                          {p.poe_watts} W
                        </>
                      ) : (
                        <span className="muted">off</span>
                      )}
                    </td>
                    <td>{p.description || <span className="muted">-</span>}</td>
                    <td>
                      {p.macEntries.length === 0 && <span className="muted">-</span>}
                      {p.macEntries.map((m) => (
                        <div key={m.macAddress} style={{ fontSize: 12 }}>
                          <span className="mono">{m.macAddress}</span>{' '}
                          {m.hostname && <strong>{m.hostname}</strong>}{' '}
                          {m.ipAddress && <span className="muted">({m.ipAddress})</span>}
                        </div>
                      ))}
                    </td>
                    <td>
                      {pc ? (
                        <span
                          className={`badge ${pc.compliant ? 'compliant' : 'non-compliant'}`}
                          title={pc.violations.join('; ')}
                        >
                          {pc.compliant ? 'OK' : pc.violations.length + ' issue(s)'}
                        </span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>
                      <button className="small secondary" onClick={() => setEditingPort(p)}>Edit</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'backups' && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Commit</th>
                <th>Reason</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.commit_hash?.slice(0, 10)}</td>
                  <td>{b.reason}</td>
                  <td className="muted">{b.created_at}</td>
                  <td>
                    <button
                      className="small secondary"
                      onClick={async () => {
                        const text = await api.backupConfig(id, b.commit_hash);
                        alert(text.slice(0, 4000));
                      }}
                    >
                      View config
                    </button>
                  </td>
                </tr>
              ))}
              {backups.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">No backups yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Port</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {auditLog.map((a) => (
                <tr key={a.id}>
                  <td className="muted">{a.created_at}</td>
                  <td>{a.action}</td>
                  <td>{a.port_name || '-'}</td>
                  <td>
                    <span className={`badge ${a.result === 'success' ? 'ok' : 'error'}`}>{a.result}</span>
                  </td>
                  <td className="mono" style={{ maxWidth: 400 }}>{a.error || a.detail_json || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingPort && (
        <EditPortModal
          switchId={id}
          port={editingPort}
          vlans={vlans}
          onClose={() => setEditingPort(null)}
          onSaved={() => {
            setEditingPort(null);
            load();
          }}
        />
      )}
    </div>
  );
}
