import { isBrowserRuntime } from './runtime';
import { sendWs } from './wsClient';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? { postMessage: (msg: unknown) => sendWs(msg) }
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });
