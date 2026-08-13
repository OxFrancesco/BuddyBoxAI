export type PublicEnv = {
  clerkPublishableKey: string;
  convexUrl: string;
};

type EnvSource = Record<string, string | boolean | undefined>;

function requireString(source: EnvSource, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required public environment variable: ${name}`);
  }
  return value.trim();
}

export function parsePublicEnv(source: EnvSource): PublicEnv {
  const clerkPublishableKey = requireString(source, "VITE_CLERK_PUBLISHABLE_KEY");
  if (!clerkPublishableKey.startsWith("pk_test_") && !clerkPublishableKey.startsWith("pk_live_")) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key");
  }

  const convexUrl = requireString(source, "VITE_CONVEX_URL");
  const parsedUrl = new URL(convexUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error("VITE_CONVEX_URL must use HTTPS outside localhost");
  }

  return { clerkPublishableKey, convexUrl: parsedUrl.toString().replace(/\/$/, "") };
}
