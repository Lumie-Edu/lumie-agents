/**
 * WebSocket client for standalone server mode.
 * Receives messages and dispatches them as window MessageEvents
 * (same format as VS Code postMessage), so the existing
 * useExtensionMessages handler works unchanged.
 */

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _connected = false;
const pendingMessages: unknown[] = [];

export function isWsConnected(): boolean {
  return _connected;
}

export function connectWs(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}`;

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    _connected = true;
    console.log('[WS] Connected');
    // Flush pending messages
    for (const msg of pendingMessages) {
      ws!.send(JSON.stringify(msg));
    }
    pendingMessages.length = 0;
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string);
      // Dispatch as window MessageEvent — same as VS Code postMessage
      window.dispatchEvent(new MessageEvent('message', { data }));
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.onclose = () => {
    _connected = false;
    console.log('[WS] Disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function sendWs(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Queue messages until connected
    pendingMessages.push(msg);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[WS] Reconnecting...');
    connectWs();
  }, 2000);
}
