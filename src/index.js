const REGISTRY_HOST = "registry-1.docker.io";
const AUTH_HOST = "auth.docker.io";
const REGISTRY_SERVICE = "registry.docker.io";
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const PRIVATE_FORWARDING_HEADERS = [
  "cf-connecting-ip",
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "cookie",
];

function stripHopByHopHeaders(headers) {
  // RFC 9110: Connection may nominate additional hop-by-hop headers.
  const connectionTokens = headers.get("connection");
  if (connectionTokens) {
    for (const token of connectionTokens.split(",")) {
      const name = token.trim();
      if (name) headers.delete(name);
    }
  }

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
}

const ALLOWED_TOKEN_QUERY_PARAMS = new Set([
  "service",
  "scope",
  "client_id",
  "account",
  // Accepted for Docker-client compatibility, but deliberately not forwarded.
  "offline_token",
]);

// Docker repository path components: lowercase alphanumerics with the
// separators permitted by Docker's repository-name convention.
const REPOSITORY_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const PULL_SCOPE_PATTERN = new RegExp(
  `^repository:${REPOSITORY_COMPONENT}(?:/${REPOSITORY_COMPONENT})*:pull$`,
);

function buildUpstreamUrl(url, env = {}) {
  if (url.pathname === "/token") {
    // Never derive the upstream hostname or path from user input.
    const target = new URL(`https://${AUTH_HOST}/token`);
    target.searchParams.set("service", REGISTRY_SERVICE);

    // Forward only validated, required token parameters.
    for (const scope of url.searchParams.getAll("scope")) {
      target.searchParams.append("scope", scope);
    }

    const clientId = url.searchParams.get("client_id");
    if (clientId) target.searchParams.set("client_id", clientId);

    // If operator credentials are configured, keep the account parameter
    // consistent with the account whose PAT is used for the token exchange.
    const configuredUsername = env.DOCKERHUB_USERNAME?.trim();
    const account = configuredUsername || url.searchParams.get("account");
    if (account) target.searchParams.set("account", account);

    // Do not forward offline_token=true. The client gets a short-lived
    // bearer token; future token requests are authenticated again by this
    // Worker with its PAT. This avoids issuing a long-lived refresh token.
    return target;
  }

  if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
    return new URL(`${url.pathname}${url.search}`, `https://${REGISTRY_HOST}`);
  }

  return null;
}

function rewriteAuthChallenge(value, publicOrigin) {
  return value.replace(
    /https:\/\/auth\.docker\.io\/token/gi,
    `${publicOrigin}/token`,
  );
}

function rewriteRegistryLocation(value, publicOrigin) {
  try {
    const target = new URL(value);
    if (
      target.protocol === "https:" &&
      target.hostname.toLowerCase() === REGISTRY_HOST
    ) {
      return `${publicOrigin}${target.pathname}${target.search}${target.hash}`;
    }
  } catch {
    // Keep relative or non-URL Location values unchanged.
  }

  // In particular, leave Docker Hub's external blob/CDN redirects intact.
  return value;
}

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function buildBasicAuthorization(username, token) {
  // TextEncoder keeps this safe for UTF-8 input instead of assuming ASCII.
  const bytes = new TextEncoder().encode(`${username}:${token}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function validateTokenRequest(url) {
  const params = url.searchParams;

  if (url.search.length > 4096) {
    return "Token query is too large";
  }

  const services = params.getAll("service");
  if (services.length !== 1 || services[0] !== REGISTRY_SERVICE) {
    return "A single supported token service is required";
  }

  // Reject unknown parameters instead of forwarding arbitrary token-service
  // options. offline_token is recognized for client compatibility but is
  // stripped by buildUpstreamUrl so no long-lived refresh token is issued.
  for (const key of params.keys()) {
    if (!ALLOWED_TOKEN_QUERY_PARAMS.has(key)) {
      return "Unsupported token parameter";
    }
  }

  const scopes = params.getAll("scope");
  if (scopes.length > 8) {
    return "Too many token scopes";
  }

  // Docker's /v2/ ping may request a service token without a repository scope.
  // If scopes are present, every one must be a single-repository pull scope.
  for (const scope of scopes) {
    if (scope.length > 512 || !PULL_SCOPE_PATTERN.test(scope)) {
      return "Only repository pull scopes are supported";
    }
  }

  for (const name of ["client_id", "account", "offline_token"]) {
    if (params.getAll(name).length > 1) {
      return `Duplicate ${name} parameter`;
    }
  }

  for (const name of ["client_id", "account"]) {
    const value = params.get(name);
    if (value && (value.length > 128 || /[\u0000-\u001F\u007F]/.test(value))) {
      return `Invalid ${name} parameter`;
    }
  }

  const offlineToken = params.get("offline_token");
  if (offlineToken !== null && offlineToken !== "true" && offlineToken !== "false") {
    return "Invalid offline_token parameter";
  }

  return null;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);

    // A small root health response is useful when setting up the hostname.
    if (url.pathname === "/" && ALLOWED_METHODS.has(request.method)) {
      return textResponse("Docker Hub Worker Proxy is running.\n", 200);
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return textResponse("Method Not Allowed\n", 405, {
        allow: "GET, HEAD",
      });
    }

    const isTokenRequest = url.pathname === "/token";
    if (isTokenRequest) {
      const validationError = validateTokenRequest(url);
      if (validationError) {
        return textResponse(`${validationError}\n`, 400);
      }
    }

    const upstreamUrl = buildUpstreamUrl(url, env);
    if (!upstreamUrl) {
      return textResponse("Not Found\n", 404);
    }

    const requestHeaders = new Headers(request.headers);
    stripHopByHopHeaders(requestHeaders);

    // The outbound Host is derived from the fixed upstream URL.
    requestHeaders.delete("host");

    // Do not forward visitor IP or browser cookie headers to Docker Hub.
    for (const name of PRIVATE_FORWARDING_HEADERS) {
      requestHeaders.delete(name);
    }

    // Optional operator-provided credentials are used only for the token
    // exchange. They override client-supplied auth so every anonymous client
    // can use the operator's authenticated Docker Hub pull allowance.
    // Store both values as Cloudflare Worker Secrets, never in wrangler.toml.
    const username = env.DOCKERHUB_USERNAME?.trim();
    const token = env.DOCKERHUB_TOKEN?.trim();

    if (isTokenRequest) {
      console.log("[Docker Hub Auth]", {
        usernameConfigured: Boolean(username),
        tokenConfigured: Boolean(token),
        authenticationEnabled: Boolean(username && token),
        mode: username && token ? "authenticated" : "anonymous",
      });
    }

    if (isTokenRequest && username && token) {
      requestHeaders.set(
        "authorization",
        buildBasicAuthorization(username, token),
      );
    }

    try {
      const upstreamResponse = await fetch(
        new Request(upstreamUrl, {
          method: request.method,
          headers: requestHeaders,
          redirect: "manual",
          cache: "no-store",
        }),
      );

      const responseHeaders = new Headers(upstreamResponse.headers);
      stripHopByHopHeaders(responseHeaders);

      const publicOrigin = `https://${url.host}`;

      // Docker Engine follows the Bearer challenge. Point its token request
      // back through this Worker instead of exposing auth.docker.io to clients.
      const challenge = responseHeaders.get("www-authenticate");
      if (challenge) {
        responseHeaders.set(
          "www-authenticate",
          rewriteAuthChallenge(challenge, publicOrigin),
        );
      }

      // Rewrite redirects to the Registry host, but preserve external CDN
      // redirects so large image layers can be downloaded directly by Docker.
      const location = responseHeaders.get("location");
      if (location) {
        responseHeaders.set(
          "location",
          rewriteRegistryLocation(location, publicOrigin),
        );
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    } catch (error) {
      // Log details to the Worker logs, but do not expose internal error data.
      console.error("Docker Hub upstream request failed", error);
      return textResponse("Bad Gateway\n", 502);
    }
  },
};
