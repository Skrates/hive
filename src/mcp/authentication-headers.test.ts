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
import {
  AUTHENTICATION_HEADER_MANIFEST,
  MCP_CONFORMANCE_MANIFEST,
} from "./schemas.js";

type ResponseEntry = (typeof AUTHENTICATION_HEADER_MANIFEST.responseHeaders)[number];

test("generated manifest is the exact closed eight-header response set", () => {
  assert.equal(AUTHENTICATION_HEADER_MANIFEST.responseHeaders.length, 8);
  assert.equal(new Set(authenticationResponseHeaderNames()).size, 8);
  assert.deepEqual(
    AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders.map((entry) => entry.name),
    ["Hive-Expired-Live-Injection-Capability"],
  );
  assert.deepEqual(AUTHENTICATION_HEADER_MANIFEST.secretFreeResults, [{
    server: "broker",
    method: "hive.delivery.claim",
    resultVariants: ["no_claimable_delivery"],
    canonicalResult: {
      content: [],
      resultType: "complete",
      structuredContent: { resultVariant: "no_claimable_delivery" },
    },
  }]);
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

test("bound interception permits validated secret-free outcomes and still blocks authority leaks", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((candidate) =>
    candidate.name === "Hive-Dispatch-Capability")!;
  const route = routeFor(entry);
  const secretFreeVariant = "no_claimable_delivery";

  const sink = new RecordingSink();
  const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
    methodRequest(route.method),
    { responseKey: "claim:empty" },
  );
  const passed = await pending.intercept(secretFreeClaimResponse());
  const passedBody = await passed.json() as ResultBody;
  assert.equal(passed.status, 200);
  assert.equal(passed.headers.has(entry.name), false);
  assert.equal(passedBody.result.structuredContent.resultVariant, secretFreeVariant);
  assert.equal(sink.records.length, 0);

  const unexpectedSink = new RecordingSink();
  const unexpected = await new AuthenticationResponseInterceptor(route.server, unexpectedSink).bind(
    methodRequest(route.method),
    { responseKey: "claim:empty-with-authority" },
  );
  await assert.rejects(
    () => unexpected.intercept(secretFreeClaimResponse({
      [entry.name]: "unexpected-empty-queue-authority",
    })),
    AuthenticationHeaderError,
  );
  assert.equal(unexpectedSink.records.length, 0);

  const otherEntry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((candidate) =>
    candidate.name === "Hive-Edge-Credential")!;
  const crossRouteSink = new RecordingSink();
  const crossRoute = await new AuthenticationResponseInterceptor(route.server, crossRouteSink).bind(
    methodRequest(route.method),
    { responseKey: "claim:cross-route-secret-variant" },
  );
  await assert.rejects(
    () => crossRoute.intercept(successfulResponse(otherEntry.resultVariants[0]!, {}, {
      credential: "must-not-release-cross-route-credential",
    })),
    AuthenticationHeaderError,
  );
  assert.equal(crossRouteSink.records.length, 0);

  const unknownVariantSink = new RecordingSink();
  const unknownVariant = await new AuthenticationResponseInterceptor(
    route.server,
    unknownVariantSink,
  ).bind(
    methodRequest(route.method),
    { responseKey: "claim:unknown-secret-free-variant" },
  );
  await assert.rejects(
    () => unknownVariant.intercept(successfulResponse(
      "credential_committed_unregistered",
      {},
      { credential: "must-not-release-unregistered-credential" },
    )),
    AuthenticationHeaderError,
  );
  assert.equal(unknownVariantSink.records.length, 0);

  const allowlistedPayloadSink = new RecordingSink();
  const allowlistedPayload = await new AuthenticationResponseInterceptor(
    route.server,
    allowlistedPayloadSink,
  ).bind(
    methodRequest(route.method),
    { responseKey: "claim:allowlisted-label-secret-payload" },
  );
  await assert.rejects(
    () => allowlistedPayload.intercept(secretFreeClaimResponse({}, {
      credential: "must-not-release-under-allowlisted-label",
    })),
    AuthenticationHeaderError,
  );
  assert.equal(allowlistedPayloadSink.records.length, 0);

  const serverStager = new AuthenticationResponseStager(route.server);
  const serverSecretFree = await serverStager.run(
    methodRequest(route.method),
    async () => secretFreeClaimResponse(),
  );
  assert.equal(
    (await serverSecretFree.json() as ResultBody).result.structuredContent.resultVariant,
    secretFreeVariant,
  );
  await assert.rejects(
    () => serverStager.run(
      methodRequest(route.method),
      async () => successfulResponse("credential_committed_unregistered", {}, {
        credential: "must-not-release-server-unregistered-credential",
      }),
    ),
    AuthenticationHeaderError,
  );
  await assert.rejects(
    () => serverStager.run(
      methodRequest(route.method),
      async () => secretFreeClaimResponse({}, {
        credential: "must-not-release-server-allowlisted-payload",
      }),
    ),
    AuthenticationHeaderError,
  );

  const requestSecret = "empty-queue-request-secret";
  const reflectedSink = new RecordingSink();
  const reflected = await new AuthenticationResponseInterceptor(route.server, reflectedSink).bind(
    methodRequest(route.method, { headers: { authorization: `Bearer ${requestSecret}` } }),
    { responseKey: "claim:empty-reflection" },
  );
  await assert.rejects(
    () => reflected.intercept(secretFreeClaimResponse({}, {
      echoed: requestSecret,
    })),
    AuthenticationHeaderError,
  );
  assert.equal(reflectedSink.records.length, 0);
});

test("client interception rejects ambiguous or malformed JSON content type before persistence", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  for (const [index, contentType] of [
    "application/json; charset=utf-8, text/plain",
    "application/json;charset=utf-8;charset=ascii",
    "application/json;bad",
    "application/json;=x",
    'application/json;profile="unterminated',
  ].entries()) {
    const route = { ...routeFor(entry), responseKey: `malformed-content-type:${index}` };
    const sink = new RecordingSink();
    await assert.rejects(
      () => interceptAuthenticationResponse(
        successfulResponse(route.resultVariant, {
          [entry.name]: "malformed-content-type-canary",
          "content-type": contentType,
        }),
        route,
        sink,
      ),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0, contentType);
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
  const missingProtocolHeader = methodRequest(entry.method);
  missingProtocolHeader.headers.delete("mcp-protocol-version");
  for (const request of [
    methodRequest(entry.method, { headers: { "content-type": "text/plain" } }),
    methodRequest(entry.method, {
      headers: { "content-type": "application/json; charset=utf-8, text/plain" },
    }),
    methodRequest(entry.method, {
      headers: { "content-type": "application/json;charset=utf-8;charset=ascii" },
    }),
    methodRequest(entry.method, { headers: { "content-type": "application/json;bad" } }),
    methodRequest(entry.method, {
      headers: { "content-type": 'application/json;profile="unterminated' },
    }),
    methodRequest(entry.method, { headers: { accept: "application/json" } }),
    methodRequest(entry.method, {
      headers: { accept: "application/json;q=1;q=0, text/event-stream" },
    }),
    methodRequest(entry.method, {
      headers: { accept: "application/json;q=.5, text/event-stream" },
    }),
    methodRequest(entry.method, { headers: { "mcp-method": "resources/read" } }),
    methodRequest(entry.method, { headers: { "mcp-name": "hive.edge_credential.rotate" } }),
    missingProtocolHeader,
    methodRequest(entry.method, { headers: { "mcp-protocol-version": "2025-11-25" } }),
    methodRequest(entry.method, {
      headers: { authorization: "Bearer duplicate-alpha, Bearer duplicate-beta" },
    }),
    methodRequest(entry.method, {
      headers: { "Hive-Expired-Live-Injection-Capability": "duplicate-alpha, duplicate-beta" },
    }),
    methodRequest(entry.method, {
      body: {
        jsonrpc: "1.0",
        id: 1,
        method: "tools/call",
        params: {
          name: entry.method,
          arguments: {},
          _meta: finalEnvelope(),
        },
      },
    }),
    methodRequest(entry.method, {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: entry.method,
          arguments: [],
          _meta: finalEnvelope(),
        },
      },
    }),
    methodRequest(entry.method, {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: entry.method,
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion":
              MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion,
          },
        },
      },
    }),
  ]) {
    await assert.rejects(
      () => interceptor.bind(request, { responseKey: "binding:invalid-wire" }),
      AuthenticationHeaderError,
    );
  }

  const sink = new RecordingSink();
  const pending = await new AuthenticationResponseInterceptor("broker", sink).bind(
    methodRequest("hive.edge_credential.rotate", {
      headers: {
        "mcp-name": `=?base64?${Buffer.from("hive.edge_credential.rotate").toString("base64")}?=`,
      },
    }),
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

test("client binding returns the exact bounded request snapshot it authorizes", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  const template = methodRequest(route.method, {
    headers: { authorization: "Bearer pre-bind-secret-canary" },
  });
  const serialized = await template.text();
  const sourceBytes = new TextEncoder().encode(serialized);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sourceBytes);
      controller.close();
    },
  });
  const sourceRequest = new Request(template.url, {
    method: "POST",
    headers: template.headers,
    body: source,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const sink = new RecordingSink();
  const bound = await new AuthenticationResponseInterceptor(route.server, sink).bind(
    sourceRequest,
    { responseKey: "bounded-request:1" },
  );
  sourceRequest.headers.set("authorization", "Bearer post-bind-secret-canary");
  sourceBytes.fill(0x78);

  assert.equal(sourceRequest.bodyUsed, true);
  assert.equal(bound.request.headers.get("authorization"), "Bearer pre-bind-secret-canary");
  assert.equal(await bound.request.clone().text(), serialized);
  await assert.rejects(
    () => bound.intercept(successfulResponse(
      route.resultVariant,
      { [entry.name]: "bounded-response-secret" },
      { echoed: "pre-bind-secret-canary" },
    )),
    AuthenticationHeaderError,
  );
  assert.equal(sink.records.length, 0);

  let sourceCancelled = false;
  const openSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(serialized.slice(0, 32)));
    },
    cancel() {
      sourceCancelled = true;
    },
  });
  const openRequest = new Request(template.url, {
    method: "POST",
    headers: template.headers,
    body: openSource,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await rejectsWithin(
    new AuthenticationResponseInterceptor(route.server, new RecordingSink()).bind(
      openRequest,
      { responseKey: "bounded-request:open" },
    ),
    1_500,
    AuthenticationHeaderError,
  );
  assert.equal(sourceCancelled, true);
});

test("authority-bearing responses reject every non-identity content encoding", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  for (const [index, contentEncoding] of [
    "gzip",
    "identity, gzip",
    "identity;level=0",
  ].entries()) {
    const sink = new RecordingSink();
    const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
      methodRequest(route.method),
      { responseKey: `encoded-response:${index}` },
    );
    await assert.rejects(
      () => pending.intercept(successfulResponse(route.resultVariant, {
        [entry.name]: "encoded-response-secret",
        "content-encoding": contentEncoding,
      })),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0, contentEncoding);

    const stager = new AuthenticationResponseStager(route.server);
    await assert.rejects(
      () => stager.run(methodRequest(route.method), async () => {
        stager.stage(entry.name, route, "encoded-staged-secret");
        return successfulResponse(route.resultVariant, { "content-encoding": contentEncoding });
      }),
      AuthenticationHeaderError,
    );
  }
});

test("client and server authority seams reject invalid UTF-8 request bytes", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  await assert.rejects(
    () => new AuthenticationResponseInterceptor(route.server, new RecordingSink()).bind(
      invalidUtf8MethodRequest(route.method),
      { responseKey: "invalid-utf8-request:client" },
    ),
    AuthenticationHeaderError,
  );

  let handlerCalled = false;
  const stager = new AuthenticationResponseStager(route.server);
  await assert.rejects(
    () => stager.run(invalidUtf8MethodRequest(route.method), async () => {
      handlerCalled = true;
      return successfulResponse(route.resultVariant);
    }),
    AuthenticationHeaderError,
  );
  assert.equal(handlerCalled, false);
});

test("client binding protects every request credential and removed session metadata", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders.find((candidate) =>
    candidate.name === "Hive-Edge-Credential")!;
  const route = routeFor(entry);
  for (const [headerName, headerValue] of [
    ["authorization", "Bearer outbound-request-secret"],
    ["Hive-Expired-Live-Injection-Capability", "outbound-expired-grant-secret"],
  ] as const) {
    const sink = new RecordingSink();
    const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
      methodRequest(route.method, { headers: { [headerName]: headerValue } }),
      { responseKey: `request-secret:${headerName}` },
    );
    const reflected = headerName === "authorization"
      ? "outbound-request-secret"
      : headerValue;
    await assert.rejects(
      () => pending.intercept(successfulResponse(
        route.resultVariant,
        { [entry.name]: "new-response-secret" },
        { echoed: reflected },
      )),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0, headerName);
  }

  for (const removedHeader of ["Mcp-Session-Id", "Last-Event-ID"]) {
    const sink = new RecordingSink();
    const pending = await new AuthenticationResponseInterceptor(route.server, sink).bind(
      methodRequest(route.method),
      { responseKey: `removed-session:${removedHeader}` },
    );
    await assert.rejects(
      () => pending.intercept(successfulResponse(route.resultVariant, {
        [entry.name]: "new-response-secret",
        [removedHeader]: "legacy-session-canary",
      })),
      AuthenticationHeaderError,
    );
    assert.equal(sink.records.length, 0, removedHeader);
  }

  const nestedRequestSecret = "nested-outbound-request-secret";
  const nestedSink = new RecordingSink();
  const nestedPending = await new AuthenticationResponseInterceptor(route.server, nestedSink).bind(
    methodRequest(route.method, {
      headers: { authorization: `Bearer ${nestedRequestSecret}` },
    }),
    { responseKey: "request-secret:nested-response-header" },
  );
  await assert.rejects(
    () => nestedPending.intercept(successfulResponse(route.resultVariant, {
      [entry.name]: `prefix-${nestedRequestSecret}-suffix`,
    })),
    AuthenticationHeaderError,
  );
  assert.equal(nestedSink.records.length, 0);

  const statusCollisionSink = new RecordingSink();
  await assert.rejects(
    () => new AuthenticationResponseInterceptor(route.server, statusCollisionSink).bind(
      methodRequest(route.method, { headers: { authorization: "Bearer 200" } }),
      { responseKey: "request-secret:status-collision" },
    ),
    AuthenticationHeaderError,
  );
  assert.equal(statusCollisionSink.records.length, 0);

  let statusCollisionHandlerCalled = false;
  await assert.rejects(
    () => new AuthenticationResponseStager(route.server).run(
      methodRequest(route.method, { headers: { authorization: "Bearer 200" } }),
      async () => {
        statusCollisionHandlerCalled = true;
        return successfulResponse(route.resultVariant);
      },
    ),
    AuthenticationHeaderError,
  );
  assert.equal(statusCollisionHandlerCalled, false);

  const responseStatusSink = new RecordingSink();
  const responseStatusPending = await new AuthenticationResponseInterceptor(
    route.server,
    responseStatusSink,
  ).bind(methodRequest(route.method), { responseKey: "response-secret:status-collision" });
  await assert.rejects(
    () => responseStatusPending.intercept(successfulResponse(
      route.resultVariant,
      { [entry.name]: "200" },
    )),
    AuthenticationHeaderError,
  );
  assert.equal(responseStatusSink.records.length, 0);
});

test("server staging snapshots non-authorizing response metadata before delayed body pulls", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  const encoder = new TextEncoder();

  for (const fixture of [
    { status: 202, contentType: "application/json" },
    { status: 500, contentType: "application/json" },
    { status: 200, contentType: "text/plain" },
  ] as const) {
    const lateSecret = `late-unstaged-${fixture.status}-${fixture.contentType}`;
    let sourceResponse!: Response;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        sourceResponse.headers.set(entry.name, lateSecret);
        controller.enqueue(encoder.encode("non-authorizing response"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    sourceResponse = new Response(source, {
      status: fixture.status,
      headers: { "content-type": fixture.contentType },
    });

    const returned = await new AuthenticationResponseStager(route.server).run(
      methodRequest(route.method),
      async () => sourceResponse,
    );
    assert.equal(returned.headers.get(entry.name), null);
    assert.equal(await returned.text(), "non-authorizing response");
    assert.equal(sourceResponse.headers.get(entry.name), lateSecret);
    assert.equal(returned.headers.get(entry.name), null);
  }
});

test("authority inspection is bounded and scans duplicate members before persistence", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);

  const duplicateSecret = "duplicate-auth-canary";
  const duplicateBody = `{"jsonrpc":"2.0","id":1,"result":{"content":[],"resultType":"complete","structuredContent":{"resultVariant":${JSON.stringify(route.resultVariant)},"echoed":"\\u0064uplicate-auth-canary","echoed":"safe"}}}`;
  const duplicateSink = new RecordingSink();
  const duplicatePending = await new AuthenticationResponseInterceptor(route.server, duplicateSink)
    .bind(methodRequest(route.method), { responseKey: "duplicate-member:1" });
  await assert.rejects(
    () => duplicatePending.intercept(new Response(duplicateBody, {
      headers: { "content-type": "application/json", [entry.name]: duplicateSecret },
    })),
    AuthenticationHeaderError,
  );
  assert.equal(duplicateSink.records.length, 0);

  let sourceCancelled = false;
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":'));
    },
    cancel() {
      sourceCancelled = true;
    },
  });
  const openSink = new RecordingSink();
  const openPending = await new AuthenticationResponseInterceptor(route.server, openSink).bind(
    methodRequest(route.method),
    { responseKey: "open-body:1" },
  );
  await rejectsWithin(
    openPending.intercept(new Response(open, {
      headers: { "content-type": "application/json", [entry.name]: "open-secret" },
    })),
    1_500,
    AuthenticationHeaderError,
  );
  assert.equal(sourceCancelled, true);
  assert.equal(openSink.records.length, 0);

  const oversized = successfulResponse(
    route.resultVariant,
    { [entry.name]: "oversized-secret" },
    { padding: "x".repeat(1_048_576) },
  );
  const oversizedSink = new RecordingSink();
  const oversizedPending = await new AuthenticationResponseInterceptor(route.server, oversizedSink)
    .bind(methodRequest(route.method), { responseKey: "oversized-body:1" });
  await assert.rejects(
    () => oversizedPending.intercept(oversized),
    AuthenticationHeaderError,
  );
  assert.equal(oversizedSink.records.length, 0);
});

test("authority validation and emission use one immutable body snapshot", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  const encoder = new TextEncoder();

  const clientSecret = "client-mutable-wire-canary";
  const clientPlaceholder = "x".repeat(clientSecret.length);
  const clientSerialized = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [],
      resultType: "complete",
      structuredContent: {
        resultVariant: route.resultVariant,
        echoed: clientPlaceholder,
      },
    },
  });
  const clientBytes = encoder.encode(clientSerialized);
  const clientOffset = clientSerialized.indexOf(clientPlaceholder);
  assert.notEqual(clientOffset, -1);
  const clientSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(clientBytes);
      controller.close();
    },
  });
  const mutatingSink: AuthenticationSecretSink = {
    async persist() {
      clientBytes.set(encoder.encode(clientSecret), clientOffset);
    },
  };
  const pending = await new AuthenticationResponseInterceptor(route.server, mutatingSink).bind(
    methodRequest(route.method),
    { responseKey: "immutable-client:1" },
  );
  const intercepted = await pending.intercept(new Response(clientSource, {
    headers: {
      "content-type": "application/json",
      [entry.name]: clientSecret,
    },
  }));
  const clientWire = await intercepted.text();
  assert.equal(intercepted.headers.has(entry.name), false);
  assert.equal(clientWire.includes(clientSecret), false);
  assert.equal(clientWire.includes(clientPlaceholder), true);

  const serverSecret = "server-mutable-wire-canary";
  const serverPlaceholder = "y".repeat(serverSecret.length);
  const serverSerialized = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [],
      resultType: "complete",
      structuredContent: {
        resultVariant: route.resultVariant,
        echoed: serverPlaceholder,
      },
    },
  });
  const serverBytes = encoder.encode(serverSerialized);
  const serverOffset = serverSerialized.indexOf(serverPlaceholder);
  assert.notEqual(serverOffset, -1);
  const serverSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(serverBytes);
      controller.close();
    },
  });
  const stager = new AuthenticationResponseStager(route.server);
  const staged = await stager.run(methodRequest(route.method), async () => {
    stager.stage(entry.name, route, serverSecret);
    return new Response(serverSource, { headers: { "content-type": "application/json" } });
  });
  serverBytes.set(encoder.encode(serverSecret), serverOffset);
  const serverWire = await staged.text();
  assert.equal(staged.headers.get(entry.name), serverSecret);
  assert.equal(serverWire.includes(serverSecret), false);
  assert.equal(serverWire.includes(serverPlaceholder), true);
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
      return escapedSecretResponse(route.resultVariant, canary, {}, "key");
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
    escapedSecretResponse(route.resultVariant, canary, { [entry.name]: canary }, "key"),
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
    AuthenticationHeaderError,
  );
  assert.equal(sink.records.get(route.responseKey)?.value, "stable-canary");

  const differentEntry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[1]!;
  const differentRoute = { ...routeFor(differentEntry), responseKey: route.responseKey };
  await assert.rejects(
    () => interceptAuthenticationResponse(
      successfulResponse(differentRoute.resultVariant, {
        [differentEntry.name]: "stable-canary",
      }),
      differentRoute,
      sink,
    ),
    AuthenticationHeaderError,
  );
});

test("sink failure consumes the binding and fresh exact replay can retry", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = { ...routeFor(entry), responseKey: "replay:after-sink-failure" };
  const sink = new FailOnceIdempotentSink();
  const interceptor = new AuthenticationResponseInterceptor(route.server, sink);
  const first = await interceptor.bind(methodRequest(route.method), {
    responseKey: route.responseKey,
  });
  const response = () => successfulResponse(route.resultVariant, {
    [entry.name]: "retry-canary",
  });
  await assert.rejects(
    () => first.intercept(response()),
    (error: unknown) => {
      assert.ok(error instanceof AuthenticationHeaderError);
      assert.equal(error.message, "invalid_authentication_response_header");
      assert.equal(String(error).includes("retry-canary"), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  await assert.rejects(() => first.intercept(response()), AuthenticationHeaderError);
  assert.equal(sink.records.size, 0);

  const second = await interceptor.bind(methodRequest(route.method), {
    responseKey: route.responseKey,
  });
  const stripped = await second.intercept(response());
  assert.equal(stripped.headers.has(entry.name), false);
  assert.equal(sink.records.get(route.responseKey)?.value, "retry-canary");

  const exactReplay = await interceptor.bind(methodRequest(route.method), {
    responseKey: route.responseKey,
  });
  await exactReplay.intercept(response());
  assert.equal(sink.records.size, 1);
});

test("server staging collapses a post-staging handler exception", async () => {
  const entry = AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0]!;
  const route = routeFor(entry);
  const secret = "staged-handler-throw-canary";
  const stager = new AuthenticationResponseStager(route.server);
  await assert.rejects(
    () => stager.run(methodRequest(route.method), async () => {
      stager.stage(entry.name, route, secret);
      throw new Error(`handler failed with ${secret} at /owner/private/store`);
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthenticationHeaderError);
      assert.equal(error.message, "invalid_authentication_response_header");
      assert.equal(String(error).includes(secret), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );
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

function methodRequest(
  method: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Request {
  const body = options.body ?? {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: method,
      arguments: {},
      _meta: finalEnvelope(),
    },
  };
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion,
      "mcp-method": "tools/call",
      "mcp-name": method,
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

function invalidUtf8MethodRequest(method: string): Request {
  const marker = "invalid-utf8-note";
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: method,
      arguments: { note: marker },
      _meta: finalEnvelope(),
    },
  });
  const bytes = new TextEncoder().encode(body);
  const markerOffset = body.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  bytes[markerOffset] = 0xff;
  const template = methodRequest(method);
  return new Request(template.url, {
    method: "POST",
    headers: template.headers,
    body: bytes,
  });
}

function finalEnvelope(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion":
      MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
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

function secretFreeClaimResponse(
  headers: Headers | Readonly<Record<string, string>> = {},
  structuredContent: Readonly<Record<string, unknown>> = {},
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [],
        resultType: "complete",
        structuredContent: {
          resultVariant: "no_claimable_delivery",
          ...structuredContent,
        },
      },
    },
    { headers },
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
  placement: "key" | "value" = "value",
): Response {
  const first = secret.codePointAt(0);
  assert.notEqual(first, undefined);
  const escaped = `\\u${first!.toString(16).padStart(4, "0")}${secret.slice(1)}`;
  const reflected = placement === "key"
    ? `"${escaped}":"safe"`
    : `"echoed":"${escaped}"`;
  const body = `{"jsonrpc":"2.0","id":1,"result":{"content":[],"resultType":"complete","structuredContent":{"resultVariant":${JSON.stringify(resultVariant)},${reflected}}}}`;
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

async function rejectsWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timed_out_waiting_for_rejection")), timeoutMs);
        }),
      ]),
      expected,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class RecordingSink implements AuthenticationSecretSink {
  readonly records: AuthenticationSecretRecord[] = [];

  async persist(record: AuthenticationSecretRecord): Promise<void> {
    this.records.push(record);
  }
}

class IdempotentSink implements AuthenticationSecretSink {
  readonly records = new Map<string, AuthenticationSecretRecord>();

  async persist(record: AuthenticationSecretRecord): Promise<void> {
    const existing = this.records.get(record.responseKey);
    if (existing !== undefined && !recordsEqual(existing, record)) {
      throw new Error("secret_replay_conflict");
    }
    this.records.set(record.responseKey, Object.freeze({ ...record }));
  }
}

class FailOnceIdempotentSink extends IdempotentSink {
  private failed = false;

  override async persist(record: AuthenticationSecretRecord): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error(`injected_sink_failure:${record.value}:/owner/private/store`);
    }
    await super.persist(record);
  }
}

function recordsEqual(
  left: AuthenticationSecretRecord,
  right: AuthenticationSecretRecord,
): boolean {
  return left.server === right.server
    && left.method === right.method
    && left.resultVariant === right.resultVariant
    && left.responseKey === right.responseKey
    && left.headerName === right.headerName
    && left.value === right.value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
