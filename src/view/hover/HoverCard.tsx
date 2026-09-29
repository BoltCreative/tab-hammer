import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TabNode } from '../../model/types';
import { getPreview } from '../../shared/previewStore';
import { relativeTime } from './relativeTime';
import { placeCardTop } from './placeCard';

interface Props {
  tab: TabNode;
  row: { top: number; bottom: number };
}

interface Loaded {
  url: string; // the tab URL this lookup was for
  image: { src: string; width: number; height: number } | null;
}

/** Floating preview of a hovered tab: its last screenshot (if any), title, URL, last viewed. */
export function HoverCard({ tab, row }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const done = (image: Loaded['image']) => {
      if (!cancelled) setLoaded({ url: tab.url, image });
    };
    getPreview(tab.url)
      .then((p) => {
        if (cancelled || !p) return done(null);
        objectUrl = URL.createObjectURL(p.image);
        done({ src: objectUrl, width: p.width, height: p.height });
      })
      .catch(() => done(null)); // no preview is not an error; show the text-only card
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [tab.url]);

  const ready = loaded?.url === tab.url;
  const image = ready ? loaded.image : null;

  // Place it once its height is known. The image's width/height attributes fix its aspect ratio
  // before it loads, so this measurement is final.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.top = `${placeCardTop(row, el.offsetHeight, window.innerHeight)}px`;
    el.style.visibility = 'visible';
  }, [row, ready, image]);

  // Wait for the store lookup so the card doesn't open text-only and then grow.
  if (!ready) return null;
  return (
    <div ref={ref} className="hover-card" role="tooltip" data-testid="hover-card">
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
      </div>
    </div>
  );
}
