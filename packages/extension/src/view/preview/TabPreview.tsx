import { useEffect, useState } from 'react';
import type { TabNode } from '../../model/types';
import { describeNoPreview, type OutcomeDescription } from '../../shared/captureOutcomes';
import { isCapturableUrl, wantsOnDemandCapture } from '../../shared/previewPolicy';
import { getPreview, type Preview } from '../../shared/previewStore';
import { faviconUrl } from '../chrome/favicon';
import {
  isTabLoaded,
  latestCaptureOutcome,
  refreshTab,
  requestTabCapture,
  tabCaptureOutcome,
  watchTabLoaded,
} from '../chrome/captureOutcome';
import { backgroundTabNote } from '../refresh/refreshRun';
import { relativeTime } from './relativeTime';

interface Props {
  tab: TabNode;
  /** Bumped when previews were cleared or refreshed, so the panel looks its tab up again. */
  previewEpoch: number;
}

interface Loaded {
  url: string; // the tab URL this lookup was for
  image: { src: string; width: number; height: number } | null;
  note: OutcomeDescription | null; // why there's no image, when there isn't one
  // An on-demand capture is in flight: first loading the page (if it wasn't loaded), then capturing.
  capturing: 'loading' | 'capturing' | false;
}

/**
 * The preview panel's body for one tab: its last screenshot (if any), title, URL, last viewed.
 * With no screenshot, or only an old one, of a tab that is on screen in its window, it asks the
 * service worker to capture it now (without the debugger, which a hover must never attach) and
 * swaps the new shot in when it lands.
 */
export function TabPreview({ tab, previewEpoch }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { tabId, url, windowId, discarded, active } = tab;

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    let unwatch: (() => void) | undefined;
    const done = (
      image: Loaded['image'],
      note: Loaded['note'],
      capturing: Loaded['capturing'] = false,
    ) => {
      if (!cancelled) setLoaded({ url, image, note, capturing });
    };
    const lookup = () => getPreview(url).catch(() => undefined);
    const toImage = (p: Preview) => {
      const src = URL.createObjectURL(p.image);
      objectUrls.push(src);
      return { src, width: p.width, height: p.height };
    };
    // No preview is not an error; show the text-only details with the latest capture outcome. A
    // hibernated tab has no Chrome tab, so no outcome to read and nothing to capture.
    // A background tab is never captured from a hover (see wantsOnDemandCapture): unless a
    // Refresh run recorded something for it, say how to get its preview, by the same rule Capture
    // missing picks tabs with (backgroundTabNote, from Chrome's live tab). (A page Chrome won't
    // capture at all keeps the usual note.)
    const noPreview = async () => {
      if (tabId === undefined || windowId === undefined) return done(null, null);
      const o =
        active || !isCapturableUrl(url)
          ? await latestCaptureOutcome(windowId, tabId).catch(() => undefined)
          : ((await tabCaptureOutcome(tabId).catch(() => undefined)) ?? {
              at: Date.now(),
              outcome: backgroundTabNote(await refreshTab(tabId).catch(() => undefined)),
            });
      done(null, describeNoPreview(o));
    };

    void (async () => {
      const p = await lookup();
      if (cancelled) return;
      const image = p ? toImage(p) : null;
      if (tabId === undefined || !wantsOnDemandCapture({ url, discarded, active }, p?.capturedAt)) {
        if (image) done(image, null);
        else await noPreview();
        return;
      }
      const loadedAlready = await isTabLoaded(tabId).catch(() => true);
      if (cancelled) return;
      done(image, null, loadedAlready ? 'capturing' : 'loading');
      if (!loadedAlready) {
        unwatch = watchTabLoaded(tabId, () => {
          if (!cancelled)
            setLoaded((l) => (l?.capturing === 'loading' ? { ...l, capturing: 'capturing' } : l));
        });
      }
      await requestTabCapture(tabId, false).catch(() => undefined);
      unwatch?.();
      if (cancelled) return;
      const fresh = await lookup();
      if (cancelled) return;
      if (fresh && fresh.capturedAt !== p?.capturedAt) done(toImage(fresh), null);
      else if (image) done(image, null);
      else await noPreview();
    })();
    return () => {
      cancelled = true;
      unwatch?.();
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [tabId, url, windowId, discarded, active, previewEpoch]);

  const ready = loaded?.url === tab.url;
  const image = ready ? loaded.image : null;
  const note = ready ? loaded.note : null;
  const capturing = ready ? loaded.capturing : false;

  return (
    <>
      <PreviewImage ready={ready} image={image} capturing={capturing} note={note} tab={tab} />
      <div className="preview-text">
        <div className="preview-title">{tab.title}</div>
        <div className="preview-url">{tab.url}</div>
        {tab.lastAccessed !== undefined && (
          <div className="preview-meta">Last viewed {relativeTime(tab.lastAccessed)}</div>
        )}
      </div>
    </>
  );
}

interface PreviewProps {
  ready: boolean;
  image: Loaded['image'];
  capturing: Loaded['capturing'];
  note: OutcomeDescription | null;
  tab: TabNode;
}

/**
 * The panel's preview area, which takes whatever height the panel leaves above the details, the
 * same in every state (mid-lookup, waiting on an on-demand capture, a screenshot, or no preview),
 * so the details never jump when a screenshot lands. A screenshot crossfades in (CSS animation on
 * mount); loading states show a CSS-only spinner that goes static under prefers-reduced-motion;
 * no-preview/failed/skipped shows the tab's favicon, muted, plus the outcome text.
 */
function PreviewImage({ ready, image, capturing, note, tab }: PreviewProps) {
  if (image && !capturing) {
    return (
      <div className="preview-image">
        <img key={image.src} className="preview-shot" src={image.src} alt="" />
      </div>
    );
  }
  if (!ready || capturing) {
    const label =
      capturing === 'loading'
        ? 'Loading page…'
        : capturing === 'capturing'
          ? 'Capturing preview…'
          : null;
    return (
      <div className="preview-image preview-image-loading">
        <span className="preview-spinner" aria-hidden="true" />
        {label && <span className="preview-image-status">{label}</span>}
      </div>
    );
  }
  return (
    <div className="preview-image preview-image-empty">
      {tab.url && <img className="preview-image-favicon" src={faviconUrl(tab.url)} alt="" />}
      {note && (
        <span className="preview-image-status" title={note.detail}>
          {note.text}
        </span>
      )}
    </div>
  );
}
