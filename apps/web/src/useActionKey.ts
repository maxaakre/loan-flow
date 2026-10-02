import { useRef } from 'react';

/**
 * One Idempotency-Key per user action. A double-click or a retry after a network error
 * reuses the key, so the server does the work once. Call reset() after success.
 */
export function useActionKey() {
  const ref = useRef<string | null>(null);
  return {
    key: () => (ref.current ??= crypto.randomUUID()),
    reset: () => {
      ref.current = null;
    },
  };
}
