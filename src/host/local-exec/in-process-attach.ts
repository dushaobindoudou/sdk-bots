import { BOX_TERMINALS_FOLDER } from "../box/loopback-sand-box.js";
import { boxComputerWorkspaceRoot, resolveBoxExecEndpoint } from "../box/box-exec-endpoint.js";
import type { SandLocalExecBridge } from "../extensions/local-exec/local-exec-bridge.js";
import {
  createBoxBackedLocalExecExecutor,
  createBoxLocalExecFileStore,
} from "./box-backed-executor.js";
import {
  SandLocalExecProvider,
  type LocalExecRequestFrame,
} from "./local-exec-provider.js";

export interface InProcessBoxComputer {
  readonly computerId: string;
  readonly computerLabel: string;
  close(): void;
}

/**
 * Registers the box exec-daemon as the live "user computer" on the local-exec
 * bridge. ExternalShell / ExternalRead / CopyToBox then execute on the box —
 * including a remote box addressed by SAND_BOX_EXEC_DAEMON_HOST — without a
 * desktop renderer.
 */
export function attachInProcessBoxComputer(
  bridge: SandLocalExecBridge,
  env: NodeJS.ProcessEnv = process.env,
): InProcessBoxComputer {
  const endpoint = resolveBoxExecEndpoint(env);
  const workspaceRoot = boxComputerWorkspaceRoot(env);
  const computerId = env.SAND_BOX_COMPUTER_ID?.trim() || "box";
  const computerLabel = env.SAND_BOX_COMPUTER_LABEL?.trim() || "box";
  const provider = new SandLocalExecProvider({
    executor: createBoxBackedLocalExecExecutor(endpoint),
    fileStore: createBoxLocalExecFileStore(endpoint),
    root: workspaceRoot,
    terminalsFolder: BOX_TERMINALS_FOLDER,
    computerId,
    computerLabel,
    resolveConnection: async () => ({ baseUrl: "http://in-process.invalid" }),
    postResponses: async (frames) => {
      bridge.submitResponses({ frames });
      return true;
    },
  });
  const detach = bridge.registerProvider((frame) => {
    void provider.handleRequest(frame as LocalExecRequestFrame);
  });
  return {
    computerId,
    computerLabel,
    close() {
      provider.close();
      detach();
    },
  };
}
