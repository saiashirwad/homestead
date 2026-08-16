import { Schema } from "effect";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
  field: Schema.optional(Schema.String),
}) {}

export class RepositoryNotFound extends Schema.TaggedError<RepositoryNotFound>()("RepositoryNotFound", {
  repoRoot: Schema.String,
  message: Schema.String,
}) {}

export class WorktreeAlreadyExists extends Schema.TaggedError<WorktreeAlreadyExists>()("WorktreeAlreadyExists", {
  name: Schema.String,
  repoRoot: Schema.String,
  message: Schema.String,
}) {}

export class WorktreeNotFound extends Schema.TaggedError<WorktreeNotFound>()("WorktreeNotFound", {
  name: Schema.String,
  repoRoot: Schema.String,
  message: Schema.String,
}) {}

export class WorktreeRemovalRefused extends Schema.TaggedError<WorktreeRemovalRefused>()("WorktreeRemovalRefused", {
  name: Schema.String,
  repoRoot: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export class RequestIdConflict extends Schema.TaggedError<RequestIdConflict>()("RequestIdConflict", {
  requestId: Schema.String,
  message: Schema.String,
}) {}

export class ProvisionFailure extends Schema.TaggedError<ProvisionFailure>()("ProvisionFailure", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class SocketInUseError extends Schema.TaggedError<SocketInUseError>()("SocketInUseError", {
  socketPath: Schema.String,
  message: Schema.String,
}) {}

export class SocketStartupError extends Schema.TaggedError<SocketStartupError>()("SocketStartupError", {
  socketPath: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export class ConfigNotFound extends Schema.TaggedError<ConfigNotFound>()("ConfigNotFound", {
  searchedFrom: Schema.String,
  detail: Schema.String,
}) {}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class ExternalCommandError extends Schema.TaggedError<ExternalCommandError>()("ExternalCommandError", {
  command: Schema.String,
  detail: Schema.String,
}) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()("ServiceUnavailable", {
  name: Schema.String,
  host: Schema.String,
  port: Schema.Number,
  detail: Schema.String,
}) {}

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}
