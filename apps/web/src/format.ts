import { kr, MAX_AMOUNT, MIN_AMOUNT, type ApplicationStatus, type Ore } from '@loanflow/core';

/** Parses whole kronor typed by the user. Decimals are rejected on purpose. */
export function toOre(input: string): { ok: true; value: Ore } | { ok: false; error: string } {
  const cleaned = input.replace(/[\s\u00a0]/g, '');
  if (!/^\d+$/.test(cleaned)) return { ok: false, error: 'Ange ett belopp i hela kronor.' };
  const outOfRange = { ok: false, error: 'Beloppet måste vara mellan 10 000 och 2 000 000 kr.' } as const;
  // Long input would make kr() throw on unsafe numbers; 2 000 000 has only 7 digits
  if (cleaned.length > 9) return outOfRange;
  const value = kr(Number(cleaned));
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) return outOfRange;
  return { ok: true, value };
}

export const STATUS_SV: Record<ApplicationStatus, string> = {
  SUBMITTED: 'Mottagen',
  ASSESSING: 'Bedöms',
  OFFERED: 'Erbjudande klart',
  SIGNED: 'Signerad',
  DISBURSED: 'Utbetald',
  DECLINED: 'Nekad',
  EXPIRED: 'Erbjudandet gick ut',
  MANUAL_REVIEW: 'Manuell granskning',
};

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
