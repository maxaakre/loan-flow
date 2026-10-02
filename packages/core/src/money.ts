import { z } from 'zod';

declare const oreBrand: unique symbol;
/** All money is integer öre (1 kr = 100 öre). The brand stops raw numbers sneaking in. */
export type Ore = number & { readonly [oreBrand]: true };

export function ore(value: number): Ore {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer öre amount: ${value}`);
  return value as Ore;
}

export const kr = (amount: number): Ore => ore(Math.round(amount * 100));
export const addOre = (...values: Ore[]): Ore => ore(values.reduce((sum, v) => sum + v, 0));
export const subOre = (a: Ore, b: Ore): Ore => ore(a - b);
/** Multiplies by a rate and rounds to the nearest whole öre. */
export const percentOf = (amount: Ore, rate: number): Ore => ore(Math.round(amount * rate));

export const OreSchema = z
  .number()
  .int()
  .transform((v) => ore(v));

export function formatKr(value: Ore): string {
  const hasOre = value % 100 !== 0;
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: hasOre ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value / 100);
}
