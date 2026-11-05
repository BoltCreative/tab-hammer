import { describe, expect, it } from 'vitest';
import { createHistorySuppression } from '../historySuppression';

describe('history suppression', () => {
  it('allows everything until history is removed', () => {
    expect(createHistorySuppression().allows('https://a.test/')).toBe(true);
  });

  it('blocks a removed page (any fragment) until it is visited again', () => {
    const s = createHistorySuppression();
    s.removed(['https://a.test/page#x']);
    expect(s.allows('https://a.test/page')).toBe(false);
    expect(s.allows('https://a.test/page#y')).toBe(false);
    expect(s.allows('https://b.test/')).toBe(true);
    s.visited('https://a.test/page');
    expect(s.allows('https://a.test/page')).toBe(true);
  });

  it('after the whole history is cleared, allows only pages visited since', () => {
    const s = createHistorySuppression();
    s.visited('https://old.test/');
    s.removed('all');
    expect(s.allows('https://old.test/')).toBe(false);
    s.visited('https://new.test/');
    expect(s.allows('https://new.test/')).toBe(true);
    s.removed(['https://new.test/']);
    expect(s.allows('https://new.test/')).toBe(false);
  });
});
