# BuddyBox

BuddyBox is a conversational coding agent that lets a person create, change, preview, and publish websites from an iMessage conversation.

## Language

**User**:
A person with one BuddyBox identity who may converse through one or more iMessage Connections and own multiple Projects.
_Avoid_: Customer, sender, account

**iMessage Connection**:
The verified association between exactly one User and one iMessage address. A User may hold several iMessage Connections, but a message from an unverified address carries no User authority.
_Avoid_: Sender allowlist, phone mapping, login session

**Service Connection**:
A User-authorized relationship that lets BuddyBox use one external service on that User's behalf. It records delegated authority and health without making stored credentials part of the User-facing concept.
_Avoid_: Provider Connection, integration, API key, credential

Cloudflare hosting is not a Service Connection during the managed beta. It is
an BuddyBox platform capability; Users never authorize or supply a Cloudflare account.

**Managed Site Address**:
The BuddyBox-hosted address assigned to a Project release. The reserved convention
is `<project>-buddybox-sites.buddytools.org`; collisions receive a stable suffix.
It is not a claim of User ownership or custom-domain support.
_Avoid_: User Cloudflare, connected host, custom domain

**Project-ready User**:
A User whose iMessage Connection and required Service Connections, including source ownership, are verified. Only a Project-ready User may confirm a Proposed Project or begin its initial Run.
_Avoid_: Logged-in user, onboarded sender, connected account

**Project**:
A durable website product owned by exactly one User, including its history and published outcomes. Temporary working state does not define the Project.
_Avoid_: Sandbox, chat, session, repository

**Active Project**:
The Project currently selected for ordinary instructions arriving through one iMessage Connection. Selecting another Active Project changes routing, not ownership or Project state.
_Avoid_: Open project, running project, current sandbox

**Proposed Project**:
An unconfirmed description of a possible Project. It becomes a Project only when the User approves its plan for an initial Run.
_Avoid_: Draft repository, empty project, conversation

**Conversation**:
The User's ongoing exchange with BuddyBox about one Project or about creating a Project.
_Avoid_: Project, run, message thread

**Run**:
One bounded attempt by BuddyBox to fulfill an instruction for a Project, from admission through a truthful final outcome.
_Avoid_: Conversation, sandbox, deployment, task

**Run Outcome**:
The final truthful state of a Run: succeeded, failed, cancelled, or needs attention. Completing agent activity without satisfying the Run's verification gates is not success.
_Avoid_: Agent stopped, response status, process exit

**Preview**:
A temporary, inspectable website result produced by a Run that has not been published as the Project's live website.
_Avoid_: Production, release, deployment

**Release**:
A durable published version of a Project that Users may promote to its live website.
_Avoid_: Preview, run, build

**Approval**:
A User's explicit, action-bound authorization for one pending operation whose authority is not implied by ordinary conversation.
_Avoid_: Confirmation text, generic yes, permission
