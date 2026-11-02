import type { GroupNode, TabNode, WindowNode } from './types';

/** The query's words, lowercased; empty when the query is blank. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(text: string, terms: string[]): boolean {
  const t = text.toLowerCase();
  return terms.every((term) => t.includes(term));
}

const tabMatches = (t: TabNode, terms: string[]) => matches(`${t.title} ${t.url}`, terms);

/**
 * The outline narrowed to tabs whose title or URL contains every word of the query, keeping each
 * match's window and group around it so it reads in context. A group whose own title matches is
 * kept whole. Windows and groups left with nothing to show are dropped. A blank query returns
 * `tree` itself.
 */
export function filterTree(tree: WindowNode[], query: string): WindowNode[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return tree;
  const out: WindowNode[] = [];
  for (const w of tree) {
    const children: (GroupNode | TabNode)[] = [];
    for (const c of w.children) {
      if (c.kind === 'tab') {
        if (tabMatches(c, terms)) children.push(c);
      } else if (matches(c.title, terms)) {
        children.push(c);
      } else {
        const tabs = c.tabs.filter((t) => tabMatches(t, terms));
        if (tabs.length > 0) children.push({ ...c, tabs });
      }
    }
    if (children.length > 0) out.push({ ...w, children });
  }
  return out;
}

/** How many tabs a (filtered) outline shows. */
export function countTabs(tree: WindowNode[]): number {
  let n = 0;
  for (const w of tree) for (const c of w.children) n += c.kind === 'group' ? c.tabs.length : 1;
  return n;
}
