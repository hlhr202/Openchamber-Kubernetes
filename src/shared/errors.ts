export const errorCodes = [
  'INVALID_INPUT', 'CONFIG_INVALID', 'CONFIG_REFERENCE_MISSING', 'STATE_UNAVAILABLE',
  'RESOURCE_INVALID', 'SELECTOR_INVALID', 'BUDGET_EXCEEDED', 'UNAUTHENTICATED', 'STALE_TARGET',
  'CONFIG_UNREADABLE', 'CONFIG_CHANGED', 'CONFIG_NOT_FOUND', 'NOT_FOUND',
  'QUERY_CANCELLED', 'QUERY_TIMEOUT', 'QUERY_LIMIT', 'SERVICE_CLOSED', 'FORBIDDEN', 'CONTINUATION_EXPIRED',
  'AUTHENTICATION_UNAVAILABLE', 'CLI_NOT_FOUND', 'CLI_INCOMPATIBLE',
  'AUTH_PLUGIN_NOT_FOUND',
  'READ_TRANSPORT_UNAVAILABLE',
  'PORT_IN_USE', 'WEBSOCKET_UPGRADE_FAILED', 'SESSION_DISCONNECTED', 'REMOTE_FORWARD_FAILED',
  'DEBUG_ADAPTER_REQUIRED',
  'CONTENT_INVALID',
  'CRD_LIST_BUDGET_EXCEEDED', 'CRD_OBJECT_BUDGET_EXCEEDED', 'CUSTOM_LIST_BUDGET_EXCEEDED',
  'HELM_INDEX_MISSING',
  'DOCUMENT_DIRTY',
  'VIEW_EXPIRED', 'CONFIRMATION_EXPIRED', 'CONFLICT', 'OPERATION_UNKNOWN',
] as const;
export type ErrorCode = typeof errorCodes[number];

export function isBudgetError(code: ErrorCode): boolean {
  return code === 'BUDGET_EXCEEDED' || code === 'CRD_LIST_BUDGET_EXCEEDED' || code === 'CRD_OBJECT_BUDGET_EXCEEDED' || code === 'CUSTOM_LIST_BUDGET_EXCEEDED';
}

// Messages are fixed codes, not parser/CLI text that could include resource values or credentials.
export class BoundaryError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = 'BoundaryError';
    this.code = code;
  }
}
