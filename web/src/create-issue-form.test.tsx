import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateIssueForm, submitCreateFormOnShortcut, submitsIssueForm, type IssueFormKeydown } from './App';
import { ISSUE_FORM_HINT, ISSUE_FORM_SUBMIT_HINT } from './ui-state';

// The web suite runs in a node environment, so nothing here can dispatch a real
// keystroke: no browser inserts the newline for a plain Enter, no native
// `required` validation runs, and the browser's own constraint message cannot
// be produced. What is provable is the wiring — the description's keydown is
// the named handler, and driving that handler with a fake event and a fake form
// shows which keystrokes reach the form's own `requestSubmit()`.
const markup = renderToStaticMarkup(<CreateIssueForm onSubmit={() => {}} />);

/** The rendered form element, so the description's props can be inspected. */
function renderedForm(): ReactElement<{ children: ReactNode }> {
  const form = CreateIssueForm({ onSubmit: () => {} });
  if (!isValidElement<{ children: ReactNode }>(form)) throw new Error('the create form did not render an element');
  return form;
}

function descriptionKeydown(): (event: IssueFormKeydown) => void {
  const form = renderedForm();
  if (typeof form.type !== 'string' || form.type !== 'form') throw new Error('the create form is not a <form>');
  const children = form.props.children as ReactNode[];
  const description = children.find((child) => isValidElement<{ onKeyDown?: unknown }>(child) && child.type === 'textarea') as ReactElement<{ onKeyDown?: unknown }> | undefined;
  const onKeyDown = description?.props.onKeyDown;
  if (typeof onKeyDown !== 'function') throw new Error('the description has no keydown handler');
  if (onKeyDown !== submitCreateFormOnShortcut) throw new Error('the description does not use the named shortcut handler');
  return onKeyDown as (event: IssueFormKeydown) => void;
}

/** A fake keydown whose effects are counted, so a double submit would show. */
function fakeKeydown(
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat', boolean>> = {},
) {
  const state = { preventDefault: 0, requestSubmit: 0 };
  const event: IssueFormKeydown = {
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
  descriptionKeydown()(event);
  return state;
}

describe('create issue form', () => {
  it('is one form with a required title, a description and a single submit control', () => {
    expect(markup.match(/<form/g)).toHaveLength(1);
    const title = markup.match(/<input[^>]*>/)?.[0] ?? '';
    expect(title).toContain('name="title"');
    expect(title).toContain('required');
    expect(markup).toContain('<textarea');
    expect(markup).toContain('name="body"');
    expect(markup.match(/<button[^>]*type="submit"[^>]*>Create issue<\/button>/g)).toHaveLength(1);
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it('describes the description and advertises the shortcut in the form copy', () => {
    expect(markup).toContain(ISSUE_FORM_HINT);
    expect(markup).toContain(ISSUE_FORM_SUBMIT_HINT);
  });
});

describe('create-issue keyboard shortcut', () => {
  it('routes Ctrl+Enter in the description to the form once, through its own requestSubmit', () => {
    const { state, event } = fakeKeydown('Enter', { ctrlKey: true });
    expect(submitsIssueForm(event)).toBe(true);

    descriptionKeydown()(event);
    expect(state.requestSubmit).toBe(1);
    expect(state.preventDefault).toBe(1);
  });

  it('leaves plain Enter alone so the newline is not swallowed', () => {
    expect(press('Enter')).toEqual({ preventDefault: 0, requestSubmit: 0 });
  });

  it('claims no other key or modifier combination as the submit shortcut', () => {
    for (const key of ['Tab', ' ', 'a']) expect(press(key, { ctrlKey: true })).toEqual({ preventDefault: 0, requestSubmit: 0 });
    for (const modifiers of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(press('Enter', { ctrlKey: true, ...modifiers })).toEqual({ preventDefault: 0, requestSubmit: 0 });
    }
  });

  it('ignores the auto-repeat of a held Ctrl+Enter instead of submitting again', () => {
    const { state, event } = fakeKeydown('Enter', { ctrlKey: true, repeat: true });
    expect(submitsIssueForm(event)).toBe(false);

    descriptionKeydown()(event);
    expect(state.requestSubmit).toBe(0);
    expect(state.preventDefault).toBe(0);
  });
});
