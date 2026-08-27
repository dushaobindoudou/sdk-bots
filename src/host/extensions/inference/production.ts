import type { HostExtensionContext } from "../../../shared/host-extensions.js";
import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { createCursorWebFetchService, createCursorWebSearchService } from "./cursor-web-tools.js";
import { createLocalWebFetchService, createLocalWebSearchService } from "./local-web-tools.js";
import { createHostInference } from "./inference-service.js";
import type { InferenceExtensionContext } from "./extension.js";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

/** Recreates the artifact's concrete inference construction at host-main.cjs:617672-617732. */
export function createInferenceProductionExtras(
  context: ProductionContext,
): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  // Headless deployments run without Cursor credentials: every Cursor-backend
  // web call would fail instantly with a credentials-waiting error (which
  // models misreport as "network timeout" and retry forever). Fall back to
  // local implementations that do the work on this host.
  const hasCursorCredentials = () => auth.peekAccessToken() !== null;
  let loggedLocalMode = false;
  const noteLocalMode = (what: string) => {
    if (loggedLocalMode) return;
    loggedLocalMode = true;
    console.info(`[sdk-bots] web tools in local mode (no Cursor credentials): ${what}`);
  };
  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    createWebSearch(args) {
      const request = args as { modelId: string; onRequestId?: (requestId: string) => void };
      if (!hasCursorCredentials()) {
        noteLocalMode("search scrapes cn.bing.com, fetch does direct HTTP from this host");
        return createLocalWebSearchService() as unknown as ReturnType<typeof createCursorWebSearchService>;
      }
      return createCursorWebSearchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        modelId: request.modelId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
    createWebFetch(args) {
      const request = args as { onRequestId?: (requestId: string) => void };
      if (!hasCursorCredentials()) {
        noteLocalMode("search scrapes cn.bing.com, fetch does direct HTTP from this host");
        return createLocalWebFetchService() as unknown as ReturnType<typeof createCursorWebFetchService>;
      }
      return createCursorWebFetchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
  };
}

export type InferenceModelSelection = SandAgentModelSelection;
