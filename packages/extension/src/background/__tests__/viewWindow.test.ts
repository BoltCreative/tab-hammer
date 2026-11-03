import { describe, expect, it, vi } from 'vitest';
import { ensureViewWindow, type ViewTab, type ViewWindowDeps } from '../viewWindow';

function deps(tabs: ViewTab[], alive: boolean) {
  return {
    viewTabs: vi.fn(async () => tabs),
    ping: vi.fn(async () => alive),
    reloadTab: vi.fn<(id: number) => Promise<void>>(async () => {}),
    focusWindow: vi.fn<(id: number) => Promise<void>>(async () => {}),
    removeWindow: vi.fn<(id: number) => Promise<void>>(async () => {}),
    createWindow: vi.fn(async () => {}),
  } satisfies ViewWindowDeps;
}

describe('ensureViewWindow', () => {
  it('creates the window when none is open', async () => {
    const d = deps([], false);
    await ensureViewWindow(d, true);
    expect(d.createWindow).toHaveBeenCalledOnce();
  });

  it('focuses a live window without reloading it', async () => {
    const d = deps([{ tabId: 1, windowId: 10 }], true);
    await ensureViewWindow(d, true);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
    expect(d.reloadTab).not.toHaveBeenCalled();
    expect(d.createWindow).not.toHaveBeenCalled();
  });

  it('reloads a blank window in place instead of opening another', async () => {
    const d = deps([{ tabId: 1, windowId: 10 }], false);
    await ensureViewWindow(d, true);
    expect(d.reloadTab).toHaveBeenCalledWith(1);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
    expect(d.createWindow).not.toHaveBeenCalled();
  });

  it('closes leftover windows before checking the one it keeps', async () => {
    const order: string[] = [];
    const d = deps(
      [
        { tabId: 1, windowId: 10 },
        { tabId: 2, windowId: 11 },
        { tabId: 3, windowId: 12 },
      ],
      true,
    );
    d.removeWindow.mockImplementation(async (id: number) => void order.push(`remove ${id}`));
    d.ping.mockImplementation(async () => (order.push('ping'), true));
    await ensureViewWindow(d, true);
    expect(order).toEqual(['remove 11', 'remove 12', 'ping']);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
  });

  it('on an extension reload, repairs without focusing or creating', async () => {
    const blank = deps([{ tabId: 1, windowId: 10 }], false);
    await ensureViewWindow(blank, false);
    expect(blank.reloadTab).toHaveBeenCalledWith(1);
    expect(blank.focusWindow).not.toHaveBeenCalled();

    const none = deps([], false);
    await ensureViewWindow(none, false);
    expect(none.createWindow).not.toHaveBeenCalled();
  });
});
