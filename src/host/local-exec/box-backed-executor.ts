import type { JsonValue } from "@bufbuild/protobuf";
import { MethodKind, type ServiceType } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { ExecService } from "../../proto/generated/agent/v1/exec_service_connect.js";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientThrow,
  ExecServerMessage,
} from "../../proto/generated/agent/v1/exec_pb.js";
import { ReadArgs } from "../../proto/generated/agent/v1/read_exec_pb.js";
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.js";
import type { BoxExecEndpoint } from "../box/box-exec-endpoint.js";
import type {
  LocalExecDecodedMessage,
  LocalExecExecutor,
  LocalExecExecutorOutput,
} from "./local-exec-provider.js";

export interface BoxLocalExecFileStore {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
}

const BoxExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType;

function authorizationInterceptor(authToken: string): Interceptor {
  return next => async req => {
    req.header.set("Authorization", `Bearer ${authToken}`);
    return next(req);
  };
}

export function createBoxExecClient(endpoint: Pick<BoxExecEndpoint, "host" | "port" | "authToken">) {
  const transport = createConnectTransport({
    httpVersion: "1.1",
    baseUrl: `http://${endpoint.host}:${endpoint.port}`,
    interceptors: [authorizationInterceptor(endpoint.authToken)],
  });
  return createClient(BoxExecService, transport);
}

function asServerMessage(message: LocalExecDecodedMessage): ExecServerMessage {
  if (message instanceof ExecServerMessage) return message;
  return ExecServerMessage.fromJson({ id: message.id } as JsonValue, { ignoreUnknownFields: true });
}

export function createBoxBackedLocalExecExecutor(
  endpoint: Pick<BoxExecEndpoint, "host" | "port" | "authToken">,
): LocalExecExecutor {
  const client = createBoxExecClient(endpoint);
  const cancels = new Map<number, AbortController>();
  return {
    decodeServerMessage(json: JsonValue): LocalExecDecodedMessage {
      return ExecServerMessage.fromJson(json, { ignoreUnknownFields: true }) as unknown as LocalExecDecodedMessage;
    },
    throwControl(error: string): JsonValue {
      return new ExecClientControlMessage({
        message: { case: "throw", value: new ExecClientThrow({ error }) },
      }).toJson();
    },
    cancel(execId: number): void {
      cancels.get(execId)?.abort();
    },
    async *execute(message: LocalExecDecodedMessage, signal: AbortSignal): AsyncIterable<LocalExecExecutorOutput> {
      const request = asServerMessage(message);
      const nested = new AbortController();
      cancels.set(request.id, nested);
      const onAbort = () => nested.abort();
      if (signal.aborted) nested.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const envelope of client.exec(request, { signal: nested.signal })) {
          const element = envelope.element;
          if (element.case === "execClientMessage") {
            yield { kind: "client", message: element.value.toJson() };
          } else if (element.case === "execClientControlMessage") {
            yield { kind: "control", message: element.value.toJson() };
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        cancels.delete(request.id);
      }
    },
  };
}

function controlThrowMessage(json: JsonValue): string | undefined {
  try {
    const control = ExecClientControlMessage.fromJson(json, { ignoreUnknownFields: true }).message;
    return control.case === "throw" ? control.value.error : undefined;
  } catch {
    return undefined;
  }
}

async function collectExecClientMessage(
  executor: LocalExecExecutor,
  json: JsonValue,
): Promise<ExecClientMessage> {
  const decoded = executor.decodeServerMessage(json);
  decoded.id = 1;
  let thrown: string | undefined;
  for await (const output of executor.execute(decoded, new AbortController().signal)) {
    if (output.kind === "control") {
      thrown ??= controlThrowMessage(output.message);
      continue;
    }
    try {
      const client = ExecClientMessage.fromJson(output.message, { ignoreUnknownFields: true });
      if (client.message.case !== undefined) {
        if (thrown != null) throw new Error(thrown);
        return client;
      }
    } catch (error) {
      if (thrown != null) throw new Error(thrown);
      throw error;
    }
  }
  throw new Error(thrown ?? "box exec returned no client message");
}

/**
 * Upload/download against the box daemon so a remote box (not this process's
 * disk) is the computer ExternalShell / CopyToBox talk to.
 */
export function createBoxLocalExecFileStore(
  endpoint: Pick<BoxExecEndpoint, "host" | "port" | "authToken">,
): BoxLocalExecFileStore {
  const executor = createBoxBackedLocalExecExecutor(endpoint);
  return {
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const request = new ExecServerMessage({
        id: 1,
        execId: "local-exec-upload",
        message: { case: "writeArgs", value: new WriteArgs({ path, fileBytes: bytes, toolCallId: "local-exec-upload" }) },
      });
      const client = await collectExecClientMessage(executor, request.toJson());
      if (client.message.case !== "writeResult") throw new Error(`box write returned ${client.message.case ?? "unset"}`);
      const result = client.message.value.result;
      if (result.case === "success") return;
      const reason = result.case === "error" ? result.value.error
        : result.case === "rejected" ? result.value.reason
        : result.case === "permissionDenied" ? result.value.error
        : result.case;
      throw new Error(`box write failed (${result.case}): ${reason}`);
    },
    async read(path: string): Promise<Uint8Array> {
      const request = new ExecServerMessage({
        id: 1,
        execId: "local-exec-download",
        message: { case: "readArgs", value: new ReadArgs({ path, encodingHint: "latin1" }) },
      });
      const client = await collectExecClientMessage(executor, request.toJson());
      if (client.message.case !== "readResult") throw new Error(`box read returned ${client.message.case ?? "unset"}`);
      const result = client.message.value.result;
      if (result.case === "success") {
        const output = result.value.output;
        if (output.case === "data") return output.value;
        if (output.case === "content") return Buffer.from(output.value, "latin1");
        throw new Error("box read returned no content");
      }
      const reason = result.case === "error" ? result.value.error
        : result.case === "rejected" ? result.value.reason
        : result.case === "fileNotFound" ? "file not found"
        : result.case === "permissionDenied" ? "permission denied"
        : result.case === "invalidFile" ? result.value.reason
        : result.case;
      throw new Error(`box read failed (${result.case}): ${reason}`);
    },
  };
}
