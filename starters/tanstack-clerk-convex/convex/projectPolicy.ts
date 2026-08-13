const MAX_PROJECT_NAME_LENGTH = 80;

export function normalizeProjectName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) {
    throw new Error("Project name must contain at least 2 characters");
  }
  if (normalized.length > MAX_PROJECT_NAME_LENGTH) {
    throw new Error(`Project name must contain at most ${MAX_PROJECT_NAME_LENGTH} characters`);
  }
  return normalized;
}
