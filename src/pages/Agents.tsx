import { useState, useEffect, useCallback } from 'react';

// --- Types ---

interface Agent {
  agentId: string;
  displayName: string;
  model: string;
  parentAgentId?: string;
  workspace?: string;
  channels?: string[];
}

interface WorkspaceFile {
  name: string;
  content: string;
  type?: string;
}

type AgentsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; agents: Agent[] }
  | { status: 'error'; message: string };

type WorkspaceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; files: WorkspaceFile[] }
  | { status: 'error'; message: string };

const MODEL_OPTIONS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-4-5-20251001',
];

// --- Component ---

function Agents() {
  const [agentsState, setAgentsState] = useState<AgentsState>({ status: 'idle' });
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>({ status: 'idle' });
  const [viewingFile, setViewingFile] = useState<WorkspaceFile | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const isElectron = typeof window !== 'undefined' && window.odo?.isElectron;

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    if (!isElectron) {
      setAgentsState({ status: 'error', message: 'Not running in Electron' });
      return;
    }
    setAgentsState({ status: 'loading' });
    try {
      const data = await window.odo.ocm.api('GET', '/api/agents');
      const agents = (data as { agents: Agent[] }).agents ?? [];
      setAgentsState({ status: 'loaded', agents });
    } catch (err) {
      setAgentsState({ status: 'error', message: String(err) });
    }
  }, [isElectron]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Fetch workspace files for an agent
  const fetchWorkspace = useCallback(
    async (agentId: string) => {
      if (!isElectron) return;
      setWorkspace({ status: 'loading' });
      setViewingFile(null);
      setEditing(false);
      try {
        const data = await window.odo.ocm.api('GET', `/api/workspace/${agentId}`);
        const files = (data as { files: WorkspaceFile[] }).files ?? [];
        setWorkspace({ status: 'loaded', files });
      } catch (err) {
        setWorkspace({ status: 'error', message: String(err) });
      }
    },
    [isElectron],
  );

  // Toggle sub-agent expansion
  const toggleExpand = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  // Select agent to view workspace
  const handleSelectAgent = (agentId: string) => {
    if (selectedAgent === agentId) {
      setSelectedAgent(null);
      setWorkspace({ status: 'idle' });
      setViewingFile(null);
      return;
    }
    setSelectedAgent(agentId);
    fetchWorkspace(agentId);
  };

  // Update model
  const handleModelChange = async (agentId: string, model: string) => {
    if (!isElectron) return;
    try {
      await window.odo.ocm.api('PUT', `/api/agents/${agentId}`, { model });
      // Update local state
      setAgentsState((prev) => {
        if (prev.status !== 'loaded') return prev;
        return {
          ...prev,
          agents: prev.agents.map((a) =>
            a.agentId === agentId ? { ...a, model } : a,
          ),
        };
      });
    } catch (err) {
      console.error('Failed to update model:', err);
    }
  };

  // Save file
  const handleSave = async () => {
    if (!isElectron || !selectedAgent || !viewingFile) return;
    setSaving(true);
    try {
      await window.odo.ocm.api('PUT', `/api/workspace/${selectedAgent}`, {
        file: viewingFile.name,
        content: editContent,
      });
      // Update local state
      setViewingFile({ ...viewingFile, content: editContent });
      setEditing(false);
      // Refresh workspace
      fetchWorkspace(selectedAgent);
    } catch (err) {
      console.error('Failed to save file:', err);
    } finally {
      setSaving(false);
    }
  };

  // Build agent tree
  const getMainAgents = (): Agent[] => {
    if (agentsState.status !== 'loaded') return [];
    return agentsState.agents.filter((a) => !a.parentAgentId);
  };

  const getSubAgents = (parentId: string): Agent[] => {
    if (agentsState.status !== 'loaded') return [];
    return agentsState.agents.filter((a) => a.parentAgentId === parentId);
  };

  // --- Render helpers ---

  const renderAgentCard = (agent: Agent, isSubAgent = false) => {
    const subAgents = getSubAgents(agent.agentId);
    const isExpanded = expandedAgents.has(agent.agentId);
    const isSelected = selectedAgent === agent.agentId;

    return (
      <div key={agent.agentId} className={isSubAgent ? 'ml-6' : ''}>
        <div
          className={`bg-odo-surface border rounded-lg p-4 mb-2 transition-colors ${
            isSelected
              ? 'border-odo-accent'
              : 'border-odo-border hover:border-odo-text-dim'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {subAgents.length > 0 && (
                  <button
                    onClick={() => toggleExpand(agent.agentId)}
                    className="text-odo-text-dim hover:text-odo-text text-sm"
                  >
                    {isExpanded ? '▼' : '▶'}
                  </button>
                )}
                <h3 className="text-white font-medium truncate">
                  {agent.displayName || agent.agentId}
                </h3>
                {isSubAgent && (
                  <span className="text-xs bg-odo-border px-2 py-0.5 rounded text-odo-text-dim">
                    sub-agent
                  </span>
                )}
              </div>
              <p className="text-odo-text-dim text-xs mt-1 font-mono truncate">
                {agent.agentId}
              </p>
              {agent.workspace && (
                <p className="text-odo-text-dim text-xs mt-1 truncate">
                  📁 {agent.workspace}
                </p>
              )}
              {subAgents.length > 0 && (
                <p className="text-odo-text-dim text-xs mt-1">
                  {subAgents.length} sub-agent{subAgents.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-shrink-0">
              {/* Model selector */}
              <select
                value={agent.model}
                onChange={(e) => handleModelChange(agent.agentId, e.target.value)}
                className="bg-odo-bg border border-odo-border rounded px-2 py-1 text-xs text-odo-text focus:outline-none focus:border-odo-accent"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {/* Show current model even if not in presets */}
                {!MODEL_OPTIONS.includes(agent.model) && (
                  <option value={agent.model}>{agent.model}</option>
                )}
              </select>

              {/* Workspace button */}
              <button
                onClick={() => handleSelectAgent(agent.agentId)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  isSelected
                    ? 'bg-odo-accent text-white'
                    : 'bg-odo-border text-odo-text hover:bg-gray-600'
                }`}
              >
                {isSelected ? 'Close' : 'Files'}
              </button>
            </div>
          </div>

          {/* Workspace file browser */}
          {isSelected && (
            <div className="mt-4 border-t border-odo-border pt-4">
              {workspace.status === 'loading' && (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-8 bg-odo-bg border border-odo-border rounded animate-pulse"
                    />
                  ))}
                </div>
              )}

              {workspace.status === 'error' && (
                <p className="text-odo-text-dim text-sm">
                  Failed to load workspace: {workspace.message}
                </p>
              )}

              {workspace.status === 'loaded' && (
                <div>
                  {workspace.files.length === 0 ? (
                    <p className="text-odo-text-dim text-sm">No workspace files found.</p>
                  ) : (
                    <div className="flex gap-4">
                      {/* File list */}
                      <div className="w-48 flex-shrink-0 space-y-1">
                        {workspace.files.map((f) => (
                          <button
                            key={f.name}
                            onClick={() => {
                              setViewingFile(f);
                              setEditing(false);
                              setEditContent(f.content);
                            }}
                            className={`w-full text-left px-3 py-2 rounded text-xs font-mono transition-colors ${
                              viewingFile?.name === f.name
                                ? 'bg-odo-accent/15 text-odo-accent'
                                : 'text-odo-text-dim hover:text-odo-text hover:bg-odo-bg'
                            }`}
                          >
                            {f.name}
                          </button>
                        ))}
                      </div>

                      {/* File content */}
                      {viewingFile && (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-odo-text-dim font-mono">
                              {viewingFile.name}
                            </span>
                            <div className="flex gap-2">
                              {editing ? (
                                <>
                                  <button
                                    onClick={() => setEditing(false)}
                                    className="px-2 py-1 text-xs text-odo-text-dim hover:text-odo-text"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-3 py-1 bg-odo-accent hover:bg-odo-accent-hover disabled:opacity-50 text-white rounded text-xs font-medium transition-colors"
                                  >
                                    {saving ? 'Saving...' : 'Save'}
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => {
                                    setEditing(true);
                                    setEditContent(viewingFile.content);
                                  }}
                                  className="px-3 py-1 bg-odo-border hover:bg-gray-600 text-white rounded text-xs font-medium transition-colors"
                                >
                                  Edit
                                </button>
                              )}
                            </div>
                          </div>

                          {editing ? (
                            <textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              className="w-full h-64 bg-odo-bg border border-odo-border rounded p-3 text-xs text-odo-text font-mono resize-y focus:outline-none focus:border-odo-accent"
                            />
                          ) : (
                            <pre className="bg-odo-bg border border-odo-border rounded p-3 text-xs text-odo-text-dim overflow-auto whitespace-pre-wrap max-h-64">
                              {viewingFile.content}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sub-agents */}
        {isExpanded &&
          subAgents.map((sub) => renderAgentCard(sub, true))}
      </div>
    );
  };

  // --- Main render ---

  return (
    <div className="min-h-screen bg-odo-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Agents Console
          </h1>
          <p className="text-odo-text-dim text-sm mt-1">
            Manage agents, models, and workspace files
          </p>
        </div>
        <button
          onClick={fetchAgents}
          disabled={agentsState.status === 'loading'}
          className="px-4 py-2 bg-odo-border hover:bg-gray-600 disabled:opacity-50 text-white rounded text-sm font-medium transition-colors"
        >
          {agentsState.status === 'loading' ? 'Loading...' : 'Refresh'}
        </button>
      </header>

      {/* Loading skeleton */}
      {(agentsState.status === 'idle' || agentsState.status === 'loading') && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-odo-surface border border-odo-border rounded-lg p-4 animate-pulse"
            >
              <div className="h-5 bg-odo-border rounded w-48 mb-2" />
              <div className="h-4 bg-odo-border rounded w-72" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {agentsState.status === 'error' && (
        <div className="bg-odo-surface border border-odo-border rounded-lg p-6 text-center">
          <p className="text-odo-text-dim text-sm mb-4">
            Unable to load agents — OCM server may not be running.
          </p>
          <p className="text-odo-text-dim text-xs mb-4">{agentsState.message}</p>
          <button
            onClick={fetchAgents}
            className="px-4 py-2 bg-odo-border hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Agent list */}
      {agentsState.status === 'loaded' && (
        <div>
          {agentsState.agents.length === 0 ? (
            <div className="bg-odo-surface border border-odo-border rounded-lg p-6 text-center">
              <p className="text-odo-text-dim text-sm">
                No agents found. Start an agent via OpenClaw to see it here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {getMainAgents().map((agent) => renderAgentCard(agent))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Agents;
