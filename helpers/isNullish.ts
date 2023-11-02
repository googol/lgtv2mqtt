export function isNullish(value: unknown): value is null | undefined {
  return value === undefined || value === null
}
