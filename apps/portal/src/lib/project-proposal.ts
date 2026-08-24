export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_BRIEF_MAX_LENGTH = 8_000;

const PROPOSAL_LIFETIME_MS = 23 * 60 * 60 * 1_000;

export interface ProjectProposalInput {
  name: string;
  brief: string;
}

interface ValidProjectProposalInput {
  name: string;
  brief: string;
}

type ProjectProposalValidation =
  | { ok: true; value: ValidProjectProposalInput }
  | { ok: false; errors: Partial<Record<keyof ProjectProposalInput, string>> };

export interface ProjectProposalPayload extends ValidProjectProposalInput {
  planJson: string;
  payloadHash: string;
  expiresAt: number;
}

export function validateProjectProposalInput(
  input: ProjectProposalInput,
): ProjectProposalValidation {
  const name = input.name.trim();
  const brief = input.brief.trim();
  const errors: Partial<Record<keyof ProjectProposalInput, string>> = {};

  if (!name) errors.name = "Give your project a name.";
  else if (name.length > PROJECT_NAME_MAX_LENGTH) {
    errors.name = "Keep the name to 120 characters or fewer.";
  }

  if (!brief) errors.brief = "Describe what you want BuddyBox to make.";
  else if (brief.length > PROJECT_BRIEF_MAX_LENGTH) {
    errors.brief = "Keep the brief to 8,000 characters or fewer.";
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { name, brief } };
}

export async function buildProjectProposal(
  input: ProjectProposalInput,
  now = Date.now(),
): Promise<ProjectProposalPayload> {
  const validation = validateProjectProposalInput(input);
  if (!validation.ok) throw new Error("Project proposal input is invalid");

  const { name, brief } = validation.value;
  const planJson = JSON.stringify({
    version: 1,
    project: { name, brief },
    stack: ["TanStack Start", "Clerk", "Convex"],
    delivery: {
      source: "GitHub",
      hosting: "BuddyBox managed Cloudflare",
      approval: "verified messaging channel",
    },
  });

  return {
    name,
    brief,
    planJson,
    payloadHash: await sha256Hex(planJson),
    expiresAt: now + PROPOSAL_LIFETIME_MS,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
