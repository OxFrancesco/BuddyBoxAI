import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

import { parsePublicEnv } from "~/lib/env";

const publicEnv = parsePublicEnv(import.meta.env);
const convex = new ConvexReactClient(publicEnv.convexUrl, {
  unsavedChangesWarning: false,
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={publicEnv.clerkPublishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
