import { useState, useEffect } from 'react';
import { api } from '../api/client.js';

export default function AddSwitchModal({ onClose, onCreated, initial = {} }) {
  const [form, setForm] = useState({
    name: initial.name || '',
    host: initial.host || '',
    sshPort: initial.sshPort || 22,
    username: initial.username || '',
    password: '',
    roleTemplate: initial.roleTemplate || 'default',
  });
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTemplates().then(setTemplates);
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (initial.onImport) {
        await initial.onImport(form);
      } else {
        await api.createSwitch({ ...form, sshPort: Number(form.sshPort) });
      }
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial.title || 'Add switch'}</h3>
        <form onSubmit={submit}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required />
          <label>Host / IP</label>
          <input value={form.host} onChange={(e) => set('host', e.target.value)} required />
          <label>SSH port</label>
          <input type="number" value={form.sshPort} onChange={(e) => set('sshPort', e.target.value)} required />
          <label>Username</label>
          <input value={form.username} onChange={(e) => set('username', e.target.value)} required />
          <label>Password</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            required
          />
          <label>Role template</label>
          <select value={form.roleTemplate} onChange={(e) => set('roleTemplate', e.target.value)}>
            {!templates.some((t) => t.name === form.roleTemplate) && (
              <option value={form.roleTemplate}>{form.roleTemplate} (not found)</option>
            )}
            {templates.map((t) => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>

          {error && <div className="error-text">{error}</div>}

          <div className="actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
