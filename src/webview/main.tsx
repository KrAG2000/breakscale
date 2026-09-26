import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import App from '../App';
import { bridgeStorage } from './storage';

/*
 * The panel's entry point.
 *
 * Two things differ from src/main.tsx, and the app itself is untouched by
 * both.
 *
 * No Analytics and no Speed Insights. They are right for a website and
 * wrong for an editor: an extension that opened a beacon to a third party
 * every time someone clicked its icon is not what a developer installing a
 * local tool is agreeing to, and neither package would have anything
 * useful to report from a `vscode-webview://` origin anyway.
 *
 * The render waits on `bridgeStorage`. It resolves in a message round trip
 * or not at all, but the app reads storage during its very first render to
 * restore the last session, so mounting first would mean restoring from an
 * empty store and then having the real one arrive too late to matter.
 */
const host = document.getElementById('root');
if (!host) throw new Error('Root element #root not found');

void bridgeStorage().then(() => {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
