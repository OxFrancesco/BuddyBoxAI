import { createFileRoute } from "@tanstack/react-router";
import { Github } from "lucide-react";

import { ProviderConnectionPage } from "~/components/provider-connection-page";
import { providerConnectionRequirements } from "~/lib/provider-connections";

export const Route = createFileRoute("/connect/github")({ component: ConnectGithub });

function ConnectGithub() {
  return (
    <ProviderConnectionPage
      icon={<Github size={25} />}
      provider={providerConnectionRequirements.github}
    />
  );
}
