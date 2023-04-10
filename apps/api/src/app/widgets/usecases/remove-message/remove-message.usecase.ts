import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  MessageEntity,
  DalException,
  MessageRepository,
  SubscriberRepository,
  SubscriberEntity,
  MemberRepository,
} from '@novu/dal';
import { ChannelTypeEnum } from '@novu/shared';
import { AnalyticsService } from '@novu/application-generic';

import { InvalidateCacheService } from '../../../shared/services/cache';
import { QueueService } from '../../../shared/services/queue';
import { ANALYTICS_SERVICE } from '../../../shared/shared.module';
import { RemoveMessageCommand } from './remove-message.command';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { MarkEnum } from '../mark-message-as/mark-message-as.command';
import { buildFeedKey, buildMessageCountKey } from '../../../shared/services/cache/key-builders/queries';

@Injectable()
export class RemoveMessage {
  constructor(
    private invalidateCache: InvalidateCacheService,
    private messageRepository: MessageRepository,
    private queueService: QueueService,
    @Inject(ANALYTICS_SERVICE) private analyticsService: AnalyticsService,
    private subscriberRepository: SubscriberRepository,
    private memberRepository: MemberRepository
  ) {}

  async execute(command: RemoveMessageCommand): Promise<MessageEntity> {
    await this.invalidateCache.invalidateQuery({
      key: buildFeedKey().invalidate({
        subscriberId: command.subscriberId,
        _environmentId: command.environmentId,
      }),
    });

    await this.invalidateCache.invalidateQuery({
      key: buildMessageCountKey().invalidate({
        subscriberId: command.subscriberId,
        _environmentId: command.environmentId,
      }),
    });

    const subscriber = await this.subscriberRepository.findBySubscriberId(command.environmentId, command.subscriberId);
    if (!subscriber) throw new NotFoundException(`Subscriber ${command.subscriberId} not found`);

    let deletedMessage;
    try {
      await this.messageRepository.delete({
        _environmentId: command.environmentId,
        _organizationId: command.organizationId,
        _id: command.messageId,
        _subscriberId: command.subscriberId,
      });
      const item = await this.messageRepository.findDeleted({
        _environmentId: command.environmentId,
        _organizationId: command.organizationId,
        _id: command.messageId,
      });

      deletedMessage = item[0];

      if (!deletedMessage.read) {
        await this.updateServices(command, subscriber, deletedMessage, MarkEnum.READ);
      }
      if (!deletedMessage.seen) {
        await this.updateServices(command, subscriber, deletedMessage, MarkEnum.SEEN);
      }
    } catch (e) {
      if (e instanceof DalException) {
        throw new ApiException(e.message);
      }
      throw e;
    }

    return deletedMessage;
  }

  private async updateServices(command: RemoveMessageCommand, subscriber, message, marked: string) {
    const admin = await this.memberRepository.getOrganizationAdminAccount(command.organizationId);
    const count = await this.messageRepository.getCount(command.environmentId, subscriber._id, ChannelTypeEnum.IN_APP, {
      [marked]: false,
    });

    this.updateSocketCount(subscriber, count, marked);

    if (admin) {
      this.analyticsService.track(`Removed Message - [Notification Center]`, admin._userId, {
        _subscriber: message._subscriberId,
        _organization: command.organizationId,
        _template: message._templateId,
      });
    }
  }

  private updateSocketCount(subscriber: SubscriberEntity, count: number, mark: string) {
    const eventMessage = `un${mark}_count_changed`;
    const countKey = `un${mark}Count`;

    this.queueService.bullMqService.add(
      'sendMessage',
      {
        event: eventMessage,
        userId: subscriber._id,
        payload: {
          [countKey]: count,
        },
      },
      {},
      subscriber._organizationId
    );
  }
}
