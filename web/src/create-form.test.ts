import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The web suite runs in a node environment with no DOM, so the parts of the
// create form that are the browser's own behavior cannot be dispatched here.
// They are asserted structurally against the component source instead: these
// are the exact properties that make Ctrl+Enter behave like the button.
const source = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
const createForm = source.match(/<form className="create-form"[\s\S]*?<\/form>/)?.[0] ?? '';

describe('create issue form', () => {
  it('keeps the native required title and the submit button as the one submit path', () => {
    expect(createForm).toContain('required');
    expect(createForm).toMatch(/<input[^>]*name="title"[^>]*required/);
    expect(createForm).toContain('<button type="submit">Create issue</button>');
    expect(createForm).toMatch(/<form className="create-form" onSubmit=\{createIssue\}>/);
  });

  it('routes Ctrl+Enter through the form\'s own submit request, so validation and submission stay single-path', () => {
    expect(createForm).toMatch(/onKeyDown=\{\(event\) => \{ if \(!submitsIssueForm\(event\)\) return; event\.preventDefault\(\); event\.currentTarget\.form\?\.requestSubmit\(\); \}\}/);
    expect(createForm.match(/requestSubmit\(/g)).toHaveLength(1);
    expect(createForm.match(/onSubmit=/g)).toHaveLength(1);
  });

  it('shows the shortcut hint beside the submit action', () => {
    expect(createForm).toMatch(/<button type="submit">Create issue<\/button><small>\{ISSUE_FORM_SUBMIT_HINT\}<\/small>/);
  });
});
