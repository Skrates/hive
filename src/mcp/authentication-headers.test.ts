import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationHeaderError,
  AuthenticationResponseInterceptor,
  AuthenticationResponseStager,
  authenticationResponseHeaderNames,
  type AuthenticationHeaderRoute,
  type AuthenticationSecretRecord,
  type AuthenticationSecretSink,
} from "./authentication-headers.js";
import { AUTHENTICATION_HEADER_MANIFEST } from "./schemas.js";

type ResponseEntry = (typeof AUTHENTICATION_HEADER_MANIFEST.responseHeaders)[number];

test("generated manifest is the exact closed eight-header response set", () => {
  assert.equal(AUTHENTICATION_HEADER_MANIFEST.responseHeaders.length, 8);
  assert.equal(new Set(authenticationResponseHeaderNames()).size, 8);
  assert.deepEqual(
    AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders.map((entry) => entry.name),
    ["Hive-Expired-Live-Injection-Capability"],
  );
  assert.equal(manifestPaths().length, 11);
});

test("all eleven canonical method and result-variant paths stage and intercept", async () => {
  for (const [index, path] of manifestPaths().entries()) {
    const route: AuthenticationHeaderRoute = {
      server: path.entry.server,
      method: path.method,
      resultVariant: path.resultVariant,
    };
    const canary = `canonical-path-${index}`;
    const stager = new AuthenticationResponseStager(route.server);
    const staged = await stager.run(methodRequest(route.method), async () => {
      stager.stage(path.entry.name, route, canary);
      return successfulResponse(route.resultVariant);
    });
    const sink = new RecordingSink();
    const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
      methodRequest(route.method),
      { responseKey: `canonical:${index}` },
    );
    const intercepted = await pending.intercept(staged);
    assert.equal(intercepted.headers.get(path.entry.name), null);
    assert.deepEqual(sink.records[0], {
      server: route.server,
      method: route.method,
      resultVariant: route.resultVariant,
      responseKey: `canonical:${index}`,
      headerName: path.entry.name,
      value: canary,
    });
  }
});

test("server staging emits every canary only on its registered successful result variant", async () => {
  for (const [index, path] of manifestPaths().entries()) {
    const entry = path.entry;
    const stager = new AuthenticationResponseStager(entry.server);
    const route: AuthenticationHeaderRoute = {
      server: entry.server,
      method: path.method,
      resultVariant: path.resultVariant,
    };
    const canary = `server-canary-${index}`;
    const response = await stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant);
    });
    assert.equal(response.headers.get(entry.name), canary, entry.name);
    assert.equal((await response.json() as ResultBody).result.structuredContent.resultVariant, route.resultVariant);

    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, canary);
        return successfulResponse("wrong_variant");
      }),
      AuthenticationHeaderError,
      `${entry.name} wrong result variant`,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, canary);
        return errorResponse();
      }),
      AuthenticationHeaderError,
      `${entry.name} error response`,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, canary);
        return successfulResponse(route.resultVariant, {}, {}, 2);
      }),
      AuthenticationHeaderError,
      `${entry.name} mismatched response id`,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, canary);
        return successfulResponse(route.resultVariant, {}, {}, 1, false, 202);
      }),
      AuthenticationHeaderError,
      `${entry.name} notification-only status`,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () =>
        successfulResponse(route.resultVariant)),
      AuthenticationHeaderError,
      `${entry.name} omitted staging`,
    );
    assert.throws(
      () => stager.stage(entry.name, { ...route, method: "hive.wrong" }, canary),
      AuthenticationHeaderError,
    );
  }
});

test("server staging rejects preexisting, duplicate, comma-joined, and cross-route Hive headers", async () => {
  const entries = AUTHENTICATION_HEADER_MANIFEST.responseHeaders;
  for (const path of manifestPaths()) {
    const route: AuthenticationHeaderRoute = {
      server: path.entry.server,
      method: path.method,
      resultVariant: path.resultVariant,
    };
    const stager = new AuthenticationResponseStager(route.server);
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(path.entry.name, route, "one");
        stager.stage(path.entry.name, route, "two");
        return successfulResponse(route.resultVariant);
      }),
      AuthenticationHeaderError,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(path.entry.name, route, "one,two");
        return successfulResponse(route.resultVariant);
      }),
      AuthenticationHeaderError,
    );
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () =>
        successfulResponse(route.resultVariant, { [path.entry.name]: "unstaged" })),
      AuthenticationHeaderError,
    );
    const duplicateHeaders = new Headers();
    duplicateHeaders.append(path.entry.name, "one");
    duplicateHeaders.append(path.entry.name, "two");
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () =>
        successfulResponse(route.resultVariant, duplicateHeaders)),
      AuthenticationHeaderError,
    );
    const wrongEntry = entries.find((entry) => entry.name !== path.entry.name)!;
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(wrongEntry.name, route, "wrong-header-for-route");
        return successfulResponse(route.resultVariant);
      }),
      AuthenticationHeaderError,
    );
  }
});

test("server staging binds edge credential mint and rotate to the actual request", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((candidate) =>
    candidate.name === "Hive-Edge-Credential")!;
  for (const [requestMethod, stagedMethod] of [
    ["hive.edge_credential.mint", "hive.edge_credential.rotate"],
    ["hive.edge_credential.rotate", "hive.edge_credential.mint"],
  ] as const) {
    const stager = new AuthenticationResponseStager("broker");
    await assert.rejects(
      () => stager.run(methodRequest(requestMethod), async () => {
        stager.stage(entry.name, {
          server: "broker",
          method: stagedMethod,
          resultVariant: "new_bearer_committed",
        }, "credential-canary");
        return successfulResponse("new_bearer_committed");
      }),
      AuthenticationHeaderError,
    );
  }
});

test("server and client seams are bound to broker versus edge-control direction", async () => {
  const edgeEntry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[7]!;
  const edgeRoute = routeFor(edgeEntry);
  const brokerStager = new AuthenticationResponseStager("broker");
  await assert.rejects(
    () => brokerStager.run(methodRequest(edgeRoute.method), async () => {
      brokerStager.stage(edgeEntry.name, edgeRoute, "cross-direction");
      return successfulResponse(edgeRoute.resultVariant);
    }),
    AuthenticationHeaderError,
  );

  const sink = new RecordingSink();
  const pending = await new AuthenticationResponseInterceptor("broker", sink).bind(
    methodRequest(edgeRoute.method),
    { responseKey: "direction:1" },
  );
  await assert.rejects(
    () => pending.intercept(
      successfulResponse(edgeRoute.resultVariant, { [edgeEntry.name]: "cross-direction" }),
    ),
    AuthenticationHeaderError,
  );
  assert.equal(sink.records.length, 0);
});

test("AsyncLocalStorage staging cannot cross parallel requests", async () => {
  const stager = new AuthenticationResponseStager("broker");
  const first = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const second = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[1]!;
  const firstRoute = routeFor(first);
  const secondRoute = routeFor(second);
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();

  const firstResponse = stager.run(methodRequest(firstRoute.method), async () => {
    stager.stage(first.name, firstRoute, "parallel-first");
    await firstGate.promise;
    return successfulResponse(firstRoute.resultVariant);
  });
  const secondResponse = stager.run(methodRequest(secondRoute.method), async () => {
    stager.stage(second.name, secondRoute, "parallel-second");
    await secondGate.promise;
    return successfulResponse(secondRoute.resultVariant);
  });
  secondGate.resolve();
  firstGate.resolve();

  const [firstResult, secondResult] = await Promise.all([firstResponse, secondResponse]);
  assert.equal(firstResult.headers.get(first.name), "parallel-first");
  assert.equal(firstResult.headers.get(second.name), null);
  assert.equal(secondResult.headers.get(second.name), "parallel-second");
  assert.equal(secondResult.headers.get(first.name), null);
});

test("client interception persists then strips all eleven registered paths", async () => {
  for (const [index, path] of manifestPaths().entries()) {
    const entry = path.entry;
    const route = {
      server: entry.server,
      method: path.method,
      resultVariant: path.resultVariant,
      responseKey: `response:${index}`,
    };
    const sink = new RecordingSink();
    const canary = `client-canary-${index}`;
    const response = await interceptAuthenticationResponse(
      successfulResponse(route.resultVariant, { [entry.name]: canary }),
      route,
      sink,
    );
    assert.equal(response.headers.get(entry.name), null, entry.name);
    assert.equal(sink.records.length, 1, entry.name);
    assert.deepEqual(sink.records[0], {
      ...route,
      headerName: entry.name,
      value: canary,
    });
    assert.equal((await response.text()).includes(canary), false);
  }
});

test("client interception blocks delivery until the registered owner-only sink commits", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = { ...routeFor(entry), responseKey: "barrier:1" };
  const gate = deferred<void>();
  let resolved = false;
  const interception = interceptAuthenticationResponse(
    successfulResponse(route.resultVariant, { [entry.name]: "barrier-canary" }),
    route,
    { async persist() { await gate.promise; } },
  ).then((response) => {
    resolved = true;
    return response;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  gate.resolve();
  const response = await interception;
  assert.equal(response.headers.get(entry.name), null);
});

test("client interception fails closed before persistence for missing, wrong, or error-path headers", async () => {
  const entries = AUTHENTICATION_HEADER_MANIFEST.responseHeaders;
  const requestOnly = AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders[0]!.name;
  for (const [index, path] of manifestPaths().entries()) {
    const entry = path.entry;
    const route = {
      server: entry.server,
      method: path.method,
      resultVariant: path.resultVariant,
      responseKey: `negative:${index}`,
    };
    for (const wrongEntry of entries) {
      if (wrongEntry.name === entry.name) continue;
      const sink = new RecordingSink();
      await assert.rejects(
        () => interceptAuthenticationResponse(
          successfulResponse(route.resultVariant, { [wrongEntry.name]: "wrong-route-canary" }),
          route,
          sink,
        ),
        AuthenticationHeaderError,
      );
      assert.equal(sink.records.length, 0);
    }

    const duplicateHeaders = new Headers();
    duplicateHeaders.append(entry.name, "one");
    duplicateHeaders.append(entry.name, "two");
    for (const headers of [
      {},
      { [entry.name]: "one,two" },
      { [requestOnly]: "request-only" },
      { "Hive-Unknown-Capability": "unknown" },
      duplicateHeaders,
    ]) {
      const sink = new RecordingSink();
      await assert.rejects(
        () => interceptAuthenticationResponse(
          successfulResponse(route.resultVariant, headers),
          route,
          sink,
        ),
        AuthenticationHeaderError,
      );
      assert.equal(sink.records.length, 0);
    }

    const wrongVariantSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse("wrong_variant", { [entry.name]: "wrong-variant-canary" }),
        route,
        wrongVariantSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(wrongVariantSink.records.length, 0);

    const idMismatchSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(route.resultVariant, { [entry.name]: "id-mismatch-canary" }, {}, 2),
        route,
        idMismatchSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(idMismatchSink.records.length, 0);

    const reflectedSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(
          route.resultVariant,
          { [entry.name]: "path-reflection-canary" },
          { echoed: "path-reflection-canary" },
        ),
        route,
        reflectedSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(reflectedSink.records.length, 0);

    const invalidResultSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(
          route.resultVariant,
          { [entry.name]: "invalid-result-canary" },
          {},
          1,
          true,
        ),
        route,
        invalidResultSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(invalidResultSink.records.length, 0);

    const errorSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        errorResponse({ [entry.name]: "error-canary" }),
        route,
        errorSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(errorSink.records.length, 0);

    const acceptedNotificationSink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(
          route.resultVariant,
          { [entry.name]: "notification-status-canary" },
          {},
          1,
          false,
          202,
        ),
        route,
        acceptedNotificationSink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(acceptedNotificationSink.records.length, 0);
  }
});

test("client binding rejects reserve-spawn sibling header and result swaps", async () => {
  const launch = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((entry) =>
    entry.name === "Hive-Headless-Launch-Capability")!;
  const noReservation = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((entry) =>
    entry.name === "Hive-Headless-No-Reservation")!;
  for (const [headerName, resultVariant] of [
    [launch.name, noReservation.resultVariants[0]],
    [noReservation.name, launch.resultVariants[0]],
  ] as const) {
    const sink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(resultVariant, { [headerName]: "sibling-swap-canary" }),
        {
          server: "broker",
          method: "hive.delivery.reserve_spawn",
          resultVariant,
          responseKey: `sibling:${resultVariant}`,
        },
        sink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0);
  }
});

test("client binding captures one tools/call request and is one-shot", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((candidate) =>
    candidate.name === "Hive-Edge-Credential")!;
  const interceptor = new AuthenticationResponseInterceptor("broker", new RecordingSink());
  for (const request of [
    jsonRpcRequest({ jsonrpc: "2.0", method: "tools/call", params: { name: entry.method } }),
    jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "resources/read", params: {} }),
    jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
  ]) {
    await assert.rejects(
      () => interceptor.bind(request, { responseKey: "binding:invalid" }),
      AuthenticationHeaderError,
    );
  }
  await assert.rejects(
    () => interceptor.bind(methodRequest(entry.method), { responseKey: " invalid" }),
    AuthenticationHeaderError,
  );

  const sink = new RecordingSink();
  const pending = await new AuthenticationResponseInterceptor("broker", sink).bind(
    methodRequest("hive.edge_credential.rotate"),
    { responseKey: "binding:rotate" },
  );
  const response = successfulResponse("new_bearer_committed", {
    [entry.name]: "bound-rotate-canary",
  });
  await pending.intercept(response);
  assert.equal(sink.records[0]?.method, "hive.edge_credential.rotate");
  await assert.rejects(
    () => pending.intercept(successfulResponse("new_bearer_committed", {
      [entry.name]: "bound-rotate-canary",
    })),
    AuthenticationHeaderError,
  );
  assert.equal(sink.records.length, 1);
});

test("malformed results, response-id mismatch, and reflected canaries fail before emission or persistence", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  const canary = "reflection-canary";
  const stager = new AuthenticationResponseStager(route.server);

  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant, {}, { echoed: canary });
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant, { "x-debug": canary });
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant, { [`x-${canary}`]: "safe" });
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return escapedSecretResponse(route.resultVariant, canary);
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return statusTextSecretResponse(route.resultVariant, canary);
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent: {} } })),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant, {}, {}, 2);
    }),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, canary);
      return successfulResponse(route.resultVariant, {}, {}, 1, true);
    }),
    AuthenticationHeaderError,
  );
  for (const resultType of [undefined, "input_required"] as const) {
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, canary);
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [],
            ...(resultType === undefined ? {} : { resultType }),
            structuredContent: { resultVariant: route.resultVariant },
          },
        });
      }),
      AuthenticationHeaderError,
    );
  }

  for (const malformed of [
    successfulResponse(route.resultVariant, { [entry.name]: canary }, { echoed: canary }),
    successfulResponse(route.resultVariant, {
      [entry.name]: canary,
      "x-debug": canary,
    }),
    successfulResponse(route.resultVariant, {
      [entry.name]: canary,
      [`x-${canary}`]: "safe",
    }),
    successfulResponse(route.resultVariant, { [entry.name]: canary }, {}, 2),
    successfulResponse(route.resultVariant, { [entry.name]: canary }, {}, 1, true),
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: "not-an-array",
        structuredContent: { resultVariant: route.resultVariant },
      },
    }, { headers: { [entry.name]: canary } }),
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [],
        isError: "not-a-boolean",
        resultType: "complete",
        structuredContent: { resultVariant: route.resultVariant },
      },
    }, { headers: { [entry.name]: canary } }),
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [],
        structuredContent: { resultVariant: route.resultVariant },
      },
    }, { headers: { [entry.name]: canary } }),
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [],
        resultType: "input_required",
        structuredContent: { resultVariant: route.resultVariant },
      },
    }, { headers: { [entry.name]: canary } }),
    escapedSecretResponse(route.resultVariant, canary, { [entry.name]: canary }),
    statusTextSecretResponse(route.resultVariant, canary, { [entry.name]: canary }),
    new Response(JSON.stringify({
      result: { structuredContent: { resultVariant: route.resultVariant } },
    }), {
      headers: {
        "content-type": "application/json",
        [entry.name]: canary,
      },
    }),
    new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { resultVariant: route.resultVariant } },
    }), {
      headers: {
        "content-type": "application/json-evil",
        [entry.name]: canary,
      },
    }),
  ]) {
    const sink = new RecordingSink();
    const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
      methodRequest(route.method),
      { responseKey: "malformed:1" },
    );
    await assert.rejects(
      () => pending.intercept(malformed),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0);
  }
});

test("sink idempotency gives exact replay one record and changed replay a conflict", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = { ...routeFor(entry), responseKey: "replay:1" };
  const sink = new IdempotentSink();
  for (let index = 0; index < 2; index += 1) {
    await interceptAuthenticationResponse(
      successfulResponse(route.resultVariant, { [entry.name]: "stable-canary" }),
      route,
      sink,
    );
  }
  assert.equal(sink.records.size, 1);
  await assert.rejects(
    () => interceptAuthenticationResponse(
      successfulResponse(route.resultVariant, { [entry.name]: "changed-canary" }),
      route,
      sink,
    ),
    /secret_replay_conflict/,
  );
  assert.equal(sink.records.get(route.responseKey), "stable-canary");
});

function routeFor(entry: ResponseEntry): AuthenticationHeaderRoute {
  return {
    server: entry.server,
    method: entry.method,
    resultVariant: entry.resultVariants[0],
  };
}

function manifestPaths(): Array<{
  entry: ResponseEntry;
  method: string;
  resultVariant: string;
}> {
  return AUTHENTICATION_HEADER_MANIFEST.responseHeaders.flatMap((entry) => {
    const alternateMethods = "alternateMethods" in entry ? entry.alternateMethods : [];
    const methods = [entry.method, ...alternateMethods];
    return methods.flatMap((method) =>
      entry.resultVariants.map((resultVariant) => ({ entry, method, resultVariant })));
  });
}

async function interceptAuthenticationResponse(
  response: Response,
  route: AuthenticationHeaderRoute & { readonly responseKey: string },
  sink: AuthenticationSecretSink,
): Promise<Response> {
  const interceptor = new AuthenticationResponseInterceptor(route.server, sink);
  const pending = await interceptor.bind(
    methodRequest(route.method),
    { responseKey: route.responseKey },
  );
  return pending.intercept(response);
}

function methodRequest(method: string): Request {
  return jsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: method, arguments: {} },
  });
}

function jsonRpcRequest(body: unknown): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ResultBody {
  readonly result: {
    readonly structuredContent: {
      readonly resultVariant: string;
    };
  };
}

function successfulResponse(
  resultVariant: string,
  headers: Headers | Readonly<Record<string, string>> = {},
  structuredContent: Readonly<Record<string, unknown>> = {},
  id: string | number = 1,
  isError = false,
  status = 200,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        content: [],
        resultType: "complete",
        ...(isError ? { isError: true } : {}),
        structuredContent: { resultVariant, safe: true, ...structuredContent },
      },
    },
    { status, headers },
  );
}

function errorResponse(headers: Readonly<Record<string, string>> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "Internal error." } },
    { status: 500, headers },
  );
}

function escapedSecretResponse(
  resultVariant: string,
  secret: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const first = secret.codePointAt(0);
  assert.notEqual(first, undefined);
  const escaped = `\\u${first!.toString(16).padStart(4, "0")}${secret.slice(1)}`;
  const body = `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"resultVariant":${JSON.stringify(resultVariant)},"echoed":"${escaped}"}}}`;
  assert.equal(body.includes(secret), false);
  return new Response(body, {
    headers: { "content-type": "application/json", ...headers },
  });
}

function statusTextSecretResponse(
  resultVariant: string,
  secret: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [],
      resultType: "complete",
      structuredContent: { resultVariant },
    },
  }), {
    status: 200,
    statusText: secret,
    headers: { "content-type": "application/json", ...headers },
  });
}

class RecordingSink implements AuthenticationSecretSink {
  readonly records: AuthenticationSecretRecord[] = [];

  async persist(record: AuthenticationSecretRecord): Promise<void> {
    this.records.push(record);
  }
}

class IdempotentSink implements AuthenticationSecretSink {
  readonly records = new Map<string, string>();

  async persist(record: AuthenticationSecretRecord): Promise<void> {
    const existing = this.records.get(record.responseKey);
    if (existing !== undefined && existing !== record.value) {
      throw new Error("secret_replay_conflict");
    }
    this.records.set(record.responseKey, record.value);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
