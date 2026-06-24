import { Data, Runtime } from "effect";

export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<{
  readonly searchedFrom: string;
  readonly detail: string;
}> {}

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly path: string;
  readonly reason: string;
}> {}

export class ExternalCommandError extends Data.TaggedError("ExternalCommandError")<{
  readonly command: string;
  readonly detail: string;
}> {}

export class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly detail: string;
}> {}

// User error — prints one clean line, no stack trace (errorReported = false).
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {
  override readonly [Runtime.errorReported] = false;
}

export class IssueRepoMismatch extends Data.TaggedError("IssueRepoMismatch")<{
  readonly owner: string;
  readonly repo: string;
  readonly here: string;
}> {}
