import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  allowIssueDrop,
  clearBothOutcomes,
  commitQueueOrder,
  IssueQueue,
  issueDragStarted,
  issueDropped,
  issueMoveRequested,
  issueMovedToPosition,
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
  QUEUE_MOVE_TO_LABEL,
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
type Select = ReactElement<{ 'aria-label'?: string; value?: number; onChange?: unknown; children?: ReactNode }>;

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

/** The elements a row rendered, however deeply they are nested in it. */
function inside(node: Row): Row[] {
  return elements(node.props.children as ReactNode);
}

/**
 * The drag handle of each row. The drag lives here rather than on the row, so
 * these are the elements to read the drag wiring off, and the elements whose
 * subtree must hold none of the row's controls.
 */
function grips(props?: Partial<Parameters<typeof IssueQueue>[0]>): Row[] {
  return rendered(props).filter((node) => node.type === 'span' && node.props.className === 'queue-grip');
}

/** The drag handle of one row, addressed by the same row element. */
function gripOf(row: Row): Row {
  const [grip] = inside(row).filter((node) => node.props.className === 'queue-grip');
  expect(grip).toBeDefined();
  return grip!;
}

/** The one shared order every row was rendered with, and every control recomputes from. */
const sharedOrder = openQueueOrder(visible, queue);

function queueButtons(props?: Partial<Parameters<typeof IssueQueue>[0]>): Button[] {
  return rendered(props).filter((node) => node.type === 'button' && typeof node.props['aria-label'] === 'string'
    && (node.props['aria-label'] as string).startsWith('Move ')) as Button[];
}

/** The move-to control of each queued row, in row order. */
function moveToControls(props?: Partial<Parameters<typeof IssueQueue>[0]>): Select[] {
  return rendered(props).filter((node) => node.type === 'select') as Select[];
}

/** A press of the move control for one issue, as the browser would report it. */
function fakeClick(number: number, direction: 'earlier' | 'later'): QueueTarget {
  return issueMoveRequested({ preventDefault: () => {} }, sharedOrder, number, direction);
}

interface FakeTransfer { getData(type: string): string; setData(type: string, value: string): void }
function fakeDrop(row: Row, dragged: number): { target: QueueTarget; prevented: number } {
  const state = { prevented: 0 };
  const event: IssueDrop = {
    dataTransfer: { getData: (type: string) => (type === QUEUE_DRAG_TYPE ? String(dragged) : '') },
    preventDefault: () => { state.prevented += 1; },
  };
  return { target: issueDropped(event, sharedOrder, Number(row.props['data-issue'])), prevented: state.prevented };
}

describe('issue queue wiring', () => {
  it('renders one row per visible issue in the shared queue order', () => {
    expect(rows().map((row) => row.props['data-issue'])).toEqual([3, 1, 2]);
  });

  it('drives drag-and-drop through the named drag handlers on the handle', () => {
    const grip = gripOf(rows()[0]);
    expect(grip.props.draggable).toBe(true);
    expect(grip.props.onDragStart).toBe(issueDragStarted);
    expect(grip.props.onDragOver).toBe(allowIssueDrop);
    expect(typeof grip.props.onDrop).toBe('function');
  });

  it('keeps every control of the row out of the draggable subtree', () => {
    // The row itself is not draggable any more, and the handle carries the drag
    // on its own, so a press that starts on the select button, a step button or
    // the move-to control cannot originate inside a draggable element.
    for (const row of rows({ selectedNumber: 1 })) {
      expect(row.props.draggable).toBeUndefined();
      expect(row.props.onDragStart).toBeUndefined();
      expect(row.props.onDragOver).toBeUndefined();
      expect(row.props.onDrop).toBeUndefined();
      const draggable = inside(row).filter((node) => node.props.draggable !== undefined);
      expect(draggable).toHaveLength(1);
      expect(draggable[0]).toBe(gripOf(row));
      // Nothing a user presses to do something else lives under the handle.
      expect(inside(gripOf(row))).toEqual([]);
    }
  });

  it('carries the dragged issue number on the drag event and accepts the drop', () => {
    const stored: Array<[string, string]> = [];
    const grip = gripOf(rows()[0]);
    const start: FakeTransfer = { getData: (type) => stored.find(([t]) => t === type)?.[1] ?? '', setData: (type, value) => void stored.push([type, value]) };
    // A real element's dataset holds strings, so the handler sees "3".
    issueDragStarted({ currentTarget: { dataset: { issue: String(grip.props['data-issue']) } }, dataTransfer: start });

    expect(stored).toEqual([[QUEUE_DRAG_TYPE, '3']]);
    expect(start.getData(QUEUE_DRAG_TYPE)).toBe('3');
    let prevented = 0;
    allowIssueDrop({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(1);
  });

  it('offers the priority position, both step controls and a move-to slot to a writer', () => {
    expect(rendered().map((node) => node.props.className).filter((name) => name === 'queue-position')).toHaveLength(3);
    expect(queueButtons().map((node) => node.props['aria-label'])).toEqual([
      `Move one place earlier in the priority queue (#3)`,
      `Move one place later in the priority queue (#3)`,
      `Move one place earlier in the priority queue (#1)`,
      `Move one place later in the priority queue (#1)`,
      `Move one place earlier in the priority queue (#2)`,
      `Move one place later in the priority queue (#2)`,
    ]);
    expect(QUEUE_MOVE_LABELS.earlier).toBe('Move one place earlier in the priority queue');
  });

  it('lets a keyboard user place an issue at a chosen position in one commit', () => {
    // The move-to control is rendered on the selected row alone, so the
    // keyboard path is: reach the row's select button, then Tab to the control.
    const controls = moveToControls({ selectedNumber: 3 });
    expect(controls).toHaveLength(1);
    expect(controls[0].props['aria-label']).toBe(`${QUEUE_MOVE_TO_LABEL}: #3 (positions run from 1 to 3)`);
    // The control is a real select: every slot is offered, and the row's own
    // position is what it currently shows.
    expect(controls.map((node) => node.props.value)).toEqual([1]);
    expect(elements(controls[0].props.children as ReactNode).map((option) => option.props.value)).toEqual([1, 2, 3]);
    expect(issueMovedToPosition({ preventDefault: () => {} }, sharedOrder, 2, 1)).toEqual([2, 3, 1]);
    // The slot an issue already holds is the same no-op a boundary step is.
    expect(issueMovedToPosition({ preventDefault: () => {} }, sharedOrder, 2, 3)).toBeNull();
  });

  it('offers no move-to control on a queued row until that row is selected', () => {
    expect(moveToControls()).toHaveLength(0);
    expect(moveToControls({ selectedNumber: 1 }).map((node) => node.props['aria-label']))
      .toEqual([`${QUEUE_MOVE_TO_LABEL}: #1 (positions run from 1 to 3)`]);
    // The selected row is reachable by keyboard alone: its own control is a
    // real button, and pressing it is what makes the move-to control appear.
    const selected: number[] = [];
    const selectButtons = rendered({ selectedNumber: 1, onSelect: (number: number) => { selected.push(number); } })
      .filter((node) => node.type === 'button' && node.props.className === 'issue-select');
    expect(selectButtons).toHaveLength(3);
    // Row order is 3, 1, 2, so the second row button is issue 1.
    (selectButtons[1].props.onClick as () => void)();
    expect(selected).toEqual([1]);
  });

  it('sends the chosen position through the rendered control as a whole queue', async () => {
    const sent: Array<number[] | null> = [];
    const control = moveToControls({ selectedNumber: 2, onReorder: async (target: QueueTarget) => { sent.push(target); return null; } })[0];
    expect(typeof control.props.onChange).toBe('function');
    (control.props.onChange as (event: { preventDefault(): void; target: { value: string } }) => void)({ preventDefault: () => {}, target: { value: '1' } });
    await Promise.resolve();
    expect(sent).toEqual([[2, 3, 1]]);
    // A whole-list permutation: every open issue exactly once, the same shape a
    // step or a drop commits.
    expect(sent[0]).toHaveLength(3);
    expect([...sent[0]!].sort()).toEqual([...sharedOrder].sort());
  });

  it('steps an unselected row without the row being selected first', async () => {
    const sent: Array<number[] | null> = [];
    const buttons = queueButtons({ onReorder: async (target: QueueTarget) => { sent.push(target); return null; } });
    // Row order is 3, 1, 2 with earlier/later per row, so the fourth button is
    // issue 1's "later" — a row nobody selected.
    const later = buttons[3];
    (later.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault: () => {} });
    await Promise.resolve();
    expect(moveToControls()).toHaveLength(0);
    expect(sent).toEqual([[3, 2, 1]]);
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
    // No handle at all, so there is nothing draggable and nothing that could
    // offer the browser a drop.
    expect(grips({ hasWriteAccess: false })).toEqual([]);
    expect(readOnly.every((row) => inside(row).every((node) => node.props.draggable === undefined))).toBe(true);
    expect(readOnly.every((row) => inside(row).every((node) => node.props.onDragStart === undefined && node.props.onDragOver === undefined && node.props.onDrop === undefined))).toBe(true);
    expect(queueButtons({ hasWriteAccess: false })).toHaveLength(0);
    // Not even the selected row gets a move-to control, so a visitor cannot
    // reach the write path by selecting their way through the list.
    expect(moveToControls({ hasWriteAccess: false, selectedNumber: 3 })).toHaveLength(0);
  });

  it('gives a closed issue no priority position and offers it no drop, because the queue has no closed entries', () => {
    const withClosed = [...issues, issue(4, 'closed')];
    const all = visibleIssues(withClosed, [2, 1, 3], 'all');
    const mixed = rows({ issues: all, queue: [2, 1, 3] });
    expect(mixed.map((row) => row.props['data-issue'])).toEqual([2, 1, 3, 4]);
    const positions = rendered({ issues: all, queue: [2, 1, 3] }).filter((node) => node.props.className === 'queue-position');
    expect(positions).toHaveLength(3);
    expect(positions.map((node) => node.props['aria-label'])).toEqual(['Priority 1', 'Priority 2', 'Priority 3']);
    // A closed row would be a drop the queue cannot hold, so it is not a drop
    // target at all: the browser is never offered an accepted-drop cursor, and
    // there is no handle to start a drag from, so no drag can start that could
    // only fail. The three open rows each carry one, and each of them wires the
    // draggable flag to the same two handlers.
    const closed = mixed[3];
    expect(closed.props['data-issue']).toBe(4);
    expect(inside(closed).filter((node) => node.props.draggable !== undefined)).toEqual([]);
    expect(inside(closed).filter((node) => node.props.onDragOver !== undefined || node.props.onDrop !== undefined || node.props.onDragStart !== undefined)).toEqual([]);
    expect(grips({ issues: all, queue: [2, 1, 3] })).toHaveLength(3);
    expect(mixed.slice(0, 3).every((row) => gripOf(row).props.onDragOver === allowIssueDrop)).toBe(true);
    expect(mixed.slice(0, 3).every((row) => gripOf(row).props.draggable === true && gripOf(row).props.onDragStart === issueDragStarted)).toBe(true);
    expect(mixed.slice(0, 3).every((row) => typeof gripOf(row).props.onDrop === 'function')).toBe(true);
    // A closed issue is not in the shared order, so it is never the selected
    // row that carries the move-to control.
    expect(moveToControls({ issues: all, queue: [2, 1, 3] })).toHaveLength(0);
    expect(moveToControls({ issues: all, queue: [2, 1, 3], selectedNumber: 4 })).toHaveLength(0);
    expect(moveToControls({ issues: all, queue: [2, 1, 3], selectedNumber: 1 })).toHaveLength(1);
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
    const target = fakeClick(1, 'earlier');

    expect(target).toEqual([1, 3, 2]);
    expect(target).toHaveLength(3);
    await onReorder(target);
    expect(onReorder).toHaveBeenCalledWith([1, 3, 2]);
  });

  it('produces the same order from a drop as from the button', () => {
    const [top, , moved] = rows();
    const byButton = fakeClick(1, 'earlier');
    const { target, prevented } = fakeDrop(top, 1);

    expect(byButton).toEqual([1, 3, 2]);
    expect(target).toEqual(byButton);
    expect(prevented).toBe(1);
  });

  it('reports no request for a boundary move, a self-drop, and a drop with no drag payload', () => {
    const [first, middle] = rows();
    expect(fakeClick(3, 'earlier')).toBeNull();
    expect(fakeClick(2, 'later')).toBeNull();
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
    (gripOf(row).props.onDrop as (event: IssueDrop) => void)({
      dataTransfer: { getData: (type) => (type === QUEUE_DRAG_TYPE ? '1' : '') },
      preventDefault: () => {},
    });
    await Promise.resolve();
    expect(sent).toEqual([[1, 3, 2]]);
  });
});

describe('committing a priority reorder', () => {
  const commit = (reorder: (numbers: number[]) => Promise<number[]>) => {
    const record = { reload: 0, clearedNotice: 0, clearedError: 0, notice: [] as string[], failure: [] as string[] };
    const deps = (target: number[]) => ({
      write: () => reorder(target),
      reload: async () => { record.reload += 1; },
      clear: () => clearBothOutcomes(() => { record.clearedError += 1; }, () => { record.clearedNotice += 1; }),
      notice: (message: string) => { record.notice.push(message); },
      failure: (message: string) => { record.failure.push(message); },
    });
    return { deps, record };
  };

  it('commits the whole queue, then re-reads and reports success', async () => {
    const sent: number[][] = [];
    const { deps, record } = commit(async (numbers) => { sent.push(numbers); return numbers; });

    await expect(commitQueueOrder([2, 1, 3], deps)).resolves.toEqual([2, 1, 3]);
    expect(sent).toEqual([[2, 1, 3]]);
    expect(record.reload).toBe(1);
    // Both halves of the standing outcome go: a saved order is never shown
    // beside an error from something else, and a refusal is never shown beside
    // a stale success.
    expect(record.clearedNotice).toBe(1);
    expect(record.clearedError).toBe(1);
    expect(record.notice).toEqual([QUEUE_REORDERED_NOTICE]);
    expect(record.failure).toEqual([]);
  });

  it('clears a standing notice and a standing error before a real commit', async () => {
    const { deps, record } = commit(async () => { throw new Error('credential is required'); });

    await expect(commitQueueOrder([2, 1, 3], deps)).resolves.toBeNull();
    expect(record.clearedNotice).toBe(1);
    expect(record.clearedError).toBe(1);
    expect(record.notice).toEqual([]);
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
    expect(record.clearedNotice).toBe(0);
    expect(record.clearedError).toBe(0);
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
