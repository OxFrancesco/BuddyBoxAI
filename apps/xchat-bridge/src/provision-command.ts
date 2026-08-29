import {
  provisionXChat,
  type ProvisionXChatOptions,
  type XChatIdentityRegistration,
  type XChatIdentityVerification,
  type XProvisioningHttp,
} from "./provision";

type ProvisionPhase = ProvisionXChatOptions["phase"];
const PHASES = ["status", "identity", "identity-rotate", "subscription", "all"] as const;

export async function runXChatProvisionCommand(options: {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetcher?: XProvisioningHttp;
  identityRegistration?: XChatIdentityRegistration;
  identityVerification?: XChatIdentityVerification;
}): Promise<{ exitCode: 0 | 1 | 2; output: string }> {
  const phase = parsePhase(options.args);
  if (!phase) {
    return jsonCommandResult(1, {
      status: "error",
      code: "invalid_phase",
      allowedPhases: PHASES,
    });
  }
  try {
    const result = await provisionXChat({
      phase,
      env: options.env,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.identityRegistration ? { identityRegistration: options.identityRegistration } : {}),
      ...(options.identityVerification ? { identityVerification: options.identityVerification } : {}),
    });
    return jsonCommandResult(result.status === "blocked" ? 2 : result.status === "error" ? 1 : 0, result);
  } catch {
    return jsonCommandResult(1, {
      status: "error",
      requestedPhase: phase,
      code: "provisioning_failed",
    });
  }
}

function parsePhase(args: readonly string[]): ProvisionPhase | undefined {
  if (args.length === 0) return "status";
  if (args.length !== 1) return undefined;
  const candidate = args[0];
  return candidate && isProvisionPhase(candidate) ? candidate : undefined;
}

function isProvisionPhase(value: string): value is ProvisionPhase {
  return value === "status"
    || value === "identity"
    || value === "identity-rotate"
    || value === "subscription"
    || value === "all";
}

function jsonCommandResult(
  exitCode: 0 | 1 | 2,
  value: unknown,
): { exitCode: 0 | 1 | 2; output: string } {
  return { exitCode, output: `${JSON.stringify(value)}\n` };
}
