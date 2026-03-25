import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';

import { WebSocketServer, WebSocket } from 'ws';

import type { DiscoveryContext } from './agentDiscovery.js';
import { initialScan, startPeriodicScan } from './agentDiscovery.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import {
  loadLayout,
  readLayoutFromFile,
  watchLayoutFile,
  writeLayoutToFile,
} from './layoutPersistence.js';
import type { SendFn } from './timerManager.js';
import type { AgentState } from './types.js';

export interface ServerState {
  agents: Map<number, AgentState>;
  fileWatchers: Map<number, import('fs').FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  nextAgentId: { current: number };
  knownJsonlFiles: Set<string>;
  layoutWatcher: LayoutWatcher | null;
  scanTimer: ReturnType<typeof setInterval> | null;
  defaultLayout: Record<string, unknown> | null;
}

export function createServerState(): ServerState {
  return {
    agents: new Map(),
    fileWatchers: new Map(),
    pollingTimers: new Map(),
    waitingTimers: new Map(),
    permissionTimers: new Map(),
    nextAgentId: { current: 1 },
    knownJsonlFiles: new Set(),
    layoutWatcher: null,
    scanTimer: null,
    defaultLayout: null,
  };
}

export function setupWebSocket(httpServer: HttpServer, state: ServerState): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  // Broadcast to all connected clients
  const broadcast: SendFn = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  // Setup agent discovery with broadcast
  const discoveryCtx: DiscoveryContext = {
    agents: state.agents,
    fileWatchers: state.fileWatchers,
    pollingTimers: state.pollingTimers,
    waitingTimers: state.waitingTimers,
    permissionTimers: state.permissionTimers,
    nextAgentId: state.nextAgentId,
    knownJsonlFiles: state.knownJsonlFiles,
    send: broadcast,
  };

  // Initial scan on startup
  initialScan(discoveryCtx);

  // Start periodic scanning
  state.scanTimer = startPeriodicScan(discoveryCtx);

  // Start layout file watcher
  state.layoutWatcher = watchLayoutFile((layout) => {
    console.log('[Server] External layout change — broadcasting');
    broadcast({ type: 'layoutLoaded', layout });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    console.log('[Server] WebSocket client connected');

    const sendToClient: SendFn = (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on('message', (raw: Buffer | string) => {
      try {
        const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        handleClientMessage(message, state, sendToClient, broadcast);
      } catch {
        /* ignore malformed messages */
      }
    });

    ws.on('close', () => {
      console.log('[Server] WebSocket client disconnected');
    });
  });

  return wss;
}

function handleClientMessage(
  message: Record<string, unknown>,
  state: ServerState,
  sendToClient: SendFn,
  broadcast: SendFn,
): void {
  switch (message.type) {
    case 'webviewReady': {
      // Send settings
      sendToClient({ type: 'settingsLoaded', soundEnabled: true });

      // Send existing agents BEFORE layout so they are buffered in pendingAgents
      // (layoutLoaded handler processes the buffer and calls os.addAgent())
      const agentIds: number[] = [];
      for (const id of state.agents.keys()) {
        agentIds.push(id);
      }
      agentIds.sort((a, b) => a - b);
      sendToClient({
        type: 'existingAgents',
        agents: agentIds,
        agentMeta: {},
        folderNames: {},
      });

      // Send layout (processes buffered agents)
      const result = loadLayout(state.defaultLayout);
      sendToClient({
        type: 'layoutLoaded',
        layout: result?.layout ?? null,
        wasReset: result?.wasReset ?? false,
      });

      // Re-send current agent statuses
      for (const [agentId, agent] of state.agents) {
        for (const [toolId, status] of agent.activeToolStatuses) {
          sendToClient({ type: 'agentToolStart', id: agentId, toolId, status });
        }
        if (agent.isWaiting) {
          sendToClient({ type: 'agentStatus', id: agentId, status: 'waiting' });
        }
      }
      break;
    }

    case 'saveLayout': {
      state.layoutWatcher?.markOwnWrite();
      writeLayoutToFile(message.layout as Record<string, unknown>);
      break;
    }

    case 'saveAgentSeats': {
      // Single user — we don't need persistent seat storage, just acknowledge
      console.log('[Server] saveAgentSeats received');
      break;
    }

    case 'setSoundEnabled': {
      // Single user — just acknowledge
      break;
    }

    case 'exportLayout': {
      const layout = readLayoutFromFile();
      if (layout) {
        sendToClient({ type: 'exportLayoutData', layout });
      }
      break;
    }

    case 'importLayout': {
      const imported = message.layout as Record<string, unknown>;
      if (imported && imported.version === 1 && Array.isArray(imported.tiles)) {
        state.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(imported);
        broadcast({ type: 'layoutLoaded', layout: imported });
      }
      break;
    }

    // Observation-only: these VS Code-specific actions are no-ops
    case 'openClaude':
    case 'focusAgent':
    case 'closeAgent':
    case 'openSessionsFolder':
      break;

    default:
      break;
  }
}
