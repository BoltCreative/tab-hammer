// Waits for a tab to finish loading, for on-demand captures of tabs that aren't loaded yet.
// Chrome's events are injected so the early exits are unit-testable.

interface TabEvent<A extends unknown[]> {
  addListener(cb: (...args: A) => void): void;
  removeListener(cb: (...args: A) => void): void;
}

export interface LoadWaiterDeps {
  onUpdated: TabEvent<[tabId: number, change: { status?: string }]>;
  onRemoved: TabEvent<[tabId: number]>;
  getStatus: (tabId: number) => Promise<string | undefined>;
}

/**
 * Resolves true once the tab's status is 'complete' (including if it already is), or false when
 * the tab is closed or `ms` passes.
 */
export function createLoadWaiter(deps: LoadWaiterDeps) {
  return (tabId: number, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (complete: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deps.onUpdated.removeListener(onUpdated);
        deps.onRemoved.removeListener(onRemoved);
        resolve(complete);
      };
      const onUpdated = (id: number, change: { status?: string }) => {
        if (id === tabId && change.status === 'complete') finish(true);
      };
      const onRemoved = (id: number) => {
        if (id === tabId) finish(false);
      };
      deps.onUpdated.addListener(onUpdated);
      deps.onRemoved.addListener(onRemoved);
      const timer = setTimeout(() => finish(false), ms);
      // It may have finished (or closed) before the listeners were added.
      deps.getStatus(tabId).then(
        (status) => status === 'complete' && finish(true),
        () => finish(false),
      );
    });
}
