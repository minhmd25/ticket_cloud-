import { describe, expect, it } from 'vitest';
import { niceTicks } from './StatsChart';

describe('niceTicks', () => {
  it('chọn mốc tròn cho trục', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(9)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(28)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(58)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(67)).toEqual([0, 20, 40, 60, 80]);
    expect(niceTicks(240)).toEqual([0, 50, 100, 150, 200, 250]);
  });
});
