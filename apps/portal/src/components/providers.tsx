import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

import { parseClerkPublishableKey } from "~/lib/clerk-config";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;
const clerkPublishableKey = parseClerkPublishableKey(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

function ConvexBridge({ children }: { children: ReactNode }) {
  if (!convex) return children;
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
      appearance={{
        variables: {
          colorPrimary: "#bef264",
          colorBackground: "#161815",
          colorForeground: "#f5f5f4",
          borderRadius: "1rem",
        },
      }}
    >
      <ConvexBridge>{children}</ConvexBridge>
    </ClerkProvider>
  );
}
