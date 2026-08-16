export { loadConfig, loadConfigOrUndefined } from "./src/config.ts";
export { provisionTarget, resolveRepo } from "./src/worktree/index.ts";
export { WorktreeManager, WorktreeManagerLive } from "./src/worktree/manager.ts";
export { makeServer, serverLayer } from "./src/rpc/server.ts";
export { makeClient } from "./src/rpc/client.ts";
export {
  HomesteadRpcs,
  Ping,
  Shutdown,
  CreateWorktree,
  ListWorktrees,
  RemoveWorktree,
  getDefaultSocketPath,
  type HomesteadClient,
} from "./src/rpc/shared.ts";
export {
  InvalidInput,
  RepositoryNotFound,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
  RequestIdConflict,
  ProvisionFailure,
  SocketInUseError,
  SocketStartupError,
  ConfigNotFound,
  ConfigInvalid,
  UsageError,
} from "./src/errors.ts";
export {
  WorktreeInfo,
  RemoveWorktreeResult,
  type HomesteadConfig,
  type PortSpec,
  type ServiceSpec,
  type SetupStep,
  type TeardownStep,
  type EnvConfig,
  type WorktreeContext,
  type Plan,
} from "./src/types.ts";
