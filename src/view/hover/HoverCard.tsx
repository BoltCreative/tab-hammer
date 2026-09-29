import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TabNode } from '../../model/types';
import { describeNoPreview } from '../../shared/captureOutcomes';
import { wantsOnDemandCapture } from '../../shared/previewPolicy';
import { getPreview, type Preview } from '../../shared/previewStore';
import { latestCaptureOutcome, requestTabCapture } from '../chrome/captureOutcome';
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
  note: string | null; // why there's no image, when there isn't one
  capturing: boolean; // an on-demand capture is in flight
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
    const done = (image: Loaded['image'], note: string | null, capturing = false) => {
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
      done(image, null, true);
      await requestTabCapture(tabId).catch(() => undefined);
      if (cancelled) return;
      const fresh = await lookup();
      if (cancelled) return;
      if (fresh && fresh.capturedAt !== p?.capturedAt) done(toImage(fresh), null);
      else if (image) done(image, null);
      else await noPreview();
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [tabId, url, windowId, discarded, previewEpoch]);

  const ready = loaded?.url === tab.url;
  const image = ready ? loaded.image : null;
  const note = ready ? loaded.note : null;
  const capturing = ready && loaded.capturing;

  // Place it once its height is known. The image's width/height attributes fix its aspect ratio
  // before it loads, so this measurement is final.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bounds = list.current?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    el.style.top = `${placeCardTop(row, el.offsetHeight, bounds)}px`;
    el.style.visibility = 'visible';
  }, [row, ready, image, list]);

  // Wait for the store lookup so the card doesn't open text-only and then grow.
  if (!ready) return null;
  return (
    <div
      ref={ref}
      id={HOVER_CARD_ID}
      className="hover-card"
      role="tooltip"
      data-testid="hover-card"
    >
      {image && (
        <img
          className="hover-card-shot"
          src={image.src}
          width={image.width}
          height={image.height}
          alt=""
        />
      )}
      <div className="hover-card-text">
        <div className="hover-card-title">{tab.title}</div>
        <div className="hover-card-url">{tab.url}</div>
        {tab.lastAccessed !== undefined && (
          <div className="hover-card-meta">Last viewed {relativeTime(tab.lastAccessed)}</div>
        )}
        {capturing && <div className="hover-card-note">Capturing preview…</div>}
        {note && (
          <div className="hover-card-note" title={note}>
            {note}
          </div>
        )}
      </div>
    </div>
  );
}
