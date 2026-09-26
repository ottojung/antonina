import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  allowIssueDrop,
  commitQueueOrder,
  IssueQueue,
  issueDragStarted,
  issueDropped,
  issueMoveRequested,
  queueOfTarget,
  type IssueDrop,
  type QueueTarget,
} from './App';
import type { BoardIssue } from './model';
import {
  emptyIssueList,
  visibleIssues,
  canMoveInQueue,
  openQueueOrder,
  QUEUE_DRAG_TYPE,
  QUEUE_MOVE_LABELS,
  QUEUE_REORDERED_NOTICE,
  QUEUE_REORDER_FAILED,
} from './ui-state';

const timestamp = '2026-09-25T12:00:00.000Z';
function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: timestamp, updatedAt: timestamp, messages: [] };
}
const issues = [issue(1), issue(2), issue(3)];
const queue = [3, 1, 2];
// The list component receives the issues the board snapshot already put in
// queue order; it does not sort them a second time.
const visible = visibleIssues(issues, queue, 'open');
const empty = emptyIssueList('open', true);

// The suite runs in a node environment, so there is no document and no native
// drag: a browser cannot be asked to fire a `dragstart` or a `drop` here, and
// no drop-target styling can be observed. What is provable is the wiring — the
// rows carry the named handlers and the shared order, and driving those
// handlers with a fake event shows exactly which whole queue would be sent.
type Row = ReactElement<Record<string, unknown>>;
type Button = ReactElement<{ disabled?: boolean; onClick?: unknown; 'aria-label'?: string }> & { disabled?: boolean };

/**
 * Every host element a render produced. A returned element tree holds the
 * component elements as they were written, so the row component is expanded
 * the way React would expand it — by calling it with its own props — and the
 * elements that carry the real props are the ones inspected.
 */
function elements(node: ReactNode, found: Row[] = []): Row[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, found); return found; }
  if (!isValidElement<Record<string, unknown>>(node)) return found;
  if (typeof node.type === 'symbol' || node.type === undefined) return elements(node.props.children as ReactNode, found);
  if (typeof node.type !== 'string') {
    const expanded = (node.type as (props: unknown) => ReactNode)(node.props);
    return elements(expanded, found);
  }
  found.push(node as Row);
  return elements(node.props.children as ReactNode, found);
}

function rendered(props: Partial<Parameters<typeof IssueQueue>[0]> = {}): Row[] {
  return elements(IssueQueue({
    issues: visible,
    queue,
    hasWriteAccess: true,
    selectedNumber: undefined,
    onSelect: () => {},
    onReorder: async () => null,
    empty,
    ...props,
  }));
}

function rows(props?: Partial<Parameters<typeof IssueQueue>[0]>): Row[] {
  return rendered(props).filter((node) => node.type === 'div' && typeof node.props['data-issue'] === 'number');
}

function queueButtons(props?: Partial<Parameters<typeof IssueQueue>[0]>): Button[] {
  return rendered(props).filter((node) => node.type === 'button' && typeof node.props['aria-label'] === 'string'
    && (node.props['aria-label'] as string).startsWith('Move ')) as Button[];
}

/** The queue a row was rendered with, read back off the element as the browser would. */
function renderedQueue(row: Row): number[] {
  return queueOfTarget({ dataset: { queue: row.props['data-queue'] as string } });
}

/** A press of the move control for one issue, as the browser would report it. */
function fakeClick(row: Row, number: number, direction: 'earlier' | 'later'): QueueTarget {
  const button = queueButtons().find((node) => (node.props['aria-label'] as string).includes(`(#${number})`)
    && (node.props['aria-label'] as string).includes(direction));
  if (!button) throw new Error(`no ${direction} control for issue ${number}`);
  return issueMoveRequested({
    currentTarget: { dataset: { issue: String(number), queue: row.props['data-queue'] as string, direction } },
    preventDefault: () => {},
  });
}

interface FakeTransfer { getData(type: string): string; setData(type: string, value: string): void }
function fakeDrop(row: Row, dragged: number): { target: QueueTarget; prevented: number } {
  const state = { prevented: 0 };
  const event: IssueDrop = {
    currentTarget: { dataset: { issue: row.props['data-issue'] as string, queue: row.props['data-queue'] as string } },
    dataTransfer: { getData: (type: string) => (type === QUEUE_DRAG_TYPE ? String(dragged) : '') },
    preventDefault: () => { state.prevented += 1; },
  };
  return { target: issueDropped(event), prevented: state.prevented };
}

describe('issue queue wiring', () => {
  it('renders one row per visible issue in the shared queue order', () => {
    expect(rows().map((row) => row.props['data-issue'])).toEqual([3, 1, 2]);
    expect(renderedQueue(rows()[0])).toEqual([3, 1, 2]);
  });

  it('drives drag-and-drop through the named drag handlers', () => {
    const [row] = rows();
    expect(row.props.draggable).toBe(true);
    expect(row.props.onDragStart).toBe(issueDragStarted);
    expect(row.props.onDragOver).toBe(allowIssueDrop);
    expect(typeof row.props.onDrop).toBe('function');
  });

  it('carries the dragged issue number on the drag event and accepts the drop', () => {
    const stored: Array<[string, string]> = [];
    const startRow = rows()[0];
    const start: FakeTransfer = { getData: (type) => stored.find(([t]) => t === type)?.[1] ?? '', setData: (type, value) => void stored.push([type, value]) };
    // A real element's dataset holds strings, so the handler sees "3".
    issueDragStarted({ currentTarget: { dataset: { issue: String(startRow.props['data-issue']) } }, dataTransfer: start });

    expect(stored).toEqual([[QUEUE_DRAG_TYPE, '3']]);
    expect(start.getData(QUEUE_DRAG_TYPE)).toBe('3');
    let prevented = 0;
    allowIssueDrop({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(1);
  });

  it('offers the priority position and both move controls to a writer', () => {
    expect(rendered().map((node) => node.props.className).filter((name) => name === 'queue-position')).toHaveLength(3);
    expect(queueButtons().map((node) => node.props['aria-label'])).toEqual([
      `Move earlier in the priority queue (#3)`,
      `Move later in the priority queue (#3)`,
      `Move earlier in the priority queue (#1)`,
      `Move later in the priority queue (#1)`,
      `Move earlier in the priority queue (#2)`,
      `Move later in the priority queue (#2)`,
    ]);
    expect(QUEUE_MOVE_LABELS.earlier).toBe('Move earlier in the priority queue');
  });

  it('disables the move that has nowhere to go instead of sending a rejected queue', () => {
    const controls = queueButtons();
    expect(controls.map((node) => node.props.disabled)).toEqual([true, false, false, false, false, true]);
    expect(canMoveInQueue(openQueueOrder(visible, queue), 3, 'earlier')).toBe(false);
    expect(canMoveInQueue(openQueueOrder(visible, queue), 2, 'later')).toBe(false);
  });

  it('shows a read-only visitor the shared order and none of the controls', () => {
    const readOnly = rows({ hasWriteAccess: false });
    expect(readOnly.map((row) => row.props['data-issue'])).toEqual([3, 1, 2]);
    expect(readOnly.every((row) => row.props.draggable === false)).toBe(true);
    expect(readOnly.every((row) => row.props.onDragStart === undefined)).toBe(true);
    expect(readOnly.every((row) => row.props.onDrop === undefined)).toBe(true);
    expect(queueButtons({ hasWriteAccess: false })).toHaveLength(0);
  });

  it('gives a closed issue no priority position, because the queue has no closed entries', () => {
    const withClosed = [...issues, issue(4, 'closed')];
    const all = visibleIssues(withClosed, [2, 1], 'all');
    const mixed = rows({ issues: all, queue: [2, 1] });
    expect(mixed.map((row) => row.props['data-issue'])).toEqual([2, 1, 3, 4]);
    // The queue attribute holds every open issue, including the one a stale
    // queue missed; the closed issue is in no queue at all.
    expect(renderedQueue(mixed[0])).toEqual([2, 1, 3]);
    const positions = rendered({ issues: all, queue: [2, 1] }).filter((node) => node.props.className === 'queue-position');
    expect(positions).toHaveLength(3);
    expect(positions.map((node) => node.props['aria-label'])).toEqual(['Priority 1', 'Priority 2', 'Priority 3']);
    expect(mixed[3].props['data-issue']).toBe(4);
  });

  it('renders the empty state the copy describes, with no rows to reorder', () => {
    const markup = renderToStaticMarkup(<ul>{IssueQueue({
      issues: [], queue: [], hasWriteAccess: true, selectedNumber: undefined, onSelect: () => {},
      onReorder: async () => null, empty: emptyIssueList('open', false),
    })}</ul>);
    expect(rows({ issues: [] })).toHaveLength(0);
    expect(markup).toContain(emptyIssueList('open', false).title);
  });
});

describe('priority reorder requests', () => {
  it('sends the whole reordered queue from a single move-earlier press', async () => {
    const onReorder = vi.fn(async (_target: QueueTarget) => [1, 3, 2]);
    const [, row] = rows();
    const target = fakeClick(row, 1, 'earlier');

    expect(target).toEqual([1, 3, 2]);
    expect(target).toHaveLength(3);
    await onReorder(target);
    expect(onReorder).toHaveBeenCalledWith([1, 3, 2]);
  });

  it('produces the same order from a drop as from the button', () => {
    const [top, , moved] = rows();
    const byButton = fakeClick(moved, 1, 'earlier');
    const { target, prevented } = fakeDrop(top, 1);

    expect(byButton).toEqual([1, 3, 2]);
    expect(target).toEqual(byButton);
    expect(prevented).toBe(1);
  });

  it('reports no request for a boundary move, a self-drop, and a drop with no drag payload', () => {
    const [first, middle, last] = rows();
    expect(fakeClick(first, 3, 'earlier')).toBeNull();
    expect(fakeClick(last, 2, 'later')).toBeNull();
    expect(fakeDrop(middle, 1).target).toBeNull();
    expect(fakeDrop(middle, 0).target).toBeNull();
  });

  it('hands the drop target the whole queue, not the dragged pair', async () => {
    const sent: Array<number[] | null> = [];
    const tree = IssueQueue({
      issues: visible, queue, hasWriteAccess: true, selectedNumber: undefined, onSelect: () => {},
      onReorder: async (target: QueueTarget) => { sent.push(target); return null; },
      empty,
    });
    const [row] = elements(tree).filter((node) => node.type === 'div' && typeof node.props['data-issue'] === 'number');
    (row.props.onDrop as (event: IssueDrop) => void)({
      currentTarget: { dataset: { issue: String(row.props['data-issue']), queue: row.props['data-queue'] as string } },
      dataTransfer: { getData: (type) => (type === QUEUE_DRAG_TYPE ? '1' : '') },
      preventDefault: () => {},
    });
    await Promise.resolve();
    expect(sent).toEqual([[1, 3, 2]]);
  });

  it('tolerates a row whose queue attribute is missing or unreadable', () => {
    expect(queueOfTarget({ dataset: {} })).toEqual([]);
    expect(queueOfTarget({ dataset: { queue: 'nope' } })).toEqual([]);
    expect(queueOfTarget({ dataset: { queue: '{"a":1}' } })).toEqual([]);
  });
});

describe('committing a priority reorder', () => {
  const commit = (reorder: (numbers: number[]) => Promise<number[]>) => {
    const calls: Array<{ reorder: number[][]; reload: number; notice: string[]; failure: string[] }> = [];
    const record = { reorder: [] as number[][], reload: 0, notice: [] as string[], failure: [] as string[] };
    const deps = {
      reorder,
      reload: async () => { record.reload += 1; },
      notice: (message: string) => { record.notice.push(message); },
      failure: (message: string) => { record.failure.push(message); },
    };
    return { deps, record, calls };
  };

  it('commits the whole queue, then re-reads and reports success', async () => {
    const sent: number[][] = [];
    const { deps, record } = commit(async (numbers) => { sent.push(numbers); return numbers; });

    await expect(commitQueueOrder([2, 1, 3], deps)).resolves.toEqual([2, 1, 3]);
    expect(sent).toEqual([[2, 1, 3]]);
    expect(record.reload).toBe(1);
    expect(record.notice).toEqual([QUEUE_REORDERED_NOTICE]);
    expect(record.failure).toEqual([]);
  });

  it('re-reads the queue and surfaces the board reason when a reorder is refused', async () => {
    const { deps, record } = commit(async () => { throw new Error('credential is required'); });

    await expect(commitQueueOrder([2, 1, 3], deps)).resolves.toBeNull();
    expect(record.reload).toBe(1);
    expect(record.failure).toEqual(['credential is required']);
    expect(record.notice).toEqual([]);
  });

  it('names its own reason when a refusal carries no message', async () => {
    const { deps, record } = commit(async () => { throw 'conflict'; });

    await expect(commitQueueOrder([2, 1, 3], deps)).resolves.toBeNull();
    expect(record.failure).toEqual([QUEUE_REORDER_FAILED]);
    expect(record.reload).toBe(1);
  });

  it('sends nothing at all for a deliberate no-op', async () => {
    const { deps, record } = commit(async () => [1, 2, 3]);

    await expect(commitQueueOrder(null, deps)).resolves.toBeNull();
    expect(record.reload).toBe(0);
    expect(record.notice).toEqual([]);
    expect(record.failure).toEqual([]);
  });

  it('reorders the very order it was handed, never a shortened pair', async () => {
    const sent: number[][] = [];
    const { deps } = commit(async (numbers) => { sent.push(numbers); return numbers; });
    const { target } = fakeDrop(rows()[0], 1);

    await commitQueueOrder(target, deps);
    expect(sent[0]).toHaveLength(3);
    expect([...sent[0]].sort()).toEqual([...openQueueOrder(issues, queue)].sort());
  });
});
