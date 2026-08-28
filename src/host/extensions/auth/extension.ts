import { createRealRetryPolicy, realClock } from "../../../shared/scheduling.js";
import { defineHostExtension } from "../../../shared/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { createHostAuthService } from "./auth-service.js";
import { CREDENTIAL_RETRY_BASE_DELAY_MS, CREDENTIAL_RETRY_MAX_DELAY_MS } from "./credential-renewer.js";

interface AuthHost { log(message: string): void; }
export const authExtension = defineHostExtension({
  id: HostExtensions.Auth, dependencies: [],
  start: (context) => {
    const host = context.host as AuthHost;
    const service = createHostAuthService({ retry: createRealRetryPolicy({ name: "sand-inference-credential-renewal", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: CREDENTIAL_RETRY_BASE_DELAY_MS, maxDelayMs: CREDENTIAL_RETRY_MAX_DELAY_MS }), clock: realClock, log: (message) => host.log(message) });
    context.onStop(() => service.dispose());
    return {
      getAccessToken: (options: { readonly backendUrl?: string }) => service.getAccessToken(options),
      peekAccessToken: () => service.peekAccessToken(),
      getLastRenewalEvent: () => service.getLastRenewalEvent(),
      getMachineId: () => service.getMachineId(),
      subscribeToRenewal: (listener: Parameters<typeof service.subscribeToRenewal>[0]) => service.subscribeToRenewal(listener),
      // Cursor-free: the account display name came from Cursor's dashboard;
      // headless deployments have no account, so there is no name to resolve.
      getUserFullName: (): undefined => undefined
    };
  }
});
