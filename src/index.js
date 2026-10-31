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

function buildUpstreamUrl(pathname, search) {
  if (pathname === "/token") {
    const target = new URL(`https://${AUTH_HOST}/token`);
    target.search = search;
    return target;
  }

  if (pathname === "/v2" || pathname.startsWith("/v2/")) {
    return new URL(`${pathname}${search}`, `https://${REGISTRY_HOST}`);
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
  const services = url.searchParams.getAll("service");
  if (services.some((service) => service !== REGISTRY_SERVICE)) {
    return "Unsupported token service";
  }

  // This is a pull-only mirror. Never let a visitor use the configured
  // upstream account to mint push/delete-capable registry tokens.
  for (const scope of url.searchParams.getAll("scope")) {
    const match = /^repository:([^:]+):pull$/.exec(scope);
    if (!match) return "Only repository pull scopes are supported";
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

    const upstreamUrl = buildUpstreamUrl(url.pathname, url.search);
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
