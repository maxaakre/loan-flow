import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRA_POLLS, usePolling } from './usePolling';

const INTERVAL = 2000;
/** Lets the pending load resolve, then fires the next timer. */
const tickOnce = () => act(async () => vi.advanceTimersByTimeAsync(INTERVAL));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePolling stopWhen', () => {
  it('does a bounded number of extra polls after the data is final, then stops', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'DONE' });
    renderHook(() => usePolling(load, INTERVAL, (d: { status: string }) => d.status === 'DONE'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let i = 0; i < 20; i++) await tickOnce();
    expect(load).toHaveBeenCalledTimes(1 + EXTRA_POLLS);
  });

  it('keeps polling while the data is not final', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'PENDING' });
    renderHook(() => usePolling(load, INTERVAL, (d: { status: string }) => d.status === 'DONE'));
    for (let i = 0; i < 20; i++) await tickOnce();
    expect(load.mock.calls.length).toBeGreaterThan(1 + EXTRA_POLLS);
  });

  it('restarts polling on refresh()', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'DONE' });
    const { result } = renderHook(() => usePolling(load, INTERVAL, () => true));
    for (let i = 0; i < 20; i++) await tickOnce();
    const before = load.mock.calls.length;
    act(() => result.current.refresh());
    for (let i = 0; i < 20; i++) await tickOnce();
    expect(load.mock.calls.length).toBe(before + 1 + EXTRA_POLLS);
  });

  it('makes no calls after unmount', async () => {
    const load = vi.fn().mockResolvedValue({ status: 'PENDING' });
    const { unmount } = renderHook(() => usePolling(load, INTERVAL));
    await tickOnce();
    unmount();
    const calls = load.mock.calls.length;
    for (let i = 0; i < 5; i++) await tickOnce();
    expect(load).toHaveBeenCalledTimes(calls);
  });
});
