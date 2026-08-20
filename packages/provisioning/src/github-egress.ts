const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export const GITHUB_RUNTIME_PERMISSIONS = {
  contents: "write",
  metadata: "read",
} as const;

export type GitHubEgressRoute = {
  kind: "git" | "api";
  upstreamUrl: string;
};

export function resolveGitHubEgressRoute(input: {
  method: string;
  pathname: string;
  search: string;
  repositoryFullName: string;
}): GitHubEgressRoute | null {
  const repository = parseRepositoryFullName(input.repositoryFullName);
  if (!repository || unsafePath(input.pathname)) return null;
  const method = input.method.toUpperCase();
  const path = input.pathname.replace(/^\/+/, "");
  const gitPrefix = `${repository.owner}/${repository.name}.git/`;

  if (path.toLowerCase().startsWith(gitPrefix.toLowerCase())) {
    const requestedPrefix = path.slice(0, gitPrefix.length);
    if (requestedPrefix.toLowerCase() !== gitPrefix.toLowerCase()) return null;
    const operation = path.slice(gitPrefix.length);
    if (method === "GET" && operation === "info/refs") {
      const query = new URLSearchParams(input.search);
      const service = query.get("service");
      if (query.size !== 1 || (service !== "git-upload-pack" && service !== "git-receive-pack")) return null;
    } else if (
      method !== "POST" ||
      input.search !== "" ||
      (operation !== "git-upload-pack" && operation !== "git-receive-pack")
    ) {
      return null;
    }
    return {
      kind: "git",
      upstreamUrl: `https://github.com/${repository.owner}/${repository.name}.git/${operation}${input.search}`,
    };
  }

  const apiPrefix = `api/repos/${repository.owner}/${repository.name}`;
  if (!path.toLowerCase().startsWith(apiPrefix.toLowerCase())) return null;
  const requestedPrefix = path.slice(0, apiPrefix.length);
  if (requestedPrefix.toLowerCase() !== apiPrefix.toLowerCase()) return null;
  const remainder = path.slice(apiPrefix.length);
  if (remainder && !remainder.startsWith("/")) return null;
  if (!isAllowedRepositoryApi(method, remainder)) return null;
  return {
    kind: "api",
    upstreamUrl: `https://api.github.com/repos/${repository.owner}/${repository.name}${remainder}${input.search}`,
  };
}

function parseRepositoryFullName(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2 || !SAFE_OWNER.test(parts[0] ?? "") || !SAFE_REPOSITORY.test(parts[1] ?? "")) return null;
  return { owner: parts[0]!, name: parts[1]! };
}

function unsafePath(pathname: string): boolean {
  return pathname.length > 1_024 || pathname.includes("%") || pathname.includes("\\") || pathname.includes("\0") ||
    pathname.includes("//") || pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function isAllowedRepositoryApi(method: string, path: string): boolean {
  if ((method === "GET" || method === "HEAD") && path === "") return true;
  if (method === "GET" || method === "HEAD") {
    return /^\/(?:contents|commits|branches|tags)(?:\/.*)?$/.test(path) ||
      /^\/git\/(?:blobs|trees|commits|refs)(?:\/.*)?$/.test(path) ||
      /^\/compare\/[A-Za-z0-9._/-]+\.\.\.[A-Za-z0-9._/-]+$/.test(path);
  }
  if (method === "PUT" || method === "DELETE") return /^\/contents\/.+/.test(path);
  if (method === "POST") return /^\/git\/(?:blobs|trees|commits|refs)$/.test(path) || path === "/merges";
  if (method === "PATCH") return /^\/git\/refs\/.+/.test(path);
  return false;
}
