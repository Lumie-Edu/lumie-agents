import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { isBrowserRuntime } from './runtime';
import { connectWs } from './wsClient';

async function main() {
  if (isBrowserRuntime) {
    // Connect WebSocket first — server will send real data
    connectWs();
    // Still init browser mock for asset loading (PNGs via HTTP)
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
