/**
 * Strategy registry -- maps strategy names to factory functions.
 *
 * Validates config via Zod before factory lookup, ensuring only
 * valid configurations reach strategy constructors.
 */

import type { IStrategy } from './types.js';
import type { StrategyConfig } from './config.js';
import { parseStrategyConfig } from './config.js';
import { StrategyConfigError } from '../core/errors.js';

type StrategyFactory = (config: StrategyConfig) => IStrategy;

export class StrategyRegistry {
  private factories = new Map<string, StrategyFactory>();

  register(name: string, factory: StrategyFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Strategy already registered: ${name}`);
    }
    this.factories.set(name, factory);
  }

  create(rawConfig: unknown): IStrategy {
    const config = parseStrategyConfig(rawConfig); // throws StrategyConfigError on invalid
    const factory = this.factories.get(config.strategy);
    if (!factory) {
      throw new StrategyConfigError(
        `Unknown strategy: ${config.strategy}`,
        [`strategy: unknown strategy '${config.strategy}'`],
      );
    }
    return factory(config);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
