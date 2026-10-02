export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'ASSESSING',
  'OFFERED',
  'SIGNED',
  'DISBURSED',
  'DECLINED',
  'EXPIRED',
  'MANUAL_REVIEW',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

const ALLOWED: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  SUBMITTED: ['ASSESSING', 'MANUAL_REVIEW'],
  ASSESSING: ['OFFERED', 'DECLINED', 'MANUAL_REVIEW'],
  // MANUAL_REVIEW from OFFERED/SIGNED is the process's catch-all when a step fails for good
  OFFERED: ['SIGNED', 'EXPIRED', 'MANUAL_REVIEW'],
  SIGNED: ['DISBURSED', 'MANUAL_REVIEW'],
  DISBURSED: [],
  DECLINED: [],
  EXPIRED: [],
  MANUAL_REVIEW: [],
};

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
  constructor(
    readonly from: ApplicationStatus,
    readonly to: ApplicationStatus,
  ) {
    super(`Invalid status transition ${from} → ${to}`);
  }
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!ALLOWED[from].includes(to)) throw new InvalidTransitionError(from, to);
}

export const isFinal = (status: ApplicationStatus): boolean => ALLOWED[status].length === 0;
