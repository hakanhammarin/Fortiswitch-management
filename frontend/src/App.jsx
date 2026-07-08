import { NavLink, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import SwitchDetail from './pages/SwitchDetail.jsx';
import Templates from './pages/Templates.jsx';
import Import from './pages/Import.jsx';

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>FortiSwitch Fleet</h1>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Switches
          </NavLink>
          <NavLink to="/templates" className={({ isActive }) => (isActive ? 'active' : '')}>
            Desired State
          </NavLink>
          <NavLink to="/import" className={({ isActive }) => (isActive ? 'active' : '')}>
            Import (10mila_monitoring)
          </NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/switches/:id" element={<SwitchDetail />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/import" element={<Import />} />
        </Routes>
      </main>
    </div>
  );
}
