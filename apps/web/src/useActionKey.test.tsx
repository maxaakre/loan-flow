import { act, renderHook } from '@testing-library/react';
import { useActionKey } from './useActionKey';

describe('useActionKey (Review Focus 1)', () => {
  it('returns the same key until reset, so retries and double-clicks reuse it', () => {
    const { result, rerender } = renderHook(() => useActionKey());
    const first = result.current.key();
    rerender();
    expect(result.current.key()).toBe(first);
    act(() => result.current.reset());
    expect(result.current.key()).not.toBe(first);
  });
});
