/* ------------------------------------------------------------------ *
 * Persistence for the editor panel.
 *
 * A webview's `localStorage` is real but not durable: the panel is
 * destroyed when its tab closes, and the storage goes with it. So every
 * saved design, every preference, and the session the app restores on
 * boot would survive exactly as long as the tab did, which is worse than
 * having no saving at all because the app would keep promising it.
 *
 * VS Code's own durable store is `ExtensionContext.globalState`, which
 * lives on the extension host rather than in the page. Reaching it means
 * a message round trip, and `localStorage` is synchronous, so the two do
 * not compose directly.
 *
 * The shape that does work: the host sends everything it holds ONCE
 * before the app starts, this module seeds a synchronous in-memory map
 * from it, and every later write goes to the map immediately and to the
 * host asynchronously. Reads never wait. The app is unchanged and does
 * not know any of this is happening, which is the point: `savedDesigns`,
 * `backup` and the preferences all keep talking to `localStorage`.
 *
 * The write-behind is safe here for a reason worth stating, since it is
 * usually not. The host is the only other writer, it only writes what
 * this page sent it, and a panel that is closing has already had its
 * messages flushed by the time the state is torn down. There is no
 * second editor mutating the same keys underneath us.
 * ------------------------------------------------------------------ */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/** Message the host sends once, before the app is mounted. */
interface SeedMessage {
  type: 'breakscale:seed';
  entries: Record<string, string>;
}

function isSeed(data: unknown): data is SeedMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'breakscale:seed' &&
    typeof (data as { entries?: unknown }).entries === 'object'
  );
}

/**
 * Replace `window.localStorage` with a map that reads synchronously and
 * writes through to the extension host.
 *
 * Defining the property rather than assigning it: `localStorage` is a
 * getter on the prototype in every engine this runs on, so a plain
 * assignment silently does nothing.
 */
function install(seed: Record<string, string>, api: VsCodeApi): void {
  const map = new Map<string, string>(Object.entries(seed));

  const send = (): void => {
    api.postMessage({
      type: 'breakscale:persist',
      entries: Object.fromEntries(map),
    });
  };

  const shim: Storage = {
    get length() {
      return map.size;
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
      send();
    },
    removeItem(key: string): void {
      map.delete(key);
      send();
    },
    clear(): void {
      map.clear();
      send();
    },
  };

  Object.defineProperty(window, 'localStorage', {
    value: shim,
    configurable: true,
  });
}

/**
 * Wait for the host's seed, install the shim, and resolve.
 *
 * Resolves rather than rejecting when there is no host or the seed never
 * arrives: the app still runs on the webview's own storage in that case,
 * losing durability but nothing else. A panel that refused to open
 * because a message was late would be a worse failure than one that
 * forgets a design.
 */
export function bridgeStorage(timeoutMs = 2000): Promise<void> {
  const api = window.acquireVsCodeApi?.();
  if (!api) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve();
    };

    const onMessage = (event: MessageEvent): void => {
      if (!isSeed(event.data)) return;
      install(event.data.entries, api);
      done();
    };

    window.addEventListener('message', onMessage);
    const timer = setTimeout(done, timeoutMs);
    api.postMessage({ type: 'breakscale:ready' });
  });
}
