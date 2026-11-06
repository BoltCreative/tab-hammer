// The outline as plain, portable JSON: what a sync file carries. Fields that only mean something on
// this machine (Chrome IDs, launch URLs, screen bounds, matching marks) are left out.
import type { GroupRec, TabRec, WindowRec } from '../outline/types';

export type SyncTab = Omit<TabRec, 'chromeTabId' | 'launchUrl' | 'liveAtClose'>;
export type SyncGroup = Omit<GroupRec, 'chromeGroupId'>;
export type SyncWindow = Omit<
  WindowRec,
  'chromeWindowId' | 'provisional' | 'openAtShutdown' | 'bounds' | 'tabs' | 'groups'
> & { tabs: SyncTab[]; groups: SyncGroup[] };

export function toSyncWindow(rec: WindowRec): SyncWindow {
  // Rebuilt field by field (not delete-from-copy) so a new machine-local field can't leak by default.
  const out: SyncWindow = {
    id: rec.id,
    state: rec.state,
    lastLiveAt: rec.lastLiveAt,
    originInstallId: rec.originInstallId,
    modifiedAt: rec.modifiedAt,
    tabs: rec.tabs.map((t) => {
      const tab: SyncTab = { id: t.id, url: t.url, title: t.title, modifiedAt: t.modifiedAt };
      if (t.groupId !== undefined) tab.groupId = t.groupId;
      return tab;
    }),
    groups: rec.groups.map((g) => ({
      id: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      modifiedAt: g.modifiedAt,
    })),
  };
  if (rec.name !== undefined) out.name = rec.name;
  if (rec.closedAt !== undefined) out.closedAt = rec.closedAt;
  return out;
}
