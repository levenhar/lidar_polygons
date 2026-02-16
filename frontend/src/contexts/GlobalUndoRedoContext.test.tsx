import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { GlobalUndoRedoProvider, useGlobalUndoRedo } from './GlobalUndoRedoContext';

function TestConsumer() {
  const ctx = useGlobalUndoRedo();
  return (
    <div>
      <span data-testid="canUndo">{String(ctx.canUndo)}</span>
      <span data-testid="canRedo">{String(ctx.canRedo)}</span>
      <button
        data-testid="register"
        onClick={() => {
          let value = 0;
          ctx.registerAction('map', () => { value--; }, () => { value++; }, 'test');
        }}
      >
        Register
      </button>
      <button data-testid="undo" onClick={ctx.undo}>Undo</button>
      <button data-testid="redo" onClick={ctx.redo}>Redo</button>
      <button data-testid="clear" onClick={ctx.clearHistory}>Clear</button>
    </div>
  );
}

function ConsumerWithCallback() {
  const ctx = useGlobalUndoRedo();
  const [beforeCalled, setBeforeCalled] = React.useState(0);
  React.useEffect(() => {
    ctx.setBeforeUndoRedoCallback(() => setBeforeCalled((c) => c + 1));
    return () => ctx.setBeforeUndoRedoCallback(null);
  }, [ctx]);
  return (
    <div>
      <span data-testid="beforeCalled">{beforeCalled}</span>
      <button data-testid="undo2" onClick={ctx.undo}>Undo</button>
    </div>
  );
}

describe('GlobalUndoRedoContext', () => {
  it('throws when useGlobalUndoRedo is used outside provider', () => {
    function Bad() {
      useGlobalUndoRedo();
      return null;
    }
    expect(() => render(<Bad />)).toThrow('GlobalUndoRedoProvider');
  });

  it('exposes canUndo/canRedo and registerAction', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
      </GlobalUndoRedoProvider>
    );
    expect(screen.getByTestId('canUndo').textContent).toBe('false');
    expect(screen.getByTestId('canRedo').textContent).toBe('false');

    act(() => {
      screen.getByTestId('register').click();
    });
    expect(screen.getByTestId('canUndo').textContent).toBe('true');
    expect(screen.getByTestId('canRedo').textContent).toBe('false');
  });

  it('undo moves action to redo stack', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
      </GlobalUndoRedoProvider>
    );
    act(() => screen.getByTestId('register').click());
    act(() => screen.getByTestId('undo').click());
    expect(screen.getByTestId('canUndo').textContent).toBe('false');
    expect(screen.getByTestId('canRedo').textContent).toBe('true');
  });

  it('redo moves action back to undo stack', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
      </GlobalUndoRedoProvider>
    );
    act(() => screen.getByTestId('register').click());
    act(() => screen.getByTestId('undo').click());
    act(() => screen.getByTestId('redo').click());
    expect(screen.getByTestId('canUndo').textContent).toBe('true');
    expect(screen.getByTestId('canRedo').textContent).toBe('false');
  });

  it('clearHistory clears both stacks', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
      </GlobalUndoRedoProvider>
    );
    act(() => screen.getByTestId('register').click());
    act(() => screen.getByTestId('clear').click());
    expect(screen.getByTestId('canUndo').textContent).toBe('false');
    expect(screen.getByTestId('canRedo').textContent).toBe('false');
  });

  it('setBeforeUndoRedoCallback is invoked before undo', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
        <ConsumerWithCallback />
      </GlobalUndoRedoProvider>
    );
    act(() => screen.getByTestId('register').click());
    expect(screen.getByTestId('beforeCalled').textContent).toBe('0');
    act(() => screen.getByTestId('undo2').click());
    expect(screen.getByTestId('beforeCalled').textContent).toBe('1');
  });

  it('Ctrl+Z triggers undo when focus is not in input', () => {
    render(
      <GlobalUndoRedoProvider>
        <TestConsumer />
      </GlobalUndoRedoProvider>
    );
    act(() => screen.getByTestId('register').click());
    expect(screen.getByTestId('canUndo').textContent).toBe('true');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
    });
    expect(screen.getByTestId('canUndo').textContent).toBe('false');
    expect(screen.getByTestId('canRedo').textContent).toBe('true');
  });
});
