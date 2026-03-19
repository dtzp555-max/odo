import { useState, useEffect, useCallback } from 'react';

type GatewayStatus = 'unknown' | 'checking' | 'running' | 'stopped' | 'error';

function Dashboard() {
  const [gwStatus, setGwStatus] = useState<GatewayStatus>('unknown');
  const [gwOutput, setGwOutput] = useState('');
  const [actionInProgress, setActionInProgress] = useState(false);

  const isElectron = typeof window !== 'undefined' && window.odo?.isElectron;

  const checkStatus = useCallback(async () => {
    if (!isElectron) {
      setGwStatus('unknown');
      setGwOutput('Not running in Electron');
      return;
    }
    setGwStatus('checking');
    try {
      const result = await window.odo.gateway.status();
      // Parse the output to determine status
      if (result.toLowerCase().includes('running') || result.toLowerCase().includes('active')) {
        setGwStatus('running');
      } else {
        setGwStatus('stopped');
      }
      setGwOutput(result);
    } catch (err) {
      setGwStatus('error');
      setGwOutput(String(err));
    }
  }, [isElectron]);

  useEffect(() => {
    checkStatus();
    // Poll every 15 seconds
    const interval = setInterval(checkStatus, 15000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!isElectron) return;
    setActionInProgress(true);
    try {
      const result = await window.odo.gateway[action]();
      setGwOutput(result);
      // Re-check status after action
      setTimeout(checkStatus, 1000);
    } catch (err) {
      setGwOutput(String(err));
    } finally {
      setActionInProgress(false);
    }
  };

  const statusColor: Record<GatewayStatus, string> = {
    unknown: 'bg-gray-500',
    checking: 'bg-yellow-500 animate-pulse',
    running: 'bg-green-500',
    stopped: 'bg-red-500',
    error: 'bg-red-700',
  };

  return (
    <div className="min-h-screen bg-odo-bg p-6">
      {/* Header */}
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-white tracking-tight">ODO</h1>
        <p className="text-odo-text-dim text-sm mt-1">
          OpenClaw Dashboard Orchestrator
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Gateway Control */}
        <section className="bg-odo-surface border border-odo-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            Gateway Control
          </h2>

          {/* Status indicator */}
          <div className="flex items-center gap-3 mb-4">
            <span
              className={`inline-block w-3 h-3 rounded-full ${statusColor[gwStatus]}`}
            />
            <span className="text-odo-text capitalize">{gwStatus}</span>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => handleAction('start')}
              disabled={actionInProgress || !isElectron}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
            >
              Start
            </button>
            <button
              onClick={() => handleAction('stop')}
              disabled={actionInProgress || !isElectron}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
            >
              Stop
            </button>
            <button
              onClick={() => handleAction('restart')}
              disabled={actionInProgress || !isElectron}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
            >
              Restart
            </button>
            <button
              onClick={checkStatus}
              disabled={!isElectron}
              className="px-4 py-2 bg-odo-border hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Output */}
          {gwOutput && (
            <pre className="bg-odo-bg border border-odo-border rounded p-3 text-xs text-odo-text-dim overflow-x-auto whitespace-pre-wrap max-h-40">
              {gwOutput}
            </pre>
          )}
        </section>

        {/* Agent Overview (placeholder) */}
        <section className="bg-odo-surface border border-odo-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            Agent Overview
          </h2>
          <p className="text-odo-text-dim text-sm">
            Agent management will be available in a future update.
          </p>
        </section>

        {/* Stats Summary (placeholder) */}
        <section className="bg-odo-surface border border-odo-border rounded-lg p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-white mb-4">
            Stats Summary
          </h2>
          <p className="text-odo-text-dim text-sm">
            System statistics and metrics will be available in a future update.
          </p>
        </section>
      </div>

      {/* Footer */}
      <footer className="mt-8 text-center text-odo-text-dim text-xs">
        ODO v{window.odo?.version ?? '0.10.0'} &middot; OpenClaw Dashboard
        Orchestrator
      </footer>
    </div>
  );
}

export default Dashboard;
