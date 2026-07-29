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
  const [enforcing, setEnforcing] = useState(false);
  const [enforceResult, setEnforceResult] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [changingTemplate, setChangingTemplate] = useState(false);
  const [viewingConfig, setViewingConfig] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(null);

  const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

  // Backup "reason" strings can be long one-liners (e.g. an Enforce run lists
  // every changed field per port) - truncate for the table, full text on hover.
  function truncate(text, max = 80) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  async function submitRename() {
    if (nameDraft === sw.name) {
      setRenaming(false);
      return;
    }
    if (!NAME_PATTERN.test(nameDraft)) {
      setRenameError('Only letters, numbers, hyphens (-), and underscores (_) are allowed.');
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await api.renameSwitch(id, nameDraft);
      setRenaming(false);
      await load();
    } catch (err) {
      setRenameError(err.message);
    } finally {
      setRenameBusy(false);
    }
  }

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
    api.listTemplates().then(setTemplates);
  }, []);

  async function changeTemplate(name) {
    setChangingTemplate(true);
    setEnforceResult(null);
    try {
      await api.updateSwitch(id, { roleTemplate: name });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setChangingTemplate(false);
    }
  }

  useEffect(() => {
    if (tab === 'backups') api.backupHistory(id).then(setBackups);
    if (tab === 'audit') api.listAuditLog(id).then(setAuditLog);
  }, [tab, id]);

  const complianceByPort = compliance && !compliance.error
    ? Object.fromEntries(compliance.ports.map((p) => [p.portName, p]))
    : {};

  const diffRows = compliance && !compliance.error
    ? compliance.ports.flatMap((p) =>
        p.violations.map((v) => ({ scope: p.portName, field: v.field, current: v.current, expected: v.expected }))
      )
    : [];
  const globalDiffRows = compliance && !compliance.error ? compliance.globalViolations || [] : [];

  async function enforce() {
    if (!confirm(
      `This will push ${diffRows.length + globalDiffRows.length} change(s) to the real switch over SSH to match the ` +
        `"${compliance?.templateName}" template (see the diff below). This changes live device configuration - continue?`
    )) {
      return;
    }
    setEnforcing(true);
    setEnforceResult(null);
    try {
      const result = await api.enforceCompliance(id);
      setEnforceResult(result);
      await load();
    } catch (err) {
      setEnforceResult({ ok: false, error: err.message });
    } finally {
      setEnforcing(false);
    }
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!sw) return <p className="muted">Loading...</p>;

  return (
    <div>
      <div className="toolbar">
        <div>
          <Link to="/" className="muted">&larr; Switches</Link>
          {renaming ? (
            <div>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                disabled={renameBusy}
                style={{ fontSize: 18, fontWeight: 700 }}
                autoFocus
              />
              <button className="small" disabled={renameBusy} onClick={submitRename} style={{ marginLeft: 6 }}>
                {renameBusy ? 'Saving...' : 'Save'}
              </button>
              <button
                className="small secondary"
                disabled={renameBusy}
                onClick={() => {
                  setRenaming(false);
                  setRenameError(null);
                }}
                style={{ marginLeft: 4 }}
              >
                Cancel
              </button>
              {renameError && <div className="error-text">{renameError}</div>}
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                Also sets the switch's hostname over SSH to match.
              </p>
            </div>
          ) : (
            <h1>
              {sw.name}{' '}
              <button
                className="small secondary"
                onClick={() => {
                  setNameDraft(sw.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            </h1>
          )}
          <p className="muted" style={{ margin: 0 }}>
            {sw.host}:{sw.ssh_port} &middot; {sw.system_info_json ? JSON.parse(sw.system_info_json).Version : 'unknown model'}
          </p>
        </div>
        <button onClick={() => api.pollSwitch(id).then(load)}>Poll now</button>
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, padding: 8 }}>
        {['ports', 'compliance', 'backups', 'audit'].map((t) => (
          <button key={t} className={t === tab ? '' : 'secondary'} onClick={() => setTab(t)}>
            {t === 'ports'
              ? 'Ports'
              : t === 'compliance'
              ? `Compliance${diffRows.length + globalDiffRows.length > 0 ? ` (${diffRows.length + globalDiffRows.length})` : ''}`
              : t === 'backups'
              ? 'Backup history'
              : 'Audit log'}
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
                <th>LLDP Neighbor</th>
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
                      {p.lldp_neighbor_device ? (
                        <>
                          {p.lldp_neighbor_device}
                          {p.lldp_neighbor_port_id && <span className="muted"> ({p.lldp_neighbor_port_id})</span>}
                        </>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>
                      {p.macEntries.length === 0 && <span className="muted">-</span>}
                      {/* A trunk port legitimately shows the same MAC once per VLAN it
                          carries (e.g. a neighbor switch's own management interface) -
                          group by MAC and list the VLANs so that doesn't read as
                          duplicate rows. */}
                      {Object.values(
                        p.macEntries.reduce((acc, m) => {
                          acc[m.macAddress] ||= { ...m, vlans: [] };
                          acc[m.macAddress].vlans.push(m.vlan);
                          return acc;
                        }, {})
                      ).map((m) => (
                        <div key={m.macAddress} style={{ fontSize: 12 }}>
                          <span className="mono">{m.macAddress}</span>{' '}
                          {m.hostname && <strong>{m.hostname}</strong>}{' '}
                          {m.ipAddress && <span className="muted">({m.ipAddress})</span>}{' '}
                          <span className="muted">
                            VLAN{m.vlans.length > 1 ? 's' : ''} {m.vlans.join(', ')}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td>
                      {pc ? (
                        <span
                          className={`badge ${pc.compliant ? 'compliant' : 'non-compliant'}`}
                          title={pc.violations.map((v) => v.message).join('; ')}
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

      {tab === 'compliance' && (
        <div className="card">
          <div className="toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="muted" style={{ margin: 0 }} htmlFor="role-template-select">Template</label>
              <select
                id="role-template-select"
                value={sw.role_template || 'default'}
                disabled={changingTemplate}
                onChange={(e) => changeTemplate(e.target.value)}
              >
                {!templates.some((t) => t.name === sw.role_template) && (
                  <option value={sw.role_template}>{sw.role_template} (not found)</option>
                )}
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
            <button onClick={enforce} disabled={enforcing || diffRows.length + globalDiffRows.length === 0}>
              {enforcing ? 'Enforcing...' : 'Enforce desired state'}
            </button>
          </div>

          {enforceResult && (
            <p className={enforceResult.ok === false ? 'error-text' : 'muted'}>
              {enforceResult.error
                ? `Enforce failed: ${enforceResult.error}`
                : enforceResult.applied === false
                ? enforceResult.message
                : `Applied ${Object.keys(enforceResult.portChanges || {}).length} port change(s) and ` +
                  `${Object.keys(enforceResult.globalChanges || {}).length} global change(s). ` +
                  `Now ${enforceResult.report?.summary?.compliantPorts}/${enforceResult.report?.summary?.totalPorts} ports compliant.`}
            </p>
          )}

          {compliance?.missingVlans?.length > 0 && (
            <p className="error-text">Missing required VLANs: {compliance.missingVlans.join(', ')}</p>
          )}

          <h2>Global settings</h2>
          {globalDiffRows.length === 0 ? (
            <p className="muted">All site-wide settings match the template.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Current</th>
                  <th>Desired</th>
                </tr>
              </thead>
              <tbody>
                {globalDiffRows.map((v) => (
                  <tr key={v.field}>
                    <td className="mono">{v.field}</td>
                    <td className="error-text">{v.current === null || v.current === undefined ? 'not set' : String(v.current)}</td>
                    <td>{String(v.expected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Per-port settings</h2>
          {diffRows.length === 0 ? (
            <p className="muted">All ports match the template.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Field</th>
                  <th>Current</th>
                  <th>Desired</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map((row, i) => (
                  <tr key={`${row.scope}-${row.field}-${i}`}>
                    <td>{row.scope}</td>
                    <td className="mono">{row.field}</td>
                    <td className="error-text">{JSON.stringify(row.current)}</td>
                    <td>{row.expected === null ? <span className="muted">not enforceable</span> : JSON.stringify(row.expected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
                  <td title={b.reason} style={{ whiteSpace: 'normal' }}>{truncate(b.reason)}</td>
                  <td className="muted">{b.created_at}</td>
                  <td>
                    <button
                      className="small secondary"
                      onClick={async () => {
                        const text = await api.backupConfig(id, b.commit_hash);
                        setViewingConfig({ text, label: `${b.commit_hash?.slice(0, 10)} - ${b.created_at}` });
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

      {viewingConfig && (
        <div className="modal-overlay" onClick={() => setViewingConfig(null)}>
          <div
            className="modal"
            style={{ width: 800, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{viewingConfig.label}</h3>
            <pre
              className="mono"
              style={{ flex: 1, overflow: 'auto', background: 'var(--bg)', padding: 12, borderRadius: 6, margin: 0 }}
            >
              {viewingConfig.text}
            </pre>
            <div className="actions">
              <button className="secondary" onClick={() => setViewingConfig(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
