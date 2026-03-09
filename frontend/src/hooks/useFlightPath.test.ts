import { renderHook, act } from '@testing-library/react';
import { useFlightPath } from './useFlightPath';

describe('useFlightPath', () => {
  it('returns initial state with one route', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    expect(result.current.routes).toHaveLength(1);
    expect(result.current.flightPath).toEqual([]);
    expect(result.current.activeRouteId).toBe(result.current.routes[0].id);
    expect(result.current.nominalFlightHeight).toBe(250);
  });

  it('addPoint adds a point to the active route', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    act(() => {
      result.current.addPoint({ lng: 34.5, lat: 31.2 });
    });
    expect(result.current.flightPath).toHaveLength(1);
    expect(result.current.flightPath[0].lng).toBe(34.5);
    expect(result.current.flightPath[0].lat).toBe(31.2);
  });

  it('registerGlobalAction is called when undoable action is performed', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    act(() => {
      result.current.addPoint({ lng: 34.5, lat: 31.2 });
    });
    expect(registerGlobalAction).toHaveBeenCalled();
    expect(registerGlobalAction).toHaveBeenCalledWith(
      'map',
      expect.any(Function),
      expect.any(Function)
    );
  });

  it('undo reverts addPoint', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    act(() => result.current.addPoint({ lng: 34.5, lat: 31.2 }));
    expect(result.current.flightPath).toHaveLength(1);
    act(() => result.current.undo());
    expect(result.current.flightPath).toHaveLength(0);
  });

  it('addRoute adds a second route', () => {
    const { result } = renderHook(() => useFlightPath({}));
    act(() => result.current.addRoute());
    expect(result.current.routes).toHaveLength(2);
  });

  it('setActiveRoute changes active route', () => {
    const { result } = renderHook(() => useFlightPath({}));
    act(() => result.current.addRoute());
    const secondId = result.current.routes[1].id;
    act(() => result.current.setActiveRoute(secondId));
    expect(result.current.activeRouteId).toBe(secondId);
  });

  it('reverseFlightPath reverses points and clears climb points', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    // Add 3 points
    act(() => {
      result.current.addPoint({ lng: 34.5, lat: 31.2 });
      result.current.addPoint({ lng: 34.6, lat: 31.3 });
      result.current.addPoint({ lng: 34.7, lat: 31.4 });
    });
    const originalPoints = [...result.current.flightPath];
    expect(originalPoints).toHaveLength(3);

    // Reverse the flight path
    act(() => {
      result.current.reverseFlightPath();
    });
    const reversedPoints = result.current.flightPath;
    expect(reversedPoints[0].lng).toBe(originalPoints[2].lng);
    expect(reversedPoints[1].lng).toBe(originalPoints[1].lng);
    expect(reversedPoints[2].lng).toBe(originalPoints[0].lng);

    // Verify climb points are cleared
    expect(result.current.climbRequestsByRoute[result.current.activeRouteId]).toEqual([]);

    // Verify registerGlobalAction was called for the reverse
    expect(registerGlobalAction).toHaveBeenCalledWith(
      'map',
      expect.any(Function),
      expect.any(Function)
    );
  });

  it('global undoFn/redoFn from registerGlobalAction reverts reverseFlightPath', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    act(() => {
      result.current.addPoint({ lng: 34.5, lat: 31.2 });
      result.current.addPoint({ lng: 34.6, lat: 31.3 });
      result.current.addPoint({ lng: 34.7, lat: 31.4 });
    });
    const originalPoints = [...result.current.flightPath];

    act(() => { result.current.reverseFlightPath(); });
    expect(result.current.flightPath[0].lng).toBe(originalPoints[2].lng);

    // Get the undoFn/redoFn registered for the reverse action
    // registerGlobalAction(actionType, undoFn, redoFn)
    const lastCall = registerGlobalAction.mock.calls[registerGlobalAction.mock.calls.length - 1];
    const globalUndoFn = lastCall[1];
    const globalRedoFn = lastCall[2];

    // Simulate Ctrl+Z via global undoFn
    act(() => { globalUndoFn(); });
    expect(result.current.flightPath[0].lng).toBe(originalPoints[0].lng);
    expect(result.current.flightPath[1].lng).toBe(originalPoints[1].lng);
    expect(result.current.flightPath[2].lng).toBe(originalPoints[2].lng);

    // Simulate Ctrl+Y via global redoFn
    act(() => { globalRedoFn(); });
    expect(result.current.flightPath[0].lng).toBe(originalPoints[2].lng);
    expect(result.current.flightPath[1].lng).toBe(originalPoints[1].lng);
    expect(result.current.flightPath[2].lng).toBe(originalPoints[0].lng);
  });

  it('undo and redo work correctly with reverseFlightPath', () => {
    const registerGlobalAction = vi.fn();
    const { result } = renderHook(() =>
      useFlightPath({ registerGlobalAction })
    );
    // Add 3 points
    act(() => {
      result.current.addPoint({ lng: 34.5, lat: 31.2 });
      result.current.addPoint({ lng: 34.6, lat: 31.3 });
      result.current.addPoint({ lng: 34.7, lat: 31.4 });
    });
    const originalPoints = [...result.current.flightPath];

    // Reverse the flight path
    act(() => {
      result.current.reverseFlightPath();
    });
    const reversedPoints = [...result.current.flightPath];
    expect(reversedPoints[0].lng).toBe(originalPoints[2].lng);

    // Undo the reverse
    act(() => {
      result.current.undo();
    });
    const undoPoints = result.current.flightPath;
    expect(undoPoints[0].lng).toBe(originalPoints[0].lng);
    expect(undoPoints[1].lng).toBe(originalPoints[1].lng);
    expect(undoPoints[2].lng).toBe(originalPoints[2].lng);

    // Redo the reverse
    act(() => {
      result.current.redo();
    });
    const redoPoints = result.current.flightPath;
    expect(redoPoints[0].lng).toBe(reversedPoints[0].lng);
    expect(redoPoints[1].lng).toBe(reversedPoints[1].lng);
    expect(redoPoints[2].lng).toBe(reversedPoints[2].lng);
  });
});
