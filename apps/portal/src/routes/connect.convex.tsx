import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { ProviderConnectionPage } from "~/components/provider-connection-page";
import { providerConnectionRequirements } from "~/lib/provider-connections";

export const Route = createFileRoute("/connect/convex")({ component: ConnectConvex });

function ConnectConvex() {
  return (
    <ProviderConnectionPage
      icon={<Database size={25} />}
      provider={providerConnectionRequirements.convex}
    />
  );
}
