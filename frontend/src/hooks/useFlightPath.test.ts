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
});
