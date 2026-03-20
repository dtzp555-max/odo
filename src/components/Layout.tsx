import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '🏠' },
  { to: '/agents', label: 'Agents', icon: '🤖' },
];

function Layout() {
  const isElectron = typeof window !== 'undefined' && window.odo?.isElectron;
  const version = window.odo?.version ?? '0.11.0';

  return (
    <div className="flex h-screen bg-odo-bg text-odo-text">
      {/* Sidebar */}
      <aside className="w-[200px] flex-shrink-0 bg-odo-surface border-r border-odo-border flex flex-col">
        {/* App title */}
        <div className="px-4 py-4 border-b border-odo-border">
          <h1 className="text-xl font-bold text-white tracking-tight">ODO</h1>
          <div className="flex items-center gap-2 mt-1">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                isElectron ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-odo-text-dim text-xs">
              {isElectron ? 'Connected' : 'No gateway'}
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-odo-accent/15 text-odo-accent border-r-2 border-odo-accent'
                    : 'text-odo-text-dim hover:text-odo-text hover:bg-odo-bg/50'
                }`
              }
            >
              <span className="text-lg">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Version footer */}
        <div className="px-4 py-3 border-t border-odo-border">
          <p className="text-odo-text-dim text-xs">v{version}</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
