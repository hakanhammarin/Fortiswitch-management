import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [yamlBody, setYamlBody] = useState('');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  function load() {
    api.listTemplates().then(setTemplates);
  }

  useEffect(load, []);

  function select(t) {
    setSelected(t.id);
    setName(t.name);
    setDescription(t.description || '');
    setYamlBody(t.yaml_body);
    setSaved(false);
  }

  function newTemplate() {
    setSelected(null);
    setName('');
    setDescription('');
    setYamlBody(
      `name: new-template\ndescription: describe this switch role\nvlans:\n  required: [1, 10]\nrules:\n  - match: ".*"\n    matchBy: portName\n    expect:\n      adminStatus: up\n      poeEnabled: true\n      nativeVlanIn: [10]\n`
    );
  }

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.saveTemplate({ name, description, yamlBody });
      setSaved(true);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h1>Desired-State Templates</h1>
        <button onClick={newTemplate}>+ New template</button>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div className="card" style={{ width: 240, flexShrink: 0 }}>
          <h2>Templates</h2>
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => select(t)}
              style={{ padding: '6px 4px', cursor: 'pointer', fontWeight: selected === t.id ? 700 : 400 }}
            >
              {t.name}
            </div>
          ))}
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h2>{selected ? 'Edit template' : 'New template'}</h2>
          <form onSubmit={save}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
            <label>Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
            <label>YAML rules</label>
            <textarea
              rows={18}
              style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              value={yamlBody}
              onChange={(e) => setYamlBody(e.target.value)}
            />
            {error && <div className="error-text">{error}</div>}
            {saved && <p className="muted">Saved.</p>}
            <div className="actions">
              <button type="submit">Save template</button>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <p className="muted" style={{ fontSize: 12 }}>
          A switch is assigned a template via its <span className="mono">role_template</span> field (set when
          adding/editing a switch). Rules are matched top-to-bottom per port by port name or description regex;
          the first match wins. See the per-switch "Ports" tab for live compliance against the assigned template.
        </p>
      </div>
    </div>
  );
}
