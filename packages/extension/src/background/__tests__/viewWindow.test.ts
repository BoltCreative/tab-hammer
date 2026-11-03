import { describe, expect, it, vi } from 'vitest';
import { ensureViewWindow, type ViewTab, type ViewWindowDeps } from '../viewWindow';

const live = (tabId: number, windowId: number): ViewTab => ({ tabId, windowId, orphaned: false });
const orphan = (tabId: number, windowId: number): ViewTab => ({ tabId, windowId, orphaned: true });

function deps(tabs: ViewTab[], alive: boolean) {
  return {
    viewTabs: vi.fn(async () => tabs),
    ping: vi.fn(async () => alive),
    reloadTab: vi.fn<(id: number) => Promise<void>>(async () => {}),
    restoreTab: vi.fn<(id: number) => Promise<void>>(async () => {}),
    focusWindow: vi.fn<(id: number) => Promise<void>>(async () => {}),
    removeWindow: vi.fn<(id: number) => Promise<void>>(async () => {}),
    createWindow: vi.fn(async () => 42),
    remember: vi.fn<(id: number) => Promise<void>>(async () => {}),
  } satisfies ViewWindowDeps;
}

describe('ensureViewWindow', () => {
  it('creates and remembers the window when none is open', async () => {
    const d = deps([], false);
    await ensureViewWindow(d, true);
    expect(d.createWindow).toHaveBeenCalledOnce();
    expect(d.remember).toHaveBeenCalledWith(42);
  });

  it('focuses a live window without reloading it', async () => {
    const d = deps([live(1, 10)], true);
    await ensureViewWindow(d, true);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
    expect(d.reloadTab).not.toHaveBeenCalled();
    expect(d.createWindow).not.toHaveBeenCalled();
  });

  it('reloads a blank window in place instead of opening another', async () => {
    const d = deps([live(1, 10)], false);
    await ensureViewWindow(d, true);
    expect(d.reloadTab).toHaveBeenCalledWith(1);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
    expect(d.createWindow).not.toHaveBeenCalled();
  });

  it('navigates an orphaned window back to the view instead of opening another', async () => {
    const d = deps([orphan(1, 10)], false);
    await ensureViewWindow(d, true);
    expect(d.restoreTab).toHaveBeenCalledWith(1);
    expect(d.ping).not.toHaveBeenCalled();
    expect(d.focusWindow).toHaveBeenCalledWith(10);
    expect(d.createWindow).not.toHaveBeenCalled();
  });

  it('keeps a live window over an orphaned one and closes the orphan', async () => {
    const d = deps([live(2, 11), orphan(1, 10)], true);
    await ensureViewWindow(d, true);
    expect(d.removeWindow).toHaveBeenCalledWith(10);
    expect(d.restoreTab).not.toHaveBeenCalled();
    expect(d.remember).toHaveBeenCalledWith(11);
    expect(d.focusWindow).toHaveBeenCalledWith(11);
  });

  it('closes leftover windows before checking the one it keeps', async () => {
    const order: string[] = [];
    const d = deps([live(1, 10), live(2, 11), live(3, 12)], true);
    d.removeWindow.mockImplementation(async (id) => void order.push(`remove ${id}`));
    d.ping.mockImplementation(async () => (order.push('ping'), true));
    await ensureViewWindow(d, true);
    expect(order).toEqual(['remove 11', 'remove 12', 'ping']);
    expect(d.focusWindow).toHaveBeenCalledWith(10);
  });

  it('on an extension reload, repairs without focusing or creating', async () => {
    const orphaned = deps([orphan(1, 10)], false);
    await ensureViewWindow(orphaned, false);
    expect(orphaned.restoreTab).toHaveBeenCalledWith(1);
    expect(orphaned.focusWindow).not.toHaveBeenCalled();

    const none = deps([], false);
    await ensureViewWindow(none, false);
    expect(none.createWindow).not.toHaveBeenCalled();
  });
});
