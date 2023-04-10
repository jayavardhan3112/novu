import { CacheService } from './cache.service';
import { buildKey, CacheInterceptorTypeEnum } from '../../interceptors';
import { Injectable, Logger } from '@nestjs/common';
import { CacheKeyPrefixEnum } from './key-builders/shared';

@Injectable()
export class InvalidateCacheService {
  constructor(private cacheService: CacheService) {}

  public async invalidateByKey({ key }: { key: string }) {
    if (!this.cacheService?.cacheEnabled()) return;

    try {
      await this.cacheService.del(key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`An error has occurred when deleting "key: ${key}",`, 'InvalidateCache', err);
    }
  }

  public async invalidateQuery({ key }: { key: string }) {
    if (!this.cacheService?.cacheEnabled()) return;

    try {
      await this.cacheService.delQuery(key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`An error has occurred when deleting "key: ${key}",`, 'InvalidateCache', err);
    }
  }

  private async clearByPattern(storeKeyPrefix: CacheKeyPrefixEnum, credentials: Record<string, unknown>) {
    Logger.verbose('Removing keys with prefix: ' + storeKeyPrefix);
    Logger.debug('storeKeyPrefix is: ' + storeKeyPrefix);

    const cacheKey = buildKey(storeKeyPrefix, credentials, CacheInterceptorTypeEnum.INVALIDATE);

    if (!cacheKey) {
      Logger.warn('Cachekey does not exist');

      return;
    }

    try {
      Logger.verbose('Awaiting cache delete by pattern');
      await this.cacheService.delByPattern(cacheKey);
      Logger.verbose('Finished cache delete by pattern');
    } catch (err) {
      Logger.error(`An error has occurred when deleting "key: ${cacheKey}",`, 'InvalidateCache', err);
    }
  }
}
