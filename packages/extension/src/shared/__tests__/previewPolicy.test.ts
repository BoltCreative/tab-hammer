import { describe, expect, it } from 'vitest';
import {
  isCapturableUrl,
  pickEvictions,
  previewKey,
  referencedKeys,
  wantsOnDemandCapture,
} from '../previewPolicy';

describe('previewKey', () => {
  it('drops the fragment and keeps the query', () => {
    expect(previewKey('https://a.test/p?q=1#section')).toBe('https://a.test/p?q=1');
    expect(previewKey('https://a.test/p?q=1')).toBe('https://a.test/p?q=1');
    expect(previewKey('https://a.test/p#')).toBe('https://a.test/p');
  });
});

describe('referencedKeys', () => {
  const w = (...urls: string[]) => ({ tabs: urls.map((url) => ({ url })) });

  it('takes every tab of every record, ignoring fragments', () => {
    // A live window, a hibernated one, and a trash entry look the same here: records with tabs.
    const keys = referencedKeys(
      [w('https://a.test/p#top', 'https://b.test/'), w('https://c.test/?q=1#x'), w()],
      [],
    );
    expect([...keys].sort()).toEqual([
      'https://a.test/p',
      'https://b.test/',
      'https://c.test/?q=1',
    ]);
  });

  it('counts a URL open in several windows once, and adds the pages Chrome has open', () => {
    const keys = referencedKeys(
      [w('https://a.test/'), w('https://a.test/#2')],
      ['https://new.test/#h'],
    );
    expect([...keys].sort()).toEqual(['https://a.test/', 'https://new.test/']);
  });
});

describe('pickEvictions', () => {
  const since = 1000;
  const e = (key: string, capturedAt = 10) => ({ key, capturedAt });
  const refs = (...keys: string[]) => new Set(keys);

  it('keeps referenced previews however old they are, and deletes the rest', () => {
    const entries = [e('used', -1e12), e('gone'), e('also-used')];
    expect(pickEvictions(entries, refs('used', 'also-used'), since)).toEqual(['gone']);
  });

  it('keeps a preview saved at or after the read, even if nothing references it yet', () => {
    const entries = [e('just-saved', since), e('later', since + 5), e('before', since - 1)];
    expect(pickEvictions(entries, refs(), since)).toEqual(['before']);
  });

  it('has no size cap: thousands of referenced previews all stay', () => {
    const entries = Array.from({ length: 5000 }, (_, i) => e(`k${i}`));
    expect(pickEvictions(entries, new Set(entries.map((x) => x.key)), since)).toEqual([]);
  });

  it('deletes everything unreferenced when the outline uses nothing', () => {
    expect(pickEvictions([e('a'), e('b')], refs(), since)).toEqual(['a', 'b']);
  });
});

describe('isCapturableUrl', () => {
  it.each([
    'https://example.com/a',
    'http://localhost:3000/',
    'file:///Users/me/notes.html',
    'https://chrome.google.com/search',
  ])('allows %s', (url) => expect(isCapturableUrl(url)).toBe(true));

  it.each([
    undefined,
    '',
    'not a url',
    'chrome://settings',
    'chrome-extension://abc/src/view/index.html',
    'chrome-untrusted://new-tab-page/',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'view-source:https://example.com',
    'data:text/html,<title>x</title>',
    'https://chromewebstore.google.com/detail/abc',
    'https://chrome.google.com/webstore/detail/abc',
  ])('skips %s', (url) => expect(isCapturableUrl(url)).toBe(false));
});

describe('wantsOnDemandCapture', () => {
  const tab = { url: 'https://example.com/a', discarded: false, active: true };
  it.each([
    ['no preview', tab, undefined, true],
    ['a preview, however old (previews never go stale)', tab, 1, false],
    [
      'a background tab (only a Refresh run may attach the debugger)',
      { ...tab, active: false },
      undefined,
      false,
    ],
    ['a discarded tab (attaching would reload it)', { ...tab, discarded: true }, undefined, false],
    ['a page Chrome will not capture', { ...tab, url: 'chrome://settings' }, undefined, false],
  ])('%s', (_name, t, capturedAt, want) => {
    expect(wantsOnDemandCapture(t, capturedAt)).toBe(want);
  });
});
