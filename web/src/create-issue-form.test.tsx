import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateIssueForm, ISSUE_FORM_HINT, ISSUE_FORM_SUBMIT_HINT, submitsIssueForm } from './App';

// Rendering the component is the whole point: the web suite runs in a node
// environment, so the keystroke, the native `required` message and the newline
// insertion cannot be dispatched here. What the markup does prove is that the
// browser has one form, one required title, one description field and exactly
// one submit control, so the keydown handler has a single submit path to take.
const markup = renderToStaticMarkup(
  <CreateIssueForm onSubmit={() => {}} titleRef={createRef<HTMLInputElement>()} />,
);

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

  it('describes the description and the shortcut in the form copy', () => {
    expect(markup).toContain(ISSUE_FORM_HINT);
    expect(markup).toContain(ISSUE_FORM_SUBMIT_HINT);
  });
});

function key(name: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) {
  return { key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

describe('create-issue keyboard shortcut', () => {
  it('submits the form on Ctrl+Enter in the description', () => {
    expect(submitsIssueForm(key('Enter', { ctrlKey: true }))).toBe(true);
  });

  it('leaves plain Enter alone so it keeps inserting a newline instead of submitting', () => {
    expect(submitsIssueForm(key('Enter'))).toBe(false);
  });

  it('claims no other key or modifier combination as the submit shortcut', () => {
    expect(submitsIssueForm(key('Tab'))).toBe(false);
    expect(submitsIssueForm(key(' '))).toBe(false);
    expect(submitsIssueForm(key('a', { ctrlKey: true }))).toBe(false);
    expect(submitsIssueForm(key('Enter', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(submitsIssueForm(key('Enter', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(submitsIssueForm(key('Enter', { metaKey: true }))).toBe(false);
  });

  it('advertises the shortcut next to the form copy instead of hiding it', () => {
    expect(ISSUE_FORM_SUBMIT_HINT).toContain('Ctrl+Enter');
    expect(ISSUE_FORM_HINT).not.toContain('Ctrl');
  });
});
