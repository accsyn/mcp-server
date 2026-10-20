export interface AccsynCredentials {
  workspace: string;
  username: string;
  apiKey: string;
}

/** Credentials the accsyn session reads. All three are required. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): AccsynCredentials {
  const workspace = env.ACCSYN_WORKSPACE?.trim() ?? "";
  const username = env.ACCSYN_API_USER?.trim() ?? "";
  const apiKey = env.ACCSYN_API_KEY?.trim() ?? "";
  const missing = [
    !workspace ? "ACCSYN_WORKSPACE" : "",
    !username ? "ACCSYN_API_USER" : "",
    !apiKey ? "ACCSYN_API_KEY" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")}. Set them in the MCP server env.`);
  }
  return { workspace, username, apiKey };
}
