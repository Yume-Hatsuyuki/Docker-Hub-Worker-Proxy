import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("root endpoint returns a health response without contacting upstream", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const response = await worker.fetch(
    new Request("https://mirror.example.test/"),
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /is running/);
});

test("Registry V2 Bearer challenge is rewritten to the configured mirror host", async () => {
  globalThis.fetch = async () =>
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        "docker-distribution-api-version": "registry/2.0",
      },
    });

  const response = await worker.fetch(
    new Request("https://mirror.example.test/v2/"),
  );

  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer realm="https://mirror.example.test/token",service="registry.docker.io"',
  );
});

test("token requests are sent only to auth.docker.io and preserve query and auth headers", async () => {
  let capturedUrl;
  let capturedHeaders;

  globalThis.fetch = async (input) => {
    capturedUrl = new URL(input.url);
    capturedHeaders = new Headers(input.headers);
    return Response.json({ token: "test-token" });
  };

  const response = await worker.fetch(
    new Request(
      "https://mirror.example.test/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
      { headers: { authorization: "Basic dGVzdDp0ZXN0" } },
    ),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(capturedUrl.hostname, "auth.docker.io");
  assert.equal(capturedUrl.pathname, "/token");
  assert.equal(capturedUrl.searchParams.get("service"), "registry.docker.io");
  assert.equal(
    capturedUrl.searchParams.get("scope"),
    "repository:library/alpine:pull",
  );
  assert.equal(capturedHeaders.get("authorization"), "Basic dGVzdDp0ZXN0");
});

test("external blob CDN redirects are passed through unchanged", async () => {
  const cdnLocation =
    "https://production.cloudflare.docker.com/registry-v2/docker/registry/v2/blobs/sha256/test";

  globalThis.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: { location: cdnLocation },
    });

  const response = await worker.fetch(
    new Request("https://mirror.example.test/v2/library/alpine/blobs/sha256:test"),
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), cdnLocation);
});

test("redirects back to the Registry host are rewritten to the mirror host", async () => {
  globalThis.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: {
        location: "https://registry-1.docker.io/v2/library/alpine/manifests/latest?x=1",
      },
    });

  const response = await worker.fetch(
    new Request("https://mirror.example.test/v2/library/alpine/manifests/latest"),
  );

  assert.equal(
    response.headers.get("location"),
    "https://mirror.example.test/v2/library/alpine/manifests/latest?x=1",
  );
});

test("unsupported paths are not forwarded to arbitrary hosts", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const response = await worker.fetch(
    new Request("https://mirror.example.test/proxy/https://attacker.example/"),
  );

  assert.equal(response.status, 404);
});

test("write methods are rejected", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const response = await worker.fetch(
    new Request("https://mirror.example.test/v2/", { method: "POST" }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("hop-by-hop and visitor-identifying request headers are stripped", async () => {
  let capturedHeaders;

  globalThis.fetch = async (input) => {
    capturedHeaders = new Headers(input.headers);
    return new Response("{}", { status: 200 });
  };

  await worker.fetch(
    new Request("https://mirror.example.test/v2/", {
      headers: {
        connection: "x-internal-hop, keep-alive",
        "x-internal-hop": "remove-me",
        "x-forwarded-for": "203.0.113.10",
        "cf-connecting-ip": "203.0.113.10",
        cookie: "session=private",
        authorization: "Bearer preserve-me",
      },
    }),
  );

  assert.equal(capturedHeaders.has("x-internal-hop"), false);
  assert.equal(capturedHeaders.has("connection"), false);
  assert.equal(capturedHeaders.has("x-forwarded-for"), false);
  assert.equal(capturedHeaders.has("cf-connecting-ip"), false);
  assert.equal(capturedHeaders.has("cookie"), false);
  assert.equal(capturedHeaders.get("authorization"), "Bearer preserve-me");
});


test("configured Docker Hub credentials are injected only into token requests", async () => {
  let capturedUrl;
  let capturedHeaders;

  globalThis.fetch = async (input) => {
    capturedUrl = new URL(input.url);
    capturedHeaders = new Headers(input.headers);
    return Response.json({ token: "upstream-token" });
  };

  await worker.fetch(
    new Request(
      "https://mirror.example.test/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
      { headers: { authorization: "Basic client-supplied" } },
    ),
    {
      DOCKERHUB_USERNAME: "operator-user",
      DOCKERHUB_TOKEN: "operator-pat",
    },
  );

  assert.equal(capturedUrl.hostname, "auth.docker.io");
  assert.equal(
    capturedHeaders.get("authorization"),
    `Basic ${btoa("operator-user:operator-pat")}`,
  );
});

test("configured Docker Hub credentials are never sent to Registry requests", async () => {
  let capturedUrl;
  let capturedHeaders;

  globalThis.fetch = async (input) => {
    capturedUrl = new URL(input.url);
    capturedHeaders = new Headers(input.headers);
    return new Response("{}", { status: 200 });
  };

  await worker.fetch(
    new Request("https://mirror.example.test/v2/library/alpine/manifests/latest"),
    {
      DOCKERHUB_USERNAME: "operator-user",
      DOCKERHUB_TOKEN: "operator-pat",
    },
  );

  assert.equal(capturedUrl.hostname, "registry-1.docker.io");
  assert.equal(capturedHeaders.has("authorization"), false);
});

test("partial upstream credential configuration does not inject Basic auth", async () => {
  let capturedHeaders;

  globalThis.fetch = async (input) => {
    capturedHeaders = new Headers(input.headers);
    return Response.json({ token: "anonymous-token" });
  };

  await worker.fetch(
    new Request(
      "https://mirror.example.test/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
    ),
    { DOCKERHUB_USERNAME: "operator-user" },
  );

  assert.equal(capturedHeaders.has("authorization"), false);
});

test("token endpoint rejects non-pull scopes", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const response = await worker.fetch(
    new Request(
      "https://mirror.example.test/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull%2Cpush",
    ),
    {
      DOCKERHUB_USERNAME: "operator-user",
      DOCKERHUB_TOKEN: "operator-pat",
    },
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Only repository pull scopes/);
});

test("token endpoint rejects non-Docker-Hub token services", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const response = await worker.fetch(
    new Request("https://mirror.example.test/token?service=other.example"),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unsupported token service/);
});
