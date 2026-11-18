import * as NodeHttp2 from "node:http2";
import { expect, it, vi } from "vite-plus/test";
import {
  cloudFields,
  cloudMessage,
  decodeCloudEvent,
  makeCodexCloudProtocol,
} from "./CodexCloudProtocol.ts";

vi.mock("node:http2", async () => ({
  ...(await vi.importActual<typeof import("node:http2")>("node:http2")),
  connect: vi.fn(),
}));

it("rejects a denied attachment before a message can be sent and closes the transport", async () => {
  const real = await vi.importActual<typeof import("node:http2")>("node:http2");
  await using server = real.createServer();
  let calls = 0;
  server.on("stream", (stream, headers) => {
    calls += 1;
    expect(headers[":path"]).toBe("/oaiproto.codex_app_server_backend.ThreadService/Attach");
    stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "7" });
    stream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const clients: NodeHttp2.ClientHttp2Session[] = [];
  using _connect = vi.spyOn(NodeHttp2, "connect").mockImplementation(() => {
    const client = real.connect(`http://127.0.0.1:${address.port}`);
    clients.push(client);
    return client;
  });
  try {
    const client = makeCodexCloudProtocol({ accessToken: "test-token", accountId: "test-account" });
    await expect(client.attach("thread")).rejects.toThrow("7");
    expect(calls).toBe(1);
  } finally {
    for (const client of clients) client.destroy();
  }
});

it("sends chosen turn settings as a user turn, and none otherwise", async () => {
  const real = await vi.importActual<typeof import("node:http2")>("node:http2");
  await using server = real.createServer();
  const bodies: Buffer[] = [];
  server.on("stream", (stream) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      bodies.push(Buffer.concat(chunks).subarray(5));
      const reply = cloudMessage([1, cloudMessage([4, "turn-1"])]);
      const header = Buffer.alloc(5);
      header.writeUInt32BE(reply.length, 1);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.concat([header, reply]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const clients: NodeHttp2.ClientHttp2Session[] = [];
  using _connect = vi.spyOn(NodeHttp2, "connect").mockImplementation(() => {
    const client = real.connect(`http://127.0.0.1:${address.port}`);
    clients.push(client);
    return client;
  });
  try {
    const client = makeCodexCloudProtocol({ accessToken: "test-token", accountId: "test-account" });
    await expect(
      client.submit("thread", "message", "hello", {
        model: "gpt-6-luna",
        effort: "xhigh",
        serviceTier: "priority",
      }),
    ).resolves.toBe("turn-1");
    await expect(
      client.submit("thread", "message-2", "standard", { serviceTier: null }),
    ).resolves.toBe("turn-1");
    await expect(client.submit("thread", "message-3", "again")).resolves.toBe("turn-1");
    // Field 20 wraps the tier: 1 carries a name, an empty 2 clears it back to Standard.
    const settings = bodies.map((body) =>
      cloudFields(body)
        .filter((field) => [9, 12, 20, 25].includes(field.tag))
        .map((field) =>
          field.tag === 20 && Buffer.isBuffer(field.value)
            ? [20, cloudFields(field.value).map((inner) => [inner.tag, String(inner.value)])]
            : [field.tag, String(field.value)],
        ),
    );
    expect(settings).toEqual([
      [
        [9, "xhigh"],
        [12, "gpt-6-luna"],
        [20, [[1, "priority"]]],
        [25, "user"],
      ],
      [
        [20, [[2, ""]]],
        [25, "user"],
      ],
      [[25, "user"]],
    ]);
  } finally {
    for (const client of clients) client.destroy();
  }
});

it("decodes native reply deltas, terminal failures, and the final notification variant", () => {
  const delta = cloudMessage([
    1,
    cloudMessage([
      32,
      cloudMessage([2, cloudMessage([1, "hello"], [2, "item"], [3, "thread"], [4, "turn"])]),
    ]),
  ]);
  expect(decodeCloudEvent(delta)).toEqual({
    type: "text",
    itemId: "item",
    text: "hello",
    complete: false,
  });
  const failed = cloudMessage([
    23,
    cloudMessage([
      2,
      cloudMessage(
        [1, "thread"],
        [2, cloudMessage([3, cloudMessage([3, "Model unavailable"])], [4, "turn"], [8, 3])],
      ),
    ]),
  ]);
  expect(decodeCloudEvent(cloudMessage([1, failed]))).toEqual({
    type: "turn",
    id: "turn",
    status: 3,
    error: "Model unavailable",
  });
  expect(
    decodeCloudEvent(
      cloudMessage([1, Buffer.concat([failed, cloudMessage([89, Buffer.alloc(0)])])]),
    ),
  ).toBeUndefined();
  expect(decodeCloudEvent(cloudMessage([2, cloudMessage([1, "request"])]))).toEqual({
    type: "approval",
  });
  const changes = cloudMessage([
    1,
    cloudMessage(
      [1, "@@ -1 +1 @@\n-old\n+new\n"],
      [2, cloudMessage([3, cloudMessage([1, "/workspace/new.ts"])])],
      [3, "/workspace/old.ts"],
    ),
  ]);
  const patch = cloudMessage([
    1,
    cloudMessage([
      40,
      cloudMessage([2, cloudMessage([1, changes], [2, "patch"], [3, "thread"], [4, "turn"])]),
    ]),
  ]);
  expect(decodeCloudEvent(patch)).toEqual({
    type: "files",
    itemId: "patch",
    turnId: "turn",
    complete: false,
    changes: [
      {
        path: "/workspace/old.ts",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        operation: "update",
        movePath: "/workspace/new.ts",
      },
    ],
  });
  for (const hex of ["00", "0a05ff", "08ffffffffffffffffffffff", "0d01"]) {
    expect(() => cloudFields(Buffer.from(hex, "hex"))).toThrow();
  }
});
