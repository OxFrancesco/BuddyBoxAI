const publishableKeyPattern = /^pk_(?:test|live)_[A-Za-z0-9_-]{16,}\$?$/;

export function parseClerkPublishableKey(value: string | undefined): string {
  if (!value || !publishableKeyPattern.test(value)) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key");
  }
  return value;
}
