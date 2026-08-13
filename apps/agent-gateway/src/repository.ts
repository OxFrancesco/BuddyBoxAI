import type { AdmissionRequest } from "./contracts/v1";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function repositoryMaterialization(request: AdmissionRequest): {
  command: string;
  env: { ICHEF_RUN_CAPABILITY: string };
  remote: string;
} {
  const remote = `http://github.ichef.internal/${request.repository}.git`;
  return {
    remote,
    env: { ICHEF_RUN_CAPABILITY: request.capability },
    command: [
      "set -eu",
      'export GIT_CONFIG_COUNT="1"',
      'export GIT_CONFIG_KEY_0="http.extraHeader"',
      'export GIT_CONFIG_VALUE_0="Authorization: Bearer $ICHEF_RUN_CAPABILITY"',
      `git clone --depth 1 --branch ${shellQuote(request.branch)} ${shellQuote(remote)} /workspace`,
      `git -C /workspace remote set-url origin ${shellQuote(remote)}`,
      "git -C /workspace rev-parse HEAD",
    ].join("\n"),
  };
}
