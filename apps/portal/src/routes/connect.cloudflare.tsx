import { createFileRoute } from "@tanstack/react-router";
import { Cloud } from "lucide-react";

import { ProviderConnectionPage } from "~/components/provider-connection-page";
import { providerConnectionRequirements } from "~/lib/provider-connections";

export const Route = createFileRoute("/connect/cloudflare")({ component: ConnectCloudflare });

function ConnectCloudflare() {
  return (
    <ProviderConnectionPage
      icon={<Cloud size={25} />}
      provider={providerConnectionRequirements.cloudflare}
    />
  );
}
