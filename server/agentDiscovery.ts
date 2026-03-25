import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AGENT_ACTIVE_THRESHOLD_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { readNewLines, startFileWatching, stopFileWatching } from './fileWatcher.js';
import type { SendFn } from './timerManager.js';
import type { AgentState } from './types.js';

export interface DiscoveryContext {
  agents: Map<number, AgentState>;
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  nextAgentId: { current: number };
  knownJsonlFiles: Set<string>;
  send: SendFn;
}

/**
 * Scan all ~/.claude/projects/*\/ directories for active JSONL files.
 * Returns the number of agents discovered on initial scan.
 */
export function initialScan(ctx: DiscoveryContext): number {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) {
    console.log('[Server] No ~/.claude/projects/ directory found');
    return 0;
  }

  let count = 0;
  const now = Date.now();

  try {
    const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(claudeDir, entry.name);
      const jsonlFiles = getJsonlFiles(projectDir);

      for (const file of jsonlFiles) {
        ctx.knownJsonlFiles.add(file);
        try {
          const stat = fs.statSync(file);
          if (now - stat.mtimeMs < AGENT_ACTIVE_THRESHOLD_MS) {
            createAgentForFile(ctx, file, projectDir, stat.size);
            count++;
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  console.log(`[Server] Initial scan: found ${count} active agent(s)`);
  return count;
}

/**
 * Start periodic scanning for new JSONL files across all project directories.
 * Also removes stale agents whose JSONL files haven't been modified recently.
 */
export function startPeriodicScan(ctx: DiscoveryContext): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) return;

    // Remove stale agents whose JSONL files haven't been modified within the threshold
    const now = Date.now();
    for (const [id, agent] of ctx.agents) {
      try {
        const stat = fs.statSync(agent.jsonlFile);
        if (now - stat.mtimeMs >= AGENT_ACTIVE_THRESHOLD_MS) {
          console.log(
            `[Server] Agent ${id}: stale (no activity for ${Math.round((now - stat.mtimeMs) / 1000)}s), removing`,
          );
          stopFileWatching(
            id,
            ctx.agents,
            ctx.fileWatchers,
            ctx.pollingTimers,
            ctx.waitingTimers,
            ctx.permissionTimers,
          );
          ctx.agents.delete(id);
          ctx.send({ type: 'agentClosed', id });
        }
      } catch {
        // File may have been deleted — remove the agent
        console.log(`[Server] Agent ${id}: JSONL file gone, removing`);
        stopFileWatching(
          id,
          ctx.agents,
          ctx.fileWatchers,
          ctx.pollingTimers,
          ctx.waitingTimers,
          ctx.permissionTimers,
        );
        ctx.agents.delete(id);
        ctx.send({ type: 'agentClosed', id });
      }
    }

    try {
      const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });
      for (const entry of projectDirs) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(claudeDir, entry.name);
        const jsonlFiles = getJsonlFiles(projectDir);

        for (const file of jsonlFiles) {
          if (!ctx.knownJsonlFiles.has(file)) {
            ctx.knownJsonlFiles.add(file);
            console.log(`[Server] New JSONL detected: ${path.basename(file)}`);
            // Start from beginning of file for new sessions
            createAgentForFile(ctx, file, projectDir, 0);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

function getJsonlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function createAgentForFile(
  ctx: DiscoveryContext,
  jsonlFile: string,
  projectDir: string,
  fileOffset: number,
): void {
  // Check if an agent already exists for this file
  for (const agent of ctx.agents.values()) {
    if (agent.jsonlFile === jsonlFile) return;
  }

  const id = ctx.nextAgentId.current++;
  const agent: AgentState = {
    id,
    projectDir,
    jsonlFile,
    fileOffset,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  };

  ctx.agents.set(id, agent);
  console.log(`[Server] Agent ${id}: watching ${path.basename(jsonlFile)}`);
  ctx.send({ type: 'agentCreated', id });

  startFileWatching(
    id,
    jsonlFile,
    ctx.agents,
    ctx.fileWatchers,
    ctx.pollingTimers,
    ctx.waitingTimers,
    ctx.permissionTimers,
    ctx.send,
  );

  // If starting from a non-zero offset, the agent was already running
  // Read any new lines that appeared since the offset
  if (fileOffset > 0) {
    readNewLines(id, ctx.agents, ctx.waitingTimers, ctx.permissionTimers, ctx.send);
  }
}
