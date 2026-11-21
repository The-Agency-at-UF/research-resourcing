/** Absorb subtraction noise at the eligibility boundary, without rounding business inputs. */
export function availableHours(available: number, required: number, capacity: number): number {
  const tolerance = 16 * Number.EPSILON * Math.max(Math.abs(available), Math.abs(required), Math.abs(capacity));
  return Number.isFinite(available) && available < required && required - available <= tolerance ? required : available;
}
