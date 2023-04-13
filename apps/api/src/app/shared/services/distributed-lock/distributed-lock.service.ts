import * as Redlock from 'redlock';
import { setTimeout } from 'timers/promises';
import { Injectable, Logger } from '@nestjs/common';

import { InMemoryProviderClient, InMemoryProviderService } from '../in-memory-provider';
import { ApiException } from '../../exceptions/api.exception';

const LOG_CONTEXT = 'DistributedLock';

interface ILockOptions {
  resource: string;
  ttl: number;
}

@Injectable()
export class DistributedLockService {
  public distributedLock: Redlock;
  public instances: InMemoryProviderClient[];
  public lockCounter = {};
  public shuttingDown = false;

  constructor(private inMemoryProviderService: InMemoryProviderService) {
    this.startup(inMemoryProviderService.inMemoryProviderClient);
  }

  public startup(
    client: InMemoryProviderClient,
    settings = {
      driftFactor: 0.01,
      retryCount: 50,
      retryDelay: 100,
      retryJitter: 200,
    }
  ): void {
    if (this.distributedLock) {
      return;
    }

    if (client) {
      this.instances = [client];
      this.distributedLock = new Redlock(this.instances, settings);
      Logger.verbose('Redlock started', LOG_CONTEXT);

      /**
       * https://github.com/mike-marcacci/node-redlock/blob/dc7bcd923f70f66abc325d23ae618f7caf01ad75/src/index.ts#L192
       *
       * Because Redlock is designed for high availability, it does not care if
       * a minority of redis instances/clusters fail at an operation.
       *
       * However, it can be helpful to monitor and log such cases. Redlock emits
       * an "error" event whenever it encounters an error, even if the error is
       * ignored in its normal operation.
       *
       * This function serves to prevent Node's default behavior of crashing
       * when an "error" event is emitted in the absence of listeners.
       */
      this.distributedLock.on('error', (error) => {
        Logger.error(error, LOG_CONTEXT);
      });
    }
  }

  public isDistributedLockEnabled(): boolean {
    if (!this.distributedLock) {
      Logger.log('Distributed lock service is not enabled', LOG_CONTEXT);

      return false;
    } else {
      return true;
    }
  }

  public areAllLocksReleased(): boolean {
    return Object.values(this.lockCounter).every((value) => !value);
  }

  public async shutdown(): Promise<void> {
    if (this.distributedLock) {
      while (!this.areAllLocksReleased()) {
        await setTimeout(250);
      }

      if (!this.shuttingDown) {
        try {
          Logger.verbose('Redlock starting to shut down', LOG_CONTEXT);
          this.shuttingDown = true;
          await this.distributedLock.quit();
        } catch (error) {
          Logger.verbose(`Error quiting redlock: ${error.message}`, LOG_CONTEXT);
        } finally {
          this.shuttingDown = false;
          this.distributedLock = undefined;
          Logger.verbose('Redlock shutdown', LOG_CONTEXT);
        }
      }
    }
  }

  /**
   * This Nest.js hook allows us to execute logic on termination after signal.
   * https://docs.nestjs.com/fundamentals/lifecycle-events#application-shutdown
   *
   * Enabled by:
   *   app.enableShutdownHooks();
   *
   * in /apps/api/src/bootstrap.ts
   */
  public async onApplicationShutdown(signal): Promise<void> {
    await this.shutdown();
  }

  public async applyLock<T>({ resource, ttl }: ILockOptions, handler: () => Promise<T>): Promise<T> {
    if (!this.isDistributedLockEnabled()) {
      return await handler();
    }

    const releaseLock = await this.lock(resource, ttl);

    try {
      Logger.debug(`Lock ${resource} for ${handler.name}`, LOG_CONTEXT);

      const result = await handler();

      return result;
    } finally {
      await releaseLock();
      Logger.debug(`Lock ${resource} released for ${handler.name}`, LOG_CONTEXT);
    }
  }

  private async lock(resource: string, ttl: number): Promise<() => Promise<void>> {
    try {
      const acquiredLock = await this.distributedLock.acquire([resource], ttl);
      Logger.verbose(`Lock ${resource} acquired for ${ttl} ms`, LOG_CONTEXT);

      return this.createLockRelease(resource, acquiredLock);
    } catch (error) {
      Logger.verbose(`Lock ${resource} threw an error: ${error.message}`, LOG_CONTEXT);
      throw error;
    }
  }

  private createLockRelease(resource: string, lock): () => Promise<void> {
    this.increaseLockCounter(resource);

    return async (): Promise<void> => {
      try {
        Logger.debug(`Lock ${resource} counter at ${this.lockCounter[resource]}`, LOG_CONTEXT);
        await lock.unlock();
      } catch (error) {
        Logger.error(`Releasing lock ${resource} threw an error: ${error.message}`, LOG_CONTEXT);
      } finally {
        this.decreaseLockCounter(resource);
      }
    };
  }

  private increaseLockCounter(resource: string): void {
    if (this.lockCounter[resource]) {
      this.lockCounter[resource]++;

      return;
    }
    this.lockCounter[resource] = 1;
  }

  private decreaseLockCounter(resource: string): void {
    this.lockCounter[resource]--;
  }
}
