/**
 * Custom error types for each subsystem.
 * Provides structured error information for logging and handling.
 */

/** Thrown when configuration validation fails. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Thrown when a data provider (Coinbase, CryptoCompare) encounters an error. */
export class DataProviderError extends Error {
  public readonly provider: string;
  public readonly statusCode?: number;

  constructor(message: string, provider: string, statusCode?: number) {
    super(message);
    this.name = 'DataProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

/** Thrown when input validation fails. */
export class ValidationError extends Error {
  public readonly field: string;
  public readonly value: unknown;

  constructor(message: string, field: string, value: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

/** Thrown when a database operation fails. */
export class DatabaseError extends Error {
  public readonly operation: string;

  constructor(message: string, operation: string) {
    super(message);
    this.name = 'DatabaseError';
    this.operation = operation;
  }
}

/** Thrown when indicator configuration validation fails. */
export class IndicatorConfigError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'IndicatorConfigError';
    this.issues = issues;
  }
}

/** Thrown when strategy configuration validation fails. */
export class StrategyConfigError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'StrategyConfigError';
    this.issues = issues;
  }
}
