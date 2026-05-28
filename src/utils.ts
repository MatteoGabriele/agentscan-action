/**
 * Parse input that can be in JSON array format or comma-separated format
 * @param input The input string to parse
 * @returns Array of strings
 */
export function parseStringArray(input: string): string[] {
  if (!input) return [];
  try {
    // Try parsing as JSON array first
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    } else {
      throw new Error("Not an array");
    }
  } catch {
    // Fall back to comma-separated format
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

/**
 * Parse input that can be in JSON array format or comma-separated format
 * with a type guard validator
 * @param input The input string to parse
 * @param validator A type guard function to validate each item
 * @returns Array of validated typed items
 */
export function parseTypedArray<T extends string>(
  input: string,
  validator: (item: string) => item is T,
): T[] {
  if (!input) return [];
  const result: T[] = [];
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      const items = parsed.map((item) => String(item).trim()).filter(Boolean);
      for (const item of items) {
        if (validator(item)) {
          result.push(item);
        }
      }
    } else {
      throw new Error("Not an array");
    }
  } catch {
    const items = input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const item of items) {
      if (validator(item)) {
        result.push(item);
      }
    }
  }
  return result;
}
