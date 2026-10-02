import type { Application } from '@loanflow/core';
import { getApplication } from '../db/applications';
import { ConditionFailedError, transact, type TransactItem } from '../db/client';

export type StepInput = { applicationId: string };

export const nowIso = () => new Date().toISOString();

export async function loadApplication(id: string): Promise<Application> {
  const app = await getApplication(id);
  if (!app) throw new Error(`Application ${id} not found`);
  return app;
}

/**
 * Commits the write. If another run got there first (version changed), reloads and
 * asks `isDone` whether the work already happened. That makes each step safe to retry.
 */
export async function commitOrCheck(
  items: TransactItem[],
  applicationId: string,
  isDone: (fresh: Application) => boolean,
): Promise<void> {
  try {
    await transact(items);
  } catch (err) {
    if (err instanceof ConditionFailedError && isDone(await loadApplication(applicationId))) return;
    throw err;
  }
}
