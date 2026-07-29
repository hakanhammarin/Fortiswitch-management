import { useState } from 'react';
import { api } from '../api/client.js';

export default function EditPortModal({ switchId, port, vlans, onClose, onSaved }) {
  const [nativeVlan, setNativeVlan] = useState(port.native_vlan);
  const [poeEnabled, setPoeEnabled] = useState(Boolean(port.poe_enabled));
  const [description, setDescription] = useState(port.description || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // `vlans` only lists formal `config switch vlan` objects, which some
  // switches never create (e.g. a flat-trunk FS108 with VLANs defined only
  // as `allowed-vlans` tags + routed L3 sub-interfaces). Fall back to this
  // port's own allowed-vlans - and always keep its current native VLAN
  // selectable even if neither source lists it. VLAN 1 is FortiSwitch's
  // default/untagged VLAN and is independent of allowed-vlans (every port on
  // a real fleet here has native-vlan 1 while allowed-vlans is [100,200,300]
  // - native-vlan isn't required to be a member of allowed-vlans), so it's
  // always offered too even if a port's currently on a different native VLAN.
  const namesById = Object.fromEntries(vlans.map((v) => [v.id, v.name]));
  const vlanIds = new Set([1, ...(port.allowedVlans || []), ...vlans.map((v) => v.id), port.native_vlan]);
  const vlanOptions = [...vlanIds].sort((a, b) => a - b).map((id) => ({ id, name: namesById[id] || `vlan${id}` }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const changes = {};
    if (Number(nativeVlan) !== port.native_vlan) changes.nativeVlan = Number(nativeVlan);
    if (poeEnabled !== Boolean(port.poe_enabled)) changes.poeEnabled = poeEnabled;
    if (description !== (port.description || '')) changes.description = description;

    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }

    try {
      await api.changePort(switchId, port.port_name, changes, 'ui-user');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit {port.port_name}</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          Only native VLAN, PoE, and description can be changed from here. The change is applied over SSH,
          then the switch's full config is re-read and committed to the backup history.
        </p>
        <form onSubmit={submit}>
          <label>Native VLAN</label>
          <select value={nativeVlan} onChange={(e) => setNativeVlan(e.target.value)}>
            {vlanOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} - {v.name}
              </option>
            ))}
          </select>

          <label>
            <input
              type="checkbox"
              checked={poeEnabled}
              onChange={(e) => setPoeEnabled(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            PoE enabled
          </label>

          <label>Description</label>
          <input value={description} maxLength={63} onChange={(e) => setDescription(e.target.value)} />

          {error && <div className="error-text">{error}</div>}

          <div className="actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? 'Applying...' : 'Apply change'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
