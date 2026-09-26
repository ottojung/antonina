import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommentComposer, submitFormOnShortcut, submitsFormOnShortcut, type ShortcutKeydown } from './App';
import { COMPOSER_SUBMIT_HINT } from './ui-state';

// The web suite runs in a node environment, so nothing here can dispatch a real
// keystroke: no browser inserts the newline for a plain Enter, no native
// `required` validation runs, and the browser's own constraint message cannot
// be produced. What is provable is the wiring — the composer's keydown is the
// named handler, the textarea and the submit button share one form and one
// `onSubmit`, and driving the handler with a fake event and a fake form shows
// which keystrokes reach that form's own `requestSubmit()`.
const comment = vi.fn();
const markup = renderToStaticMarkup(<CommentComposer displayName="Lubko" comment={comment} />);

/** The rendered composer form, so the textarea's props can be inspected. */
function renderedComposer(): ReactElement<{ children: ReactNode }> {
  const form = CommentComposer({ displayName: 'Lubko', comment });
  if (!isValidElement<{ children: ReactNode }>(form)) throw new Error('the composer did not render an element');
  return form;
}

function composerKeydown(): (event: ShortcutKeydown) => void {
  const form = renderedComposer();
  if (typeof form.type !== 'string' || form.type !== 'form') throw new Error('the composer is not a <form>');
  const children = form.props.children as ReactNode[];
  const textarea = children.find((child) => isValidElement<{ onKeyDown?: unknown }>(child) && child.type === 'textarea') as ReactElement<{ onKeyDown?: unknown }> | undefined;
  const onKeyDown = textarea?.props.onKeyDown;
  if (typeof onKeyDown !== 'function') throw new Error('the comment body has no keydown handler');
  if (onKeyDown !== submitFormOnShortcut) throw new Error('the comment body does not use the named shortcut handler');
  return onKeyDown as (event: ShortcutKeydown) => void;
}

/** A fake keydown whose effects are counted, so a double submit would show. */
function fakeKeydown(
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat', boolean>> = {},
) {
  const state = { preventDefault: 0, requestSubmit: 0 };
  const event: ShortcutKeydown = {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...modifiers,
    preventDefault: () => { state.preventDefault += 1; },
    currentTarget: { form: { requestSubmit: () => { state.requestSubmit += 1; } } },
  };
  return { state, event };
}

function press(key: string, modifiers?: Parameters<typeof fakeKeydown>[1]) {
  const { state, event } = fakeKeydown(key, modifiers);
  composerKeydown()(event);
  return state;
}

describe('comment composer', () => {
  it('is one form whose textarea and Post message button share a single submit path', () => {
    expect(markup.match(/<form/g)).toHaveLength(1);
    const textarea = markup.match(/<textarea[^>]*>/)?.[0] ?? '';
    expect(textarea).toContain('name="body"');
    // `required` is what makes the shortcut and the button agree: both go
    // through native validation before `onSubmit` sees anything.
    expect(textarea).toContain('required');
    expect(markup.match(/<button[^>]*type="submit"[^>]*>Post message<\/button>/g)).toHaveLength(1);
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it('names the shortcut next to the button it stands in for', () => {
    expect(markup).toContain(COMPOSER_SUBMIT_HINT);
    expect(COMPOSER_SUBMIT_HINT).toMatch(/Ctrl\+Enter/);
    expect(COMPOSER_SUBMIT_HINT).toMatch(/Cmd\+Enter/);
  });
});

describe('comment composer keyboard shortcut', () => {
  it('routes Ctrl+Enter to the composer form once, through the button\'s own requestSubmit', () => {
    const { state, event } = fakeKeydown('Enter', { ctrlKey: true });
    expect(submitsFormOnShortcut(event)).toBe(true);

    composerKeydown()(event);
    expect(state.requestSubmit).toBe(1);
    expect(state.preventDefault).toBe(1);
  });

  it('routes Meta+Enter down the same single path', () => {
    const { state, event } = fakeKeydown('Enter', { metaKey: true });
    expect(submitsFormOnShortcut(event)).toBe(true);

    composerKeydown()(event);
    expect(state.requestSubmit).toBe(1);
    expect(state.preventDefault).toBe(1);
  });

  it('leaves plain Enter alone so the newline is not swallowed', () => {
    expect(press('Enter')).toEqual({ preventDefault: 0, requestSubmit: 0 });
  });

  it('claims no other key or modifier combination, and never both at once', () => {
    for (const key of ['Tab', ' ', 'a']) expect(press(key, { ctrlKey: true })).toEqual({ preventDefault: 0, requestSubmit: 0 });
    for (const modifiers of [{ shiftKey: true }, { altKey: true }]) {
      expect(press('Enter', { ctrlKey: true, ...modifiers })).toEqual({ preventDefault: 0, requestSubmit: 0 });
    }
    // Ctrl+Meta+Enter is one gesture; claiming it twice is how one press could
    // post two messages.
    expect(press('Enter', { ctrlKey: true, metaKey: true })).toEqual({ preventDefault: 0, requestSubmit: 0 });
  });

  it('ignores the auto-repeat of a held shortcut instead of posting a second message', () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const { state, event } = fakeKeydown('Enter', { ...modifiers, repeat: true });
      expect(submitsFormOnShortcut(event)).toBe(false);

      composerKeydown()(event);
      expect(state.requestSubmit).toBe(0);
      expect(state.preventDefault).toBe(0);
    }
  });

  it('does nothing when the textarea is somehow not inside a form', () => {
    // `requestSubmit` is reached through the owning form, so a detached
    // textarea must not throw a TypeError out of a keydown handler.
    const { state, event } = fakeKeydown('Enter', { ctrlKey: true });
    const orphan: ShortcutKeydown = { ...event, currentTarget: { form: null } };

    composerKeydown()(orphan);
    expect(state.requestSubmit).toBe(0);
    expect(state.preventDefault).toBe(1);
  });
});
