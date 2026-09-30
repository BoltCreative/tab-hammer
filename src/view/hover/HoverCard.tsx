import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TabNode } from '../../model/types';
import { describeNoPreview, type OutcomeDescription } from '../../shared/captureOutcomes';
import { wantsOnDemandCapture } from '../../shared/previewPolicy';
import { getPreview, type Preview } from '../../shared/previewStore';
import { faviconUrl } from '../chrome/favicon';
import {
  isTabLoaded,
  latestCaptureOutcome,
  requestTabCapture,
  watchTabLoaded,
} from '../chrome/captureOutcome';
import { relativeTime } from './relativeTime';
import { HOVER_CARD_ID } from './useHoverCard';
import { placeCardTop } from './placeCard';

interface Props {
  tab: TabNode;
  row: { top: number; bottom: number };
  /** The scrolling outline list; the card stays inside it, never over the fixed header. */
  list: RefObject<HTMLElement | null>;
  /** Bumped when every preview was cleared, so the card looks its tab up again. */
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
 * Floating preview of a hovered tab: its last screenshot (if any), title, URL, last viewed. With
 * no screenshot, or only an old one, it asks the service worker to capture the tab now and swaps
 * the new shot in when it lands.
 */
export function HoverCard({ tab, row, list, previewEpoch }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { tabId, url, windowId, discarded } = tab;

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
    // No preview is not an error; show the text-only card with the latest capture outcome.
    const noPreview = () =>
      latestCaptureOutcome(windowId, tabId)
        .catch(() => undefined)
        .then((o) => done(null, describeNoPreview(o)));

    void (async () => {
      const p = await lookup();
      if (cancelled) return;
      const image = p ? toImage(p) : null;
      if (!wantsOnDemandCapture({ url, discarded }, p?.capturedAt, Date.now())) {
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
      await requestTabCapture(tabId).catch(() => undefined);
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
  }, [tabId, url, windowId, discarded, previewEpoch]);

  const ready = loaded?.url === tab.url;
  const image = ready ? loaded.image : null;
  const note = ready ? loaded.note : null;
  const capturing = ready ? loaded.capturing : false;

  // The preview area is a fixed-aspect box in every state, so the card's height never depends on
  // which state (pending lookup, loading/capturing, image, or empty) is showing. Placement only
  // needs to react to the hovered row or the scroll container moving, not to preview state.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bounds = list.current?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    el.style.top = `${placeCardTop(row, el.offsetHeight, bounds)}px`;
    el.style.visibility = 'visible';
  }, [row, list]);

  return (
    <div
      ref={ref}
      id={HOVER_CARD_ID}
      className="hover-card"
      role="tooltip"
      data-testid="hover-card"
    >
      <HoverCardPreview ready={ready} image={image} capturing={capturing} note={note} tab={tab} />
      <div className="hover-card-text">
        <div className="hover-card-title">{tab.title}</div>
        <div className="hover-card-url">{tab.url}</div>
        {tab.lastAccessed !== undefined && (
          <div className="hover-card-meta">Last viewed {relativeTime(tab.lastAccessed)}</div>
        )}
      </div>
    </div>
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
 * The card's always-present, fixed-aspect (16:10) preview area, so the card is the same height
 * whether it's mid-lookup, waiting on an on-demand capture, showing a screenshot, or showing no
 * preview at all. A screenshot crossfades in (CSS animation on mount); loading states show a
 * CSS-only spinner that goes static under prefers-reduced-motion; no-preview/failed/skipped shows
 * the tab's favicon, muted, plus the outcome text.
 */
function HoverCardPreview({ ready, image, capturing, note, tab }: PreviewProps) {
  if (image && !capturing) {
    return (
      <div className="hover-card-preview">
        <img key={image.src} className="hover-card-shot" src={image.src} alt="" />
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
      <div className="hover-card-preview hover-card-preview-loading">
        <span className="hover-card-spinner" aria-hidden="true" />
        {label && <span className="hover-card-preview-status">{label}</span>}
      </div>
    );
  }
  return (
    <div className="hover-card-preview hover-card-preview-empty">
      {tab.url && <img className="hover-card-preview-favicon" src={faviconUrl(tab.url)} alt="" />}
      {note && (
        <span className="hover-card-preview-status" title={note.detail}>
          {note.text}
        </span>
      )}
    </div>
  );
}
