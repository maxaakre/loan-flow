import { describe, expect, it } from 'vitest';
import { addOre, formatKr, kr, ore, OreSchema, percentOf, subOre } from '../src/money';

describe('money', () => {
  it('kr converts kronor to integer öre', () => {
    expect(kr(1234.5)).toBe(123450);
  });

  it('ore rejects non-integers', () => {
    expect(() => ore(1.5)).toThrow(RangeError);
  });

  it('adds and subtracts', () => {
    expect(addOre(kr(1), kr(2), kr(3))).toBe(kr(6));
    expect(subOre(kr(10), kr(4))).toBe(kr(6));
  });

  it('percentOf rounds to whole öre', () => {
    expect(percentOf(ore(333), 0.5)).toBe(167);
  });

  it('formats Swedish kronor', () => {
    expect(formatKr(kr(100000)).replace(/\s/g, ' ')).toBe('100 000 kr');
  });

  it('OreSchema accepts integers and rejects decimals', () => {
    expect(OreSchema.parse(500)).toBe(500);
    expect(() => OreSchema.parse(5.5)).toThrow();
  });
});
