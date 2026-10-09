export type ErrorCode =
  | "AUTHORIZATION_ERROR"
  | "CLIENT_ACCESS_ERROR"
  | "ADSPIRER_CONNECTION_ERROR"
  | "ADSPIRER_TOKEN_EXPIRED"
  | "BUDGET_CEILING_VIOLATION"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "DUPLICATE_EXECUTION"
  | "TOOL_CLASSIFICATION_ERROR"
  | "AGENT_PAUSED"
  | "PROVIDER_UNAVAILABLE"
  | "APPROVAL_VALIDATION_ERROR"
  | "EXECUTION_VERIFICATION_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

export class AuthorizationError extends AppError {
  constructor(
    message = "You are not authorized to perform this action",
    details?: Record<string, unknown>,
  ) {
    super("AUTHORIZATION_ERROR", message, 403, details);
  }
}

export class ClientAccessError extends AppError {
  constructor(
    message = "You do not have access to this client",
    details?: Record<string, unknown>,
  ) {
    super("CLIENT_ACCESS_ERROR", message, 403, details);
  }
}

export class AdspirerConnectionError extends AppError {
  constructor(
    message = "Failed to connect to Adspirer",
    details?: Record<string, unknown>,
  ) {
    super("ADSPIRER_CONNECTION_ERROR", message, 502, details);
  }
}

export class AdspirerTokenExpiredError extends AppError {
  constructor(
    message = "Adspirer access token has expired",
    details?: Record<string, unknown>,
  ) {
    super("ADSPIRER_TOKEN_EXPIRED", message, 401, details);
  }
}

export class BudgetCeilingViolation extends AppError {
  constructor(
    message = "Proposed spend exceeds the client budget ceiling",
    details?: Record<string, unknown>,
  ) {
    super("BUDGET_CEILING_VIOLATION", message, 422, details);
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(
    message = "An approved approval is required before executing this action",
    details?: Record<string, unknown>,
  ) {
    super("APPROVAL_REQUIRED", message, 409, details);
  }
}

export class ApprovalExpiredError extends AppError {
  constructor(
    message = "This approval has expired and cannot be executed",
    details?: Record<string, unknown>,
  ) {
    super("APPROVAL_EXPIRED", message, 410, details);
  }
}

export class DuplicateExecutionError extends AppError {
  constructor(
    message = "This action has already been executed (idempotency conflict)",
    details?: Record<string, unknown>,
  ) {
    super("DUPLICATE_EXECUTION", message, 409, details);
  }
}

export class ToolClassificationError extends AppError {
  constructor(
    message = "Tool is blocked or could not be classified safely",
    details?: Record<string, unknown>,
  ) {
    super("TOOL_CLASSIFICATION_ERROR", message, 403, details);
  }
}

export class AgentPausedError extends AppError {
  constructor(
    message = "Agent task is paused and cannot continue",
    details?: Record<string, unknown>,
  ) {
    super("AGENT_PAUSED", message, 409, details);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(
    message = "Ads provider is unavailable",
    details?: Record<string, unknown>,
  ) {
    super("PROVIDER_UNAVAILABLE", message, 503, details);
  }
}

/** Approval args failed schema / policy / account validation. */
export class ApprovalValidationError extends AppError {
  constructor(
    message = "The proposed action has invalid or unsupported values",
    details?: Record<string, unknown>,
  ) {
    super("APPROVAL_VALIDATION_ERROR", message, 422, details);
  }
}

/**
 * Meta accepted a change but reading it back shows a different value/status.
 * The approval is marked failed rather than reported as executed.
 */
export class ExecutionVerificationError extends AppError {
  constructor(
    message = "Meta did not confirm the change",
    details?: Record<string, unknown>,
  ) {
    super("EXECUTION_VERIFICATION_ERROR", message, 502, details);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
