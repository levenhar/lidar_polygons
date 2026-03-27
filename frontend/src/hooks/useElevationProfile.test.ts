import { renderHook, act } from '@testing-library/react';
import axios from 'axios';
import { useElevationProfile } from './useElevationProfile';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    CancelToken: {
      source: () => ({ token: {}, cancel: vi.fn() })
    },
    isCancel: () => false
  }
}));

describe('useElevationProfile', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it('returns initial empty profile and not ready', () => {
    const { result } = renderHook(() => useElevationProfile());
    expect(result.current.elevationProfile).toEqual([]);
    expect(result.current.profileReady).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.profileError).toBe(null);
  });

  it('calculateProfile with short path clears profile and does not request', async () => {
    const { result } = renderHook(() => useElevationProfile());
    await act(async () => {
      await result.current.calculateProfile(
        [{ lng: 34.5, lat: 31.2 }],
        '',
        250,
        50
      );
    });
    expect(result.current.elevationProfile).toEqual([]);
    expect(result.current.profileReady).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('calculateProfile with valid path calls API and updates profile', async () => {
    const mockProfile = [
      { distance: 0, elevation: 100, longitude: 34.5, latitude: 31.2, minElevation: 98, maxElevation: 102 },
      { distance: 100, elevation: 105, longitude: 34.6, latitude: 31.2, minElevation: 103, maxElevation: 107 }
    ];
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { ready: true, profile: mockProfile } });

    const { result } = renderHook(() => useElevationProfile());
    await act(async () => {
      await result.current.calculateProfile(
        [{ lng: 34.5, lat: 31.2 }, { lng: 34.6, lat: 31.2 }],
        '/some/dtm',
        250,
        50
      );
    });

    expect(axios.post).toHaveBeenCalledWith(
      '/api/elevation-profile',
      expect.objectContaining({
        coordinates: [[34.5, 31.2], [34.6, 31.2]],
        dtmPath: '/some/dtm'
      }),
      expect.any(Object)
    );
    expect(result.current.elevationProfile.length).toBe(2);
    expect(result.current.profileReady).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.profileError).toBe(null);
  });

  it('calculateProfile on API error sets profileError and does not set profile', async () => {
    const serverMessage = 'Profile calculation did not return complete data';
    vi.mocked(axios.post).mockRejectedValueOnce({
      response: { data: { details: serverMessage, error: 'Bad request' } }
    });
    const { result } = renderHook(() => useElevationProfile());
    await act(async () => {
      await result.current.calculateProfile(
        [{ lng: 34.5, lat: 31.2 }, { lng: 34.6, lat: 31.2 }],
        '/some/dtm',
        250,
        50
      );
    });
    expect(result.current.elevationProfile).toEqual([]);
    expect(result.current.profileReady).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.profileError).toBe(serverMessage);
  });

  it('clearProfile clears profileError', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({
      response: { data: { details: 'Server error' } }
    });
    const { result } = renderHook(() => useElevationProfile());
    await act(async () => {
      await result.current.calculateProfile(
        [{ lng: 34.5, lat: 31.2 }, { lng: 34.6, lat: 31.2 }],
        '/dtm',
        250,
        50
      );
    });
    expect(result.current.profileError).toBe('Server error');
    act(() => result.current.clearProfile());
    expect(result.current.profileError).toBe(null);
    expect(result.current.elevationProfile).toEqual([]);
  });

  it('clearProfile clears state', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: {
        ready: true,
        profile: [
          { distance: 0, elevation: 100, longitude: 34.5, latitude: 31.2, minElevation: 98, maxElevation: 102 },
          { distance: 50, elevation: 102, longitude: 34.55, latitude: 31.2, minElevation: 100, maxElevation: 104 }
        ]
      }
    });
    const { result } = renderHook(() => useElevationProfile());
    await act(async () => {
      await result.current.calculateProfile(
        [{ lng: 34.5, lat: 31.2 }, { lng: 34.6, lat: 31.2 }],
        '/dtm',
        250,
        50
      );
    });
    expect(result.current.elevationProfile.length).toBeGreaterThanOrEqual(1);
    act(() => result.current.clearProfile());
    expect(result.current.elevationProfile).toEqual([]);
    expect(result.current.profileReady).toBe(false);
  });
});
