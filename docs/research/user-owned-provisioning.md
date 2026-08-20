# User-owned provisioning for iChef

_Research current as of 2026-08-13. Sources are vendor documentation and official source repositories._

> Product decision, 2026-08-14: iChef's beta uses centrally managed Cloudflare
> hosting. Users do not connect a Cloudflare account. The Cloudflare research
> below is retained for a possible future bring-your-own-cloud option, not the
> current onboarding or readiness model.

## Executive answer

iChef keeps source repositories in the User's GitHub account and backends in the
User's Convex team while centrally hosting beta releases in iChef's Cloudflare
account. Durable provider credentials are never handed to Pi or a Cloudflare
Sandbox. Clerk is the exception: its public product surface does not currently
document delegated workspace administration. A fully automatic, persistently
manageable Clerk application in the user's workspace therefore requires
admission to Clerk's private-beta Platform API or a claim/transfer handoff that
ends iChef's control.

| Resource | User-owned automation | Delegated authorization | MVP verdict |
| --- | --- | --- | --- |
| GitHub repository | Yes | GitHub App installation token; optional user access token | Supported |
| Cloudflare Worker and related resources | iChef-owned during beta | Operator credential behind the deployment gateway | No User connection or OAuth gate |
| Convex project/deployments | Yes | Convex OAuth application or team/project token | Supported; Management API is beta |
| Clerk application | Partly | No documented public workspace-admin OAuth; Platform API token is private beta | Use claimable app/handoff or obtain beta access |

## Recommended ownership and credential model

Each beta project consists of a repository in the User's GitHub account or
organization, an iChef-hosted release, and a project in the User's Convex team.
A Clerk application should become User-owned at claim/transfer time. iChef owns
its control plane, encrypted connection records, temporary build artifacts, and
managed preview/release hosting. The reserved managed hostname convention is
`<project>-ichef-sites.buddytools.org`; collision suffixes must be stable.

Pi and the Cloudflare Sandbox should receive source plus task-scoped capabilities, never standing GitHub, Cloudflare, Convex, or Clerk credentials. Trusted provider gateways should mint or refresh credentials just in time, perform typed operations such as `pushCommit`, `deployWorker`, and `deployConvex`, and record immutable audit data. This boundary matters even in “YOLO” agent mode: broad agent autonomy does not require broad provider credentials.

Store provider resource IDs and encrypted refresh material in the control plane. After a build, the sandbox returns an artifact or patch; the gateway validates the target and executes the provider operation. A production deploy should remain a separately auditable action even when the user has enabled automatic approval.

## 1. GitHub repositories

The intended model is natively supported. A GitHub App can mint installation access tokens (IATs) for an installation, use them with REST, GraphQL, and HTTP Git, and narrow them to selected repositories and permissions. IATs expire after one hour and cannot exceed the installation's grant, so they should be minted on demand by iChef's Git gateway rather than persisted or sent to Pi ([GitHub: generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).

For a uniform personal-account and organization flow, iChef should maintain a public, versioned template and call the template-generation endpoint. That endpoint accepts an IAT and can set either a person or organization as owner; it needs `Administration: write` and `Contents: read` ([GitHub: create a repository from a template](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#create-a-repository-using-a-template)). By contrast, creating a repository for the authenticated user does not accept an IAT and requires a GitHub App user access token ([GitHub: create a repository for the authenticated user](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#create-a-repository-for-the-authenticated-user)). A repository created by an installed app is automatically included in that installation even when the installer originally selected only specific repositories ([GitHub: install an app from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)).

Ongoing clone/push requires `Contents: write`; modifying workflow files also requires `Workflows: write` ([GitHub App repository permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)). After creation, mint tokens scoped only to the destination repository. Creation itself cannot be narrowed to a repository that does not exist yet.

Practical blockers are organizational policy and account binding. An app requesting repository administration will commonly require organization-owner approval, and an organization can prohibit member requests. Personal-account installation is simpler. The setup callback's `installation_id` is not proof of identity and is explicitly spoofable; iChef must bind it only after validating the authenticated GitHub user and a short-lived, one-use state value ([GitHub: setup URL security warning](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)).

**MVP:** generate a private repository from the iChef template under the selected account, retain installation/account/repository IDs, and let the Git gateway mint destination-scoped IATs for each push. Request a user access token only if user attribution or an endpoint unavailable to IATs is actually needed.

## 2. Cloudflare Workers and infrastructure (future BYO-cloud option)

This section describes a technically viable future option. It is not part of
current onboarding. During the beta, iChef's trusted deployment gateway uses an
operator credential to publish approved releases in iChef's account. The
general Pi sandbox never receives that credential.

Cloudflare now provides third-party OAuth on every plan specifically so integrations do not need customers to share long-lived API tokens ([Cloudflare OAuth overview](https://developers.cloudflare.com/fundamentals/oauth/)). iChef should register a server-side Authorization Code client and request `offline_access` when background refresh is required. Third-party clients support Authorization Code rather than client-credentials or device grants; a new client is private to the parent account until made public. Public clients require verified publisher details and declared scopes, and public visibility is irreversible ([Create a Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)). Authorization, token, revocation, and user-info endpoints are documented by Cloudflare ([Integrate with Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)).

Consent lets the user select the Cloudflare account(s) and inspect requested scopes. Users can revoke access, and account administrators can disable new public OAuth grants ([Authorize a Cloudflare application](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)). At connection time iChef should query the live OAuth scope catalog, because product and endpoint coverage can evolve.

Worker deployments are automatable through the Workers API. Direct script upload accepts a bearer credential with Workers Scripts write access ([Workers script upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/)). Start with Workers Scripts write plus only the read permission needed for account discovery. Add Workers Routes, Zone/DNS, KV, R2, D1, or other scopes only when the project requests those capabilities ([Cloudflare API permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)).

Wrangler documents `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for noninteractive API-token use, not arbitrary injection of a third-party OAuth session ([Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)). The more reliable MVP is therefore a trusted deployment gateway calling Cloudflare's REST API/SDK with the refreshed OAuth bearer token, rather than copying a Wrangler profile or credential into the sandbox.

An explicitly consented API token is a compatibility fallback. Tokens can be least-privilege, resource-scoped, time-limited, and IP-restricted; account-owned tokens are better CI principals but require a Super Administrator to create, whereas user tokens inherit the user's membership ([Account-owned API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)).

Workers Builds should not be on the MVP's critical path. Its current REST API requires a user-scoped API token, rejects account tokens, and requires a one-time manual Cloudflare GitHub App installation before automation ([Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)). Direct artifact upload from iChef's gateway avoids that coupling.

**MVP:** public OAuth Authorization Code connection, explicit account selection, encrypted refresh credential in the control plane, and direct Worker upload. Offer a least-privilege user/account token only when OAuth is disabled or an endpoint does not support it.

## 3. Convex projects and deployments

Convex explicitly exposes Platform APIs for products that manage projects on behalf of users. Team tokens act as the team and OAuth Applications authorize an individual user ([Convex Platform APIs](https://docs.convex.dev/platform-apis/overview)). The openly available beta Management API can create projects and deployments and is available through the official `@convex-dev/platform` library; it accepts team tokens or OAuth Application access tokens ([Convex Management API](https://docs.convex.dev/management-api/overview)).

Convex OAuth uses Authorization Code and supports S256 PKCE. In a project-scoped authorization, the user may select an existing project or create a new one during consent. Team-scoped access can create projects but is broad across the team's projects; project-scoped access is the least-privilege choice when the consent-time creation flow meets iChef's needs. An unverified OAuth app is limited to 100 distinct teams before Convex verification is required ([Convex OAuth Applications](https://docs.convex.dev/platform-apis/oauth-applications)).

The Management API separately documents project creation, deployment creation, and deploy-key creation ([Create project](https://docs.convex.dev/management-api/create-project), [Create deployment](https://docs.convex.dev/management-api/create-deployment), [Create deploy key](https://docs.convex.dev/management-api/create-deploy-key)). Convex's documented automation flow obtains a deploy key and runs the CLI; the CLI also exposes project, deployment, and deploy commands ([Convex CLI project commands](https://docs.convex.dev/cli/reference/project), [deployment commands](https://docs.convex.dev/cli/reference/deployment), [deploy](https://docs.convex.dev/cli/reference/deploy)).

There are two important caveats. First, the Management API is beta. Second, a deploy key created while using OAuth carries the same OAuth-granted authority, so it must not be assumed to be a privilege-narrowing boundary. iChef should keep OAuth and deploy credentials in its trusted Convex gateway and run the final deploy there, or in a tightly isolated deploy job, rather than inside the general Pi sandbox.

**MVP:** use project-scoped OAuth and let the user create/select the iChef project in the consent flow. Use team scope only if zero-click project creation outside consent is essential, disclose its breadth, and require explicit team selection. Apply for OAuth verification before approaching 100 connected teams.

## 4. Clerk applications

Clerk's Platform API can programmatically create applications and development/production instances, configure them, and transfer ownership, but it is currently private beta and authenticates with a platform API access token ([Clerk Platform API](https://clerk.com/docs/reference/platform-api), [Platform API applications](https://clerk.com/docs/reference/platform-api/tag/applications)). Clerk markets this product for programmatic provisioning and claimable applications ([Clerk for Platforms](https://clerk.com/platform)). This is a platform-owned provisioning API, not a generally documented OAuth grant for administering an arbitrary customer's Clerk workspace.

The public Clerk CLI can authenticate interactively and create/configure/deploy applications in the logged-in user's context, including agent-friendly JSON output ([Clerk CLI](https://clerk.com/docs/cli)). It does not document a third-party delegated workspace token suitable for iChef's unattended control plane. Likewise, Clerk's scoped OAuth feature delegates access to an application's user data; it is not authority to manage the user's Clerk workspace or applications ([Clerk scoped OAuth access](https://clerk.com/docs/guides/configure/auth-strategies/oauth/scoped-access)). iChef should not collect a user's Clerk secret key as if it were scoped delegated authorization.

There is a workable claim-first fallback. Clerk's official JavaScript SDK includes an experimental accountless-application API that creates keys and a `claimUrl`, plus TanStack Start keyless support ([Accountless Applications API](https://github.com/clerk/javascript/blob/main/packages/backend/src/api/endpoints/AccountlessApplicationsAPI.ts), [accountless resource](https://github.com/clerk/javascript/blob/main/packages/backend/src/api/resources/AccountlessApplication.ts), [TanStack Start keyless integration](https://github.com/clerk/javascript/blob/main/packages/tanstack-react-start/src/server/keyless/index.ts)). Clerk's Backend API marks accountless applications experimental, so the contract may change or disappear ([Clerk Backend API](https://clerk.com/docs/reference/backend-api)). Clerk Core 3 also documents keyless mode for TanStack Start ([Clerk Core 3 changelog](https://clerk.com/changelog/2026-03-03-core-3)).

A claim or Platform API transfer can move ownership to the user, but iChef then loses its original management authority. Production still requires a production instance and domain/DNS configuration unless the Platform API covers the flow ([Clerk production deployment](https://clerk.com/docs/guides/development/deployment/production)). Consequently, “zero-touch creation in the user's Clerk account” and “persistent iChef management” cannot both be promised with Clerk's documented public interfaces today.

**MVP:** apply for Clerk for Platforms/private-beta access. Until admitted, use Clerk's TanStack keyless/accountless flow for the first preview and deliver the claim URL through the authenticated onboarding session. Treat claim and production activation as an explicit handoff. Do not request or store a customer's broad Clerk secret key; if a private-beta transfer is used, disclose that iChef loses access after claim.

## Spectrum Cloud identity and delivery

Spectrum Cloud's official TypeScript provider offers managed iMessage lines to a Node/Bun application, discovers project lines, and renews project tokens. The current transport uses Node-compatible gRPC and does not support strict Worker isolates, so the persistent send/receive bridge should run in a long-lived Bun/Node service rather than a standard Cloudflare Worker ([Spectrum iMessage provider](https://photon.codes/docs/spectrum-ts/providers/imessage)). HTTP webhooks can still terminate on a Worker if their raw bodies are verified correctly.

Spectrum supports either a shared pool that assigns a normal iMessage number per end user or a dedicated project number presented to all users. Documented limits include 5,000 messages per server per day and 50 new conversations per line per day ([Spectrum connection and routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)). For a single memorable “text iChef” address, use the dedicated-line plan; pooled lines are suitable for a smaller pilot but do not provide one universal contact.

Incoming messages carry a platform user/address and message ID, not an authenticated Clerk session ([Spectrum spaces and users](https://photon.codes/docs/spectrum-ts/spaces-and-users), [Spectrum messages](https://photon.codes/docs/spectrum-ts/messages)). Therefore an iMessage phone number/email is only a routing identifier. Bind it to a Clerk user through an expiring authenticated link plus a return-message challenge, and require re-verification for sensitive account changes. Webhooks are HMAC-SHA256 signed, have a five-minute replay window, and are delivered at least once; verify the exact raw body and deduplicate by message ID ([Spectrum webhooks](https://photon.codes/docs/spectrum-ts/webhooks)).

## MVP sequence and release gates

1. Connect Clerk web identity to the iMessage address with an authenticated, expiring challenge; never treat an inbound address as login proof by itself.
2. Install the GitHub App, validate the installation against the logged-in GitHub principal, and generate the user's private repository from the iChef template.
3. Authorize Convex project-scoped access and create/select a user-owned project.
4. Allocate an iChef-managed hostname and deploy the approved release through the trusted Cloudflare gateway; require no User Cloudflare connection.
5. Create a keyless Clerk preview and hand the claim URL to the authenticated user. Gate “fully managed user-owned Clerk production” behind Platform API access.
6. Run Pi in a credential-free Cloudflare Sandbox. Provider gateways alone push and deploy, even when the user's project policy auto-approves those actions.

The hard launch dependencies are iChef-managed hostname routing and certificate
automation, Convex OAuth verification before scale, organization-owner approval
for GitHub installations where required, and either Clerk Platform API access
or honest product UX for the Clerk claim/production handoff.
