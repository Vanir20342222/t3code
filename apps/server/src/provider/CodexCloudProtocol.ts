import * as NodeHttp2 from "node:http2";

const ORIGIN = "https://codex-cloud-backend.chatgpt.com";
const MAX_BYTES = 64 * 1024 * 1024;

type Field = { readonly tag: number; readonly value: Buffer | bigint };

const varint = (input: bigint): Buffer => {
  const bytes: number[] = [];
  let value = input;
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
};

// Field numbers follow codex-rs/cloud-client's native ThreadService envelopes.
export const cloudMessage = (
  ...fields: ReadonlyArray<readonly [number, string | Buffer | number]>
) =>
  Buffer.concat(
    fields.map(([tag, value]) => {
      if (typeof value === "number")
        return Buffer.concat([varint(BigInt(tag * 8)), varint(BigInt(value))]);
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      return Buffer.concat([varint(BigInt(tag * 8 + 2)), varint(BigInt(bytes.length)), bytes]);
    }),
  );

export function cloudFields(bytes: Buffer): Field[] {
  let offset = 0;
  const read = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error("Truncated cloud protobuf.");
      const byte = bytes[offset++]!;
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
    }
    throw new Error("Invalid cloud protobuf varint.");
  };
  const result: Field[] = [];
  while (offset < bytes.length) {
    const key = Number(read());
    const tag = Math.floor(key / 8);
    if (!tag) throw new Error("Invalid cloud protobuf tag.");
    switch (key % 8) {
      case 0:
        result.push({ tag, value: read() });
        break;
      case 2: {
        const size = Number(read());
        if (!Number.isSafeInteger(size) || size > bytes.length - offset)
          throw new Error("Truncated cloud protobuf field.");
        result.push({ tag, value: bytes.subarray(offset, offset + size) });
        offset += size;
        break;
      }
      case 1:
        offset += 8;
        break;
      case 5:
        offset += 4;
        break;
      default:
        throw new Error("Unsupported cloud protobuf wire type.");
    }
    if (offset > bytes.length) throw new Error("Truncated cloud protobuf field.");
  }
  return result;
}

const nested = (bytes: Buffer, tag: number): Buffer => {
  const value = cloudFields(bytes).findLast((field) => field.tag === tag)?.value;
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
};
const text = (bytes: Buffer, tag: number): string => nested(bytes, tag).toString("utf8");
const integer = (bytes: Buffer, tag: number) => {
  const value = cloudFields(bytes).findLast((field) => field.tag === tag)?.value;
  return typeof value === "bigint" ? Number(value) : undefined;
};

const fileChanges = (bytes: Buffer) =>
  cloudFields(bytes).flatMap((field) => {
    if (field.tag !== 1 || !Buffer.isBuffer(field.value)) return [];
    const change = field.value;
    const kind = cloudFields(nested(change, 2)).findLast(
      (field) => field.tag >= 1 && field.tag <= 3,
    );
    const operation =
      kind?.tag === 1
        ? ("add" as const)
        : kind?.tag === 2
          ? ("delete" as const)
          : kind?.tag === 3
            ? ("update" as const)
            : ("unknown" as const);
    const movePath = kind?.tag === 3 && Buffer.isBuffer(kind.value) ? text(kind.value, 1) : "";
    return [
      {
        path: text(change, 3),
        diff: text(change, 1),
        operation,
        ...(movePath ? { movePath } : {}),
      },
    ];
  });

export type CodexCloudEvent =
  | {
      readonly type: "text";
      readonly itemId: string;
      readonly text: string;
      readonly complete: boolean;
    }
  | { readonly type: "activity"; readonly title: string; readonly detail: string }
  | { readonly type: "turn"; readonly id: string; readonly status: number; readonly error: string }
  | {
      readonly type: "files";
      readonly itemId: string;
      readonly turnId: string;
      readonly complete: boolean;
      readonly changes: ReturnType<typeof fileChanges>;
    }
  | { readonly type: "approval" };

export function decodeCloudEvent(bytes: Buffer): CodexCloudEvent | undefined {
  if (nested(bytes, 2).length) return { type: "approval" };
  const notification = cloudFields(nested(bytes, 1)).findLast(
    (field) => field.tag >= 1 && field.tag <= 89,
  );
  if (!notification || !Buffer.isBuffer(notification.value)) return;
  const params = nested(notification.value, 2);
  if (notification.tag === 21 || notification.tag === 23) {
    const turn = nested(params, 2);
    return {
      type: "turn",
      id: text(turn, 4),
      status: integer(turn, 8) ?? 0,
      error: text(nested(turn, 3), 3),
    };
  }
  if (notification.tag === 32)
    return { type: "text", itemId: text(params, 2), text: text(params, 1), complete: false };
  if (notification.tag === 40)
    return {
      type: "files",
      itemId: text(params, 2),
      turnId: text(params, 4),
      complete: false,
      changes: fileChanges(nested(params, 1)),
    };
  if (notification.tag === 27 || notification.tag === 31) {
    const item = nested(params, notification.tag === 27 ? 1 : 2);
    const agent = nested(item, 3);
    if (agent.length)
      return {
        type: "text",
        itemId: text(agent, 2),
        text: text(agent, 6),
        complete: notification.tag === 31,
      };
    const command = nested(item, 7);
    if (command.length)
      return { type: "activity", title: text(command, 2), detail: text(command, 1) };
    const files = nested(item, 8);
    if (files.length)
      return {
        type: "files",
        itemId: text(files, 2),
        turnId: text(params, 4),
        complete: notification.tag === 31,
        changes: fileChanges(nested(files, 1)),
      };
  }
}

export interface CodexCloudCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

/** The cloud's own slug, or undefined for the placeholder models shown before the catalog loads. */
export const cloudNativeModel = (model: string | undefined) =>
  model && model !== "cloud" && model !== "default" ? model : undefined;

export function makeCodexCloudProtocol(credentials: CodexCloudCredentials) {
  const messages = async function* (
    method: string,
    payload: Buffer,
    signal?: AbortSignal,
    ready?: { resolve: () => void; reject: (cause: unknown) => void },
  ) {
    if (payload.length > MAX_BYTES)
      throw new Error("Codex Cloud request exceeds the message size limit.");
    const session = NodeHttp2.connect(ORIGIN);
    // Session errors are also delivered to the request; never expose auth headers in diagnostics.
    session.on("error", () => {});
    const request = session.request(
      {
        ":method": "POST",
        ":path": `/oaiproto.codex_app_server_backend.ThreadService/${method}`,
        "content-type": "application/grpc",
        te: "trailers",
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
      },
      signal ? { signal } : undefined,
    );
    let status: string | undefined;
    request.on("response", (headers) => {
      if (
        headers[":status"] !== 200 ||
        !String(headers["content-type"]).startsWith("application/grpc")
      ) {
        request.destroy(new Error("Codex Cloud rejected the connection."));
        return;
      }
      if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"]);
      if (status !== undefined && status !== "0") {
        request.destroy(new Error(`Codex Cloud RPC failed (${status}). No request was retried.`));
        return;
      }
      if (method === "Attach") request.setTimeout(0);
      ready?.resolve();
    });
    request.on("error", (cause) => ready?.reject(cause));
    request.on("trailers", (headers) => {
      status = String(headers["grpc-status"] ?? "");
    });
    request.setTimeout(150_000, () =>
      request.destroy(
        new Error("Codex Cloud connection timed out. The remote turn may still be running."),
      ),
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    request.end(Buffer.concat([header, payload]));
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of request) {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        while (pending.length >= 5) {
          const size = pending.readUInt32BE(1);
          if (pending[0] !== 0 || size > MAX_BYTES)
            throw new Error("Unsupported Codex Cloud response frame.");
          if (pending.length < size + 5) break;
          yield pending.subarray(5, size + 5);
          pending = pending.subarray(size + 5);
        }
        if (pending.length > MAX_BYTES + 5) throw new Error("Oversized Codex Cloud response.");
      }
      if (pending.length || status !== "0")
        throw new Error(
          `Codex Cloud RPC failed (${status ?? "missing status"}). No request was retried.`,
        );
    } finally {
      request.close();
      session.destroy();
    }
  };
  const unary = async (method: string, payload: Buffer, signal?: AbortSignal) => {
    const responses: Buffer[] = [];
    for await (const response of messages(method, payload, signal)) {
      if (responses.length) throw new Error("Invalid Codex Cloud unary response.");
      responses.push(response);
    }
    if (responses.length !== 1) throw new Error("Invalid Codex Cloud unary response.");
    return responses[0]!;
  };
  return {
    prewarm: async (model: string | undefined, environment?: string, signal?: AbortSignal) => {
      const managed = environment ? cloudMessage([1, environment]) : Buffer.alloc(0);
      const response = await unary(
        "Prewarm",
        cloudMessage(
          [10, cloudMessage([1, cloudMessage([1, managed])])],
          [28, cloudMessage([1, "codex"])],
          ...(model ? [[15, model] as const] : []),
        ),
        signal,
      );
      const id = text(nested(response, 14), 14);
      if (!id) throw new Error("Codex Cloud returned no thread ID. Do not automatically resubmit.");
      return { id, model: text(response, 7), cwd: text(response, 4) };
    },
    resume: (id: string, signal?: AbortSignal) =>
      unary("Resume", cloudMessage([1, id], [2, 1]), signal),
    /**
     * Omitted settings inherit the thread's. A null service tier clears it back to Standard.
     * Codex marks these as user turns, the only kind whose settings the cloud takes.
     */
    submit: async (
      id: string,
      messageId: string,
      prompt: string,
      settings: {
        readonly model?: string;
        readonly effort?: string;
        readonly serviceTier?: string | null;
      } = {},
      signal?: AbortSignal,
    ) => {
      const response = await unary(
        "AddUserMessage",
        cloudMessage(
          [4, messageId],
          ...(settings.effort ? [[9, settings.effort] as const] : []),
          [11, cloudMessage([1, cloudMessage([1, cloudMessage([1, prompt])])])],
          ...(settings.model ? [[12, settings.model] as const] : []),
          ...(settings.serviceTier === undefined
            ? []
            : [
                [
                  20,
                  settings.serviceTier === null
                    ? cloudMessage([2, Buffer.alloc(0)])
                    : cloudMessage([1, settings.serviceTier]),
                ] as const,
              ]),
          [23, id],
          [25, "user"],
          [30, 3],
        ),
        signal,
      );
      const turn = nested(response, 1);
      const turnId = text(turn, 4);
      if (!turnId)
        throw new Error(
          "Cloud accepted the request without a turn ID. Reopen it in Codex before sending again.",
        );
      return turnId;
    },
    interrupt: (id: string, turnId: string) =>
      unary("InterruptTurn", cloudMessage([1, id], [2, turnId])),
    attach: async (id: string, signal?: AbortSignal) => {
      const ready = Promise.withResolvers<void>();
      const source = messages("Attach", cloudMessage([1, id]), signal, ready);
      const first = source.next();
      // Start reading before submission so a short turn cannot outrun Attach.
      void first.catch(ready.reject);
      await ready.promise;
      return (async function* () {
        let next = await first;
        try {
          while (!next.done) {
            const event = decodeCloudEvent(next.value);
            if (event) yield event;
            next = await source.next();
          }
        } finally {
          await source.return();
        }
      })();
    },
  };
}

export type CodexCloudProtocol = ReturnType<typeof makeCodexCloudProtocol>;
