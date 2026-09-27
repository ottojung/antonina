import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

interface Rule {
  selector: string;
  declarations: Record<string, string>;
  media: string | null;
}

/**
 * The height/overflow chain of the board shell, read out of the stylesheet.
 *
 * What this can and cannot prove, stated plainly: this suite runs in a node
 * environment with no layout engine, so nothing here measures a box. A
 * computed `scrollHeight`, or any other claim about how tall the document
 * really is, would be an assertion about nothing. What is provable is the
 * structural invariant the layout depends on — that the shell is bounded to the
 * viewport and clips, that the workspace hands its remaining height to a pinned
 * row, that each pane is its own scroll container, and that no view reverts
 * that workspace to a content-sized box. Those are the declarations a later
 * edit has to break for the blank region under the board to come back, so a
 * regression fails here rather than in a browser.
 */
function parse(source: string): Rule[] {
  const rules: Rule[] = [];
  const stack: string[] = [];
  let prelude = '';
  for (const token of source.replace(/\/\*[\s\S]*?\*\//g, '').match(/[{}]|[^{}]+/g) ?? []) {
    if (token === '{') { stack.push(prelude.trim()); prelude = ''; continue; }
    if (token === '}') { stack.pop(); continue; }
    // Outside any block, text opens an at-rule; inside one, it is a selector
    // until the rule's own block opens, and declarations only after that.
    if (stack.length === 0 || stack.at(-1)?.startsWith('@')) { prelude += token; continue; }
    const media = stack.length > 1 && stack[0].startsWith('@media') ? stack[0] : null;
    if (stack.some((at) => at.startsWith('@') && at !== stack[0])) continue;
    const declarations: Record<string, string> = {};
    for (const declaration of token.split(';')) {
      const separator = declaration.indexOf(':');
      if (separator === -1) continue;
      declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim();
    }
    rules.push({ selector: stack.at(-1) ?? '', declarations, media });
  }
  return rules;
}

const rules = parse(css);
/** The declarations a selector declares outside any media query, last one winning. */
function desktop(selector: string): Record<string, string> {
  const found = rules.filter((rule) => !rule.media && rule.selector === selector);
  expect(found.length, `no desktop rule for ${selector}`).toBeGreaterThan(0);
  return Object.assign({}, ...found.map((rule) => rule.declarations));
}
/** The declarations a selector declares inside the phone-width media query. */
function mobile(selector: string): Record<string, string> {
  const found = rules.filter((rule) => rule.media?.includes('max-width: 760px') && rule.selector === selector);
  expect(found.length, `no phone-width rule for ${selector}`).toBeGreaterThan(0);
  return Object.assign({}, ...found.map((rule) => rule.declarations));
}

describe('board shell height chain', () => {
  it('bounds the shell to the viewport and clips it', () => {
    expect(desktop('.app-shell')).toMatchObject({ height: '100vh', overflow: 'hidden' });
  });

  it('hands the workspace the remaining height on a pinned row', () => {
    // An auto row is sized by its content, so a long list would grow the grid
    // past the viewport however the panes were styled; `min-height: 0` is what
    // lets the panes shrink to that row instead of growing to their content.
    expect(desktop('.workspace')).toMatchObject({ display: 'grid', 'flex': '1', 'min-height': '0', 'grid-template-rows': 'minmax(0, 1fr)' });
  });

  it('leaves each pane its own scroll container', () => {
    for (const pane of ['.issue-pane', '.thread']) {
      expect(desktop(pane), pane).toMatchObject({ 'min-height': '0', 'overflow-y': 'auto' });
    }
  });

  it('keeps the fixed-height chrome out of the panes height', () => {
    for (const fixed of ['.topbar', '.notice']) expect(desktop(fixed), fixed).toMatchObject({ flex: 'none' });
  });

  it('does not let a single-column view size the workspace by its content', () => {
    // A view that drops out of the grid loses the pinned row, and a
    // content-sized workspace is exactly what puts a blank region under the
    // board. A tab that is not in this stylesheet yet has to keep the grid.
    for (const selector of ['.workspace.resources-view', '.workspace.feed-view', '.workspace.targets-view']) {
      const declarations = desktop(selector);
      expect(declarations.display, selector).toBe('grid');
      expect(declarations['grid-template-columns'], selector).toBe('minmax(0, 1fr)');
    }
  });

  it('returns to a single scrolling document on a phone', () => {
    expect(mobile('.app-shell')).toMatchObject({ height: 'auto', overflow: 'visible' });
    expect(mobile('.workspace')).toMatchObject({ display: 'block' });
    // Each desktop view rule is (0,2,0) and so beats the phone-wide
    // `.workspace { display: block }` at its own (0,1,0). The phone-width block
    // therefore has to name every single-column view itself to undo it; a new
    // view that adds the desktop rule without adding this one is silently a
    // clipped grid on a phone, which is the trap issue 51 pinned for resources.
    for (const selector of ['.workspace.resources-view', '.workspace.feed-view', '.workspace.targets-view']) {
      expect(mobile(selector), selector).toMatchObject({ display: 'block' });
    }
    expect(mobile('.issue-pane')).toMatchObject({ 'overflow-y': 'visible' });
    expect(mobile('.thread')).toMatchObject({ 'overflow-y': 'visible' });
  });
});
