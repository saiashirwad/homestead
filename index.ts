export { loadConfig, loadConfigOrUndefined } from "./src/config.ts"
export { provisionTarget, resolveRepo } from "./src/worktree/index.ts"
export {
  WorktreeManager,
  WorktreeManagerLive,
  makeWorktreeManagerLayer,
  type WorktreeManagerApi,
} from "./src/worktree/manager.ts"
export {
  WorkspaceManager,
  type WorkspaceManagerApi,
  type CreateWorkspaceError,
  type RemoveWorkspaceError,
} from "./src/workspace/manager.ts"
export {
  WorkspaceManagerLive,
  makeWorkspaceManagerLayer,
  type WorkspaceLiveOptions,
} from "./src/workspace/live.ts"
export {
  WorkspaceProvider,
  type WorkspaceProviderApi,
  type ProviderWorkspace,
  type PreparedWorkspace,
  type PrepareWorkspaceRequest,
  type DiscoveredWorkspace,
} from "./src/workspace/provider.ts"
export {
  WorkspaceRegistry,
  getDefaultWorkspaceRegistryPath,
  type WorkspaceRegistryApi,
  type WorkspaceRegistryError,
  type WorkspaceRegistryOptions,
} from "./src/workspace/registry.ts"
export { makeServer, serverLayer } from "./src/rpc/server.ts"
export { makeClient } from "./src/rpc/client.ts"
export {
  HomesteadRpcs,
  Ping,
  Shutdown,
  CreateWorktree,
  ListWorktrees,
  RemoveWorktree,
  CreateWorkspace,
  GetWorkspace,
  ListWorkspaces,
  RemoveWorkspace,
  ReconcileWorkspaces,
  getDefaultSocketPath,
  type HomesteadClient,
} from "./src/rpc/shared.ts"
export {
  InvalidInput,
  RepositoryNotFound,
  WorktreeAlreadyExists,
  WorktreeNotFound,
  WorktreeRemovalRefused,
  WorkspaceAlreadyExists,
  WorkspaceNotFound,
  WorkspaceRemovalRefused,
  WorkspacePersistenceFailure,
  RequestIdConflict,
  ProvisionFailure,
  SocketInUseError,
  SocketStartupError,
  ConfigNotFound,
  ConfigInvalid,
  UsageError,
} from "./src/errors.ts"
export {
  WorktreeInfo,
  RemoveWorktreeResult,
  WorkspaceInfo,
  RemoveWorkspaceResult,
  ProviderCapabilities,
  WorkspaceLifecycleState,
  type HomesteadConfig,
  type PortSpec,
  type ServiceSpec,
  type SetupStep,
  type TeardownStep,
  type EnvConfig,
  type WorktreeContext,
  type Plan,
} from "./src/types.ts"
