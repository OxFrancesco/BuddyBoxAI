export const providerConnectionRequirements = {
  github: {
    id: "github",
    eyebrow: "Connect GitHub",
    headline: "Put every project in a repository you own.",
    summary:
      "GitHub must be verified before iChef can create a project. The connection will use a GitHub App installation so you choose exactly which personal or organization repositories iChef may access.",
    operatorPrerequisites: [
      "Create the iChef GitHub App and register the production callback URL.",
      "Keep the client secret and private key in the server-side credential broker.",
      "Enable the minimum repository permissions needed for contents, pull requests, and workflows.",
    ],
    userApproval:
      "You will sign in to GitHub, choose an account, and select the repositories the iChef App may access.",
    gateNotice:
      "Project creation stays locked until GitHub returns a verified App installation for your Clerk account.",
  },
  cloudflare: {
    id: "cloudflare",
    eyebrow: "Connect Cloudflare",
    headline: "Deploy into infrastructure you control.",
    summary:
      "Cloudflare authorization will let iChef provision project-scoped Workers, preview routes, and storage in your account without asking you to paste a long-lived API token into the browser.",
    operatorPrerequisites: [
      "Register an iChef Cloudflare OAuth integration and its production callback URL.",
      "Perform the authorization-code exchange only in the server-side credential broker.",
      "Request project deployment permissions with the narrowest supported account and resource scope.",
    ],
    userApproval:
      "You will choose the Cloudflare account iChef may deploy to and review the requested resource permissions.",
    gateNotice:
      "No Cloudflare connection is recorded until the callback succeeds and iChef verifies the selected account.",
  },
  convex: {
    id: "convex",
    eyebrow: "Connect Convex",
    headline: "Give every site a durable backend.",
    summary:
      "Convex authorization will let iChef create or select a project in your team and deploy its schema and functions while the resulting backend remains in your account.",
    operatorPrerequisites: [
      "Enable Convex Management API or OAuth access for the iChef production application.",
      "Register the production callback URL and keep exchanged credentials server-side.",
      "Limit access to the team and project operations required for provisioning and deployment.",
    ],
    userApproval:
      "You will choose a Convex team and approve project provisioning and deployment access.",
    gateNotice:
      "No Convex connection is recorded until iChef verifies the authorized team through the server-side callback.",
  },
} as const;

export type ProviderConnectionId = keyof typeof providerConnectionRequirements;

export type ProviderConnectionRequirement =
  (typeof providerConnectionRequirements)[ProviderConnectionId];

export function classifyProviderAuthorizationError(
  error: unknown,
): "configuration_required" | "failed" {
  const value = asErrorRecord(error);
  const data = asErrorRecord(value?.data);
  const haystack = [
    error instanceof Error ? error.message : String(error),
    typeof value?.message === "string" ? value.message : "",
    typeof data?.code === "string" ? data.code : "",
    typeof data?.message === "string" ? data.message : "",
  ].join(" ");

  return haystack.includes("PROVIDER_NOT_CONFIGURED") || /not configured/i.test(haystack)
    ? "configuration_required"
    : "failed";
}

function asErrorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
