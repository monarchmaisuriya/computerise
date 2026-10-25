import { bundleIdSchema } from "../shared/contracts";

export function parseBundleIds(raw: string): string[] {
  const values = raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  for (const value of unique) {
    const parsed = bundleIdSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Expected a bundle id like com.apple.TextEdit, got ${JSON.stringify(value)}`);
  }
  return unique;
}

export function parseTimeout(raw: string): number {
  const value = raw.trim();
  if (value === "") throw new Error("Expected approval timeout from 5 to 55 seconds, got an empty value");
  if (!/^\d+$/.test(value)) throw new Error(`Expected a whole number for approval timeout, got ${JSON.stringify(value)}`);
  const seconds = Number(value);
  if (seconds < 5 || seconds > 55) throw new Error(`Expected approval timeout from 5 to 55 seconds, got ${seconds}`);
  return seconds;
}
