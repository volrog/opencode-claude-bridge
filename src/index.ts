import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  refreshTokens,
} from "./oauth.js";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import {
  BETA_FLAGS,
  OAUTH_BETA_FLAG,
  ANTHROPIC_VERSION,
  STAINLESS_HEADERS,
  TOOL_PREFIX,
  USER_AGENT,
} from "./constants.js";

type AuthType = {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

type ProviderModel = {
  cost: unknown;
};

type PluginClient = {
  auth: {
    set: (args: {
      path: { id: string };
      body: Record<string, unknown>;
    }) => Promise<void>;
  };
};

/**
 * Layered token refresh: keychain → stored refresh → CLI refresh token
 */
async function refreshAuth(
  auth: AuthType,
  client: PluginClient,
): Promise<string | null> {
  let fresh: {
    access: string;
    refresh: string;
    expires: number;
  } | null = null;

  // Layer 1: Claude CLI keychain
  try {
    const keychainTokens = getClaudeTokens();
    if (keychainTokens && keychainTokens.expires > Date.now() + 60_000) {
      fresh = keychainTokens;
    }
  } catch {}

  // Layer 2: Stored refresh token
  if (!fresh && auth.refresh) {
    try {
      fresh = refreshTokens(auth.refresh);
    } catch {}
  }

  // Layer 3: CLI refresh token
  if (!fresh) {
    try {
      const creds = readClaudeCredentials();
      if (creds?.claudeAiOauth?.refreshToken) {
        fresh = refreshTokens(creds.claudeAiOauth.refreshToken);
      }
    } catch {}
  }

  if (fresh) {
    await client.auth.set({
      path: { id: "anthropic" },
      body: {
        type: "oauth",
        refresh: fresh.refresh,
        access: fresh.access,
        expires: fresh.expires,
      },
    });
    auth.access = fresh.access;
    auth.refresh = fresh.refresh;
    auth.expires = fresh.expires;
    return fresh.access;
  }

  return null;
}

const CLAUDE_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const AnthropicOAuthCombined = async ({ client }: { client: PluginClient }) => {
  return {
    // Prepend Claude Code identity (skip if already present from another plugin)
    "experimental.chat.system.transform": (
      input: { model?: { providerID: string } },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;
      const alreadyHas = output.system.some((s) => s.includes(CLAUDE_PREFIX));
      if (alreadyHas) return;
      if (output.system.length > 0) {
        output.system[0] = `${CLAUDE_PREFIX}\n\n${output.system[0]}`;
      } else {
        output.system.push(CLAUDE_PREFIX);
      }
    },

    auth: {
      provider: "anthropic",

      async loader(
        getAuth: () => Promise<AuthType>,
        provider: { models: Record<string, ProviderModel> },
      ) {
        let auth = await getAuth();

        // Auto-bootstrap: if no OAuth tokens stored, try Claude CLI keychain
        if (auth.type !== "oauth") {
          try {
            const keychainTokens = getClaudeTokens();
            if (keychainTokens) {
              console.error(
                "[opencode-oauth] Auto-synced credentials from Claude CLI",
              );
              await client.auth.set({
                path: { id: "anthropic" },
                body: {
                  type: "oauth",
                  refresh: keychainTokens.refresh,
                  access: keychainTokens.access,
                  expires: keychainTokens.expires,
                },
              });
              auth = {
                type: "oauth",
                access: keychainTokens.access,
                refresh: keychainTokens.refresh,
                expires: keychainTokens.expires,
              };
            }
          } catch {}
        }

        if (auth.type === "oauth") {
          // Zero out cost for Pro/Max subscription
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            };
          }

          // Clear env var so SDK doesn't use it over our OAuth token
          delete process.env.ANTHROPIC_API_KEY;

          return {
            authToken: auth.access,

            async fetch(
              input: string | URL | Request,
              init?: RequestInit,
            ) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);

              // Refresh if expired
              if (
                !auth.access ||
                !auth.expires ||
                auth.expires < Date.now()
              ) {
                await refreshAuth(auth, client);
              }

              // --- Build headers ---
              const headers = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((v, k) => headers.set(k, v));
              }
              if (init?.headers) {
                const h = init.headers;
                if (h instanceof Headers) {
                  h.forEach((v, k) => headers.set(k, v));
                } else if (Array.isArray(h)) {
                  for (const [k, v] of h) {
                    if (v !== undefined) headers.set(k, String(v));
                  }
                } else {
                  for (const [k, v] of Object.entries(h)) {
                    if (v !== undefined) headers.set(k, String(v));
                  }
                }
              }

              // OAuth Bearer auth
              headers.set("authorization", `Bearer ${auth.access}`);
              headers.delete("x-api-key");

              // Claude Code identity headers
              headers.set("user-agent", USER_AGENT);
              headers.set("x-app", "cli");
              headers.set("anthropic-version", ANTHROPIC_VERSION);
              headers.set(
                "anthropic-dangerous-direct-browser-access",
                "true",
              );

              // Stainless SDK platform headers
              for (const [k, v] of Object.entries(STAINLESS_HEADERS)) {
                headers.set(k, v);
              }
              if (!headers.has("x-stainless-retry-count")) {
                headers.set("x-stainless-retry-count", "0");
              }
              if (!headers.has("x-stainless-timeout")) {
                headers.set("x-stainless-timeout", "600");
              }

              // Beta flags: merge required + oauth + incoming
              const incoming = (headers.get("anthropic-beta") || "")
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);
              const required = BETA_FLAGS.split(",").map((b) => b.trim());
              headers.set(
                "anthropic-beta",
                [
                  ...new Set([...required, OAUTH_BETA_FLAG, ...incoming]),
                ].join(","),
              );

              // --- Transform request body ---
              let body = init?.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Required for interleaved-thinking beta
                  if (!parsed.thinking) {
                    parsed.thinking = { type: "adaptive" };
                  }

                  // Sanitize system prompt
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map(
                      (item: { type?: string; text?: string }) => {
                        if (item.type === "text" && item.text) {
                          let text = item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude");
                          // Deduplicate prefix (multiple plugins may add it)
                          while (
                            text.includes(
                              `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`,
                            )
                          ) {
                            text = text.replace(
                              `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`,
                              CLAUDE_PREFIX,
                            );
                          }
                          return { ...item, text };
                        }
                        return item;
                      },
                    );
                  }

                  // Prefix tool definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map(
                      (tool: { name?: string }) => ({
                        ...tool,
                        name:
                          tool.name && !tool.name.startsWith(TOOL_PREFIX)
                            ? `${TOOL_PREFIX}${tool.name}`
                            : tool.name,
                      }),
                    );
                  }

                  // Prefix tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map(
                      (msg: {
                        content?: Array<{ type?: string; name?: string }>;
                      }) => {
                        if (msg.content && Array.isArray(msg.content)) {
                          msg.content = msg.content.map(
                            (block: { type?: string; name?: string }) => {
                              if (
                                block.type === "tool_use" &&
                                block.name &&
                                !block.name.startsWith(TOOL_PREFIX)
                              ) {
                                return {
                                  ...block,
                                  name: `${TOOL_PREFIX}${block.name}`,
                                };
                              }
                              return block;
                            },
                          );
                        }
                        return msg;
                      },
                    );
                  }

                  body = JSON.stringify(parsed);
                } catch {}
              }

              // --- URL rewrite: add ?beta=true ---
              let requestInput: string | URL | Request = input;
              let requestUrl: URL | null = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const finalUrl =
                typeof requestInput === "string"
                  ? requestInput
                  : requestInput instanceof URL
                    ? requestInput.toString()
                    : requestInput.url;

              // --- Make request ---
              const outHeaders: Record<string, string> = {};
              headers.forEach((v, k) => {
                outHeaders[k] = v;
              });
              const response = await globalThis.fetch(finalUrl, {
                method: init?.method || "POST",
                body,
                headers: outHeaders,
                signal: init?.signal,
              });

              // Strip mcp_ prefix from streaming response
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }
                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },

      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth" as const,
          authorize: async () => {
            const tokens = getClaudeTokens();
            if (tokens) {
              console.error(
                "[opencode-oauth] Auto-authenticated via Claude CLI",
              );
              return {
                type: "success" as const,
                access: tokens.access,
                refresh: tokens.refresh,
                expires: tokens.expires,
              };
            }

            console.error(
              "[opencode-oauth] No Claude CLI found, starting browser OAuth...",
            );
            const { url, verifier } = createAuthorizationRequest();
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const cleanCode = parseAuthCode(code);
                  const exchanged = exchangeCodeForTokens(
                    cleanCode,
                    verifier,
                  );
                  return {
                    type: "success" as const,
                    access: exchanged.access,
                    refresh: exchanged.refresh,
                    expires: exchanged.expires,
                  };
                } catch (err) {
                  console.error(
                    `[opencode-oauth] Token exchange failed: ${err}`,
                  );
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api" as const,
        },
      ],
    },
  };
};

export default AnthropicOAuthCombined;
