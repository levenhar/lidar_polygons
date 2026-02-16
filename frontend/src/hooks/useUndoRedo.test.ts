import { renderHook, act } from '@testing-library/react';
import { useUndoRedo } from './useUndoRedo';

describe('useUndoRedo', () => {
  it('returns initial state', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    expect(result.current.state).toEqual({ count: 0 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('setState updates state and adds history', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    act(() => {
      result.current.setState({ count: 1 });
    });
    expect(result.current.state).toEqual({ count: 1 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo restores previous state', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    act(() => result.current.setState({ count: 1 }));
    act(() => result.current.undo());
    expect(result.current.state).toEqual({ count: 0 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('redo reapplies state', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    act(() => result.current.setState({ count: 1 }));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.state).toEqual({ count: 1 });
    expect(result.current.canRedo).toBe(false);
  });

  it('setState with addToHistory false does not add history', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    act(() => result.current.setState({ count: 1 }));
    act(() => result.current.setState((prev: { count: number }) => ({ count: prev.count + 1 }), false));
    expect(result.current.state.count).toBe(2);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.state.count).toBe(0);
  });

  it('resetHistory replaces state and clears history', () => {
    const { result } = renderHook(() => useUndoRedo({ count: 0 }));
    act(() => result.current.setState({ count: 1 }));
    act(() => result.current.resetHistory({ count: 99 }));
    expect(result.current.state).toEqual({ count: 99 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('onActionRegistered is called when state changes with history', () => {
    const onActionRegistered = vi.fn();
    const { result } = renderHook(() =>
      useUndoRedo({ count: 0 }, { onActionRegistered })
    );
    act(() => result.current.setState({ count: 1 }));
    expect(onActionRegistered).toHaveBeenCalledTimes(1);
    expect(onActionRegistered).toHaveBeenCalledWith(
      { count: 0 },
      { count: 1 },
      expect.any(Function),
      expect.any(Function)
    );
  });
});
