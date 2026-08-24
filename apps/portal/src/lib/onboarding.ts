export type OnboardingStepId =
  | "clerk"
  | "messaging"
  | "chatgpt"
  | "github"
  | "convex";

export interface OnboardingState {
  clerk: boolean;
  imessage: boolean;
  xchat: boolean;
  chatgpt: boolean;
  github: boolean;
  convex: boolean;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  eyebrow: string;
  title: string;
  detail: string;
  action: string;
}

export const onboardingSteps: readonly OnboardingStep[] = [
  {
    id: "clerk",
    eyebrow: "Identity",
    title: "Continue with Google",
    detail: "Google is your primary sign-in; Clerk securely binds it to every instruction and approval.",
    action: "Continue with Google",
  },
  {
    id: "messaging",
    eyebrow: "Your conversation",
    title: "Choose a messaging channel",
    detail: "Verify iMessage or X Chat. Either private conversation unlocks the same BuddyBox agent.",
    action: "Choose a channel",
  },
  {
    id: "chatgpt",
    eyebrow: "Your intelligence",
    title: "Connect ChatGPT",
    detail: "Use your own ChatGPT account through Pi's native Codex transport.",
    action: "Connect ChatGPT",
  },
  {
    id: "github",
    eyebrow: "Your source",
    title: "Connect GitHub",
    detail: "Every project starts in a repository that you own and can leave with.",
    action: "Install GitHub App",
  },
  {
    id: "convex",
    eyebrow: "Your backend",
    title: "Connect Convex",
    detail: "Provision the database and functions for each project in your Convex team.",
    action: "Authorize Convex",
  },
] as const;

export const managedProjectHostname = "<project>-buddybox-sites.buddytools.org";

export const managedHosting = {
  eyebrow: "Included hosting",
  title: "BuddyBox Cloudflare hosting",
  detail:
    `No Cloudflare account is required. Each approved site gets a managed ${managedProjectHostname} address.`,
  action: "Managed by BuddyBox",
} as const;

export function evaluateProjectReadiness(state: OnboardingState) {
  const completedSteps: Record<OnboardingStepId, boolean> = {
    clerk: state.clerk,
    messaging: state.imessage || state.xchat,
    chatgpt: state.chatgpt,
    github: state.github,
    convex: state.convex,
  };
  const completed = onboardingSteps.filter((step) => completedSteps[step.id]).length;
  const next = onboardingSteps.find((step) => !completedSteps[step.id]) ?? null;

  return {
    ready: completed === onboardingSteps.length,
    completed,
    total: onboardingSteps.length,
    next,
    percent: Math.round((completed / onboardingSteps.length) * 100),
    messagingConnected: completedSteps.messaging,
  };
}
