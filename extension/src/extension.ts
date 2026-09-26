import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';

/* ------------------------------------------------------------------ *
 * Breakscale as an editor panel.
 *
 * The whole extension is a shell: it opens a webview, points it at the
 * build in media/, and holds the storage the panel cannot hold itself.
 * The simulator is the same code the website runs, unmodified, which is
 * the only way this stays worth maintaining. Every behaviour worth having
 * already exists; none of it is reimplemented here.
 *
 * The bundle ships inside the extension rather than loading from
 * breakscale.tech. A tool that stops working on a train, behind a
 * corporate proxy, or on a locked-down network is not a local tool, and
 * an editor extension that needed the internet to show a canvas would
 * surprise people in the worst way. The cost is that a new simulator
 * version needs a published release, which is the right trade for
 * something people open while working.
 * ------------------------------------------------------------------ */

/** Key under which the panel's storage lives in globalState. */
const STORAGE_KEY = 'breakscale.webviewStorage';

/** What the panel sends us. Anything else is ignored. */
type Incoming =
  | { type: 'breakscale:ready' }
  | { type: 'breakscale:persist'; entries: Record<string, string> };

function isIncoming(value: unknown): value is Incoming {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'breakscale:ready' || type === 'breakscale:persist';
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('breakscale.open', () => {
      Panel.reveal(context);
    }),
    vscode.window.registerWebviewViewProvider('breakscale.launch', new Launcher()),
  );
}

/**
 * The activity bar's own view.
 *
 * Clicking the icon has to show SOMETHING, and the simulator is not it: a
 * canvas in a sidebar strip is unusable, and the editor area is where it
 * belongs. So the view is a button, and its only job is to open the panel
 * and say what the panel is for someone who clicked the icon to find out.
 */
class Launcher implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = launcherHtml();
    view.webview.onDidReceiveMessage(() => {
      void vscode.commands.executeCommand('breakscale.open');
    });
  }
}

export function deactivate(): void {
  // Nothing to tear down: the panel's own disposables are registered with
  // it, and globalState is written on every change rather than on exit.
}

class Panel {
  /**
   * The one open panel, if there is one.
   *
   * A second panel would be a second copy of the app writing the same
   * globalState key, and whichever saved last would win. Revealing the
   * existing one is also what people expect from an editor: clicking the
   * icon again brings you back to your work rather than discarding it.
   */
  private static current: Panel | undefined;

  static reveal(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (Panel.current) {
      Panel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel('breakscale', 'Breakscale', column, {
      enableScripts: true,
      // The simulation is a running animation loop and the canvas holds
      // an unsaved design. Tearing both down because someone glanced at
      // another tab would lose work that was never written anywhere.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });

    Panel.current = new Panel(panel, context);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    // assets/, not media/: media/ is the webview build's output directory and
    // is emptied on every build, so anything hand-placed there disappears.
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.svg');

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (!isIncoming(message)) return;
        if (message.type === 'breakscale:ready') {
          void this.seed();
          return;
        }
        void this.context.globalState.update(STORAGE_KEY, message.entries);
      },
      null,
      this.disposables,
    );

    void this.load();
  }

  /** Hand the panel everything we hold, so its storage can be synchronous. */
  private async seed(): Promise<void> {
    const entries = this.context.globalState.get<Record<string, string>>(
      STORAGE_KEY,
      {},
    );
    await this.panel.webview.postMessage({ type: 'breakscale:seed', entries });
  }

  private async load(): Promise<void> {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const indexPath = vscode.Uri.joinPath(root, 'index.webview.html');

    let html: string;
    try {
      html = await readFile(indexPath.fsPath, 'utf8');
    } catch {
      // The build did not run, or the .vsix was packaged without it. Say
      // which, because "blank panel" is the least actionable bug report
      // there is.
      this.panel.webview.html = errorPage(
        'Breakscale could not find its build. Run `bun run build:webview` in the repository, or reinstall the extension.',
      );
      return;
    }

    this.panel.webview.html = this.render(html, root);
  }

  /**
   * Turn the built HTML into something a webview will run.
   *
   * Two rewrites. Asset paths become `vscode-webview://` URIs, because a
   * relative `./assets/x.js` resolves against an origin whose host is a
   * generated UUID and would 404. And the CSP placeholder becomes a real
   * policy naming a fresh nonce, because a webview refuses inline script
   * without one and refuses everything without a policy.
   */
  private render(html: string, root: vscode.Uri): string {
    const { webview } = this.panel;
    const nonce = newNonce();

    const withAssets = html.replace(
      /(src|href)="\.\/([^"]+)"/g,
      (_match, attribute: string, path: string) =>
        `${attribute}="${webview.asWebviewUri(vscode.Uri.joinPath(root, path)).toString()}"`,
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      // The share link store and the star count. Named rather than left
      // open: a panel that may reach anything is a panel nobody can reason
      // about, and these two are the only outbound calls the app makes.
      `connect-src https://links.breakscale.tech https://api.github.com`,
    ].join('; ');

    return withAssets
      .replace('__CSP__', csp)
      .replace(/<script /g, `<script nonce="${nonce}" `);
  }

  private dispose(): void {
    Panel.current = undefined;
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function newNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

/**
 * The sidebar's contents: one button and a sentence.
 *
 * Styled from VS Code's own theme variables rather than Breakscale's, so it
 * reads as part of the editor. The panel it opens is the place with the
 * product's own look; a sidebar strip that ignored the user's theme would
 * just look broken.
 */
function launcherHtml(): string {
  const nonce = newNonce();
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
    <style>
      body {
        padding: 12px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
      }
      button {
        width: 100%;
        padding: 6px 12px;
        font-family: inherit;
        font-size: inherit;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }
      button:hover { background: var(--vscode-button-hoverBackground); }
      p {
        margin: 10px 0 0;
        line-height: 1.5;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <button id="open" type="button">Open Breakscale</button>
    <p>Build a system, load it until it breaks, and watch why.</p>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('open').addEventListener('click', () => vscode.postMessage({}));
    </script>
  </body>
</html>`;
}

function errorPage(message: string): string {
  // Ampersand first: the other way round re-escapes the ampersands the
  // first replacement just introduced.
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family); padding: 2rem; color: var(--vscode-foreground)"><p>${escaped}</p></body></html>`;
}
