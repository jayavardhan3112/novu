import { Injectable, Logger } from '@nestjs/common';
import {
  JobEntity,
  JobStatusEnum,
  MessageTemplateEntity,
  NotificationEntity,
  NotificationRepository,
  NotificationStepEntity,
} from '@novu/dal';
import { ChannelTypeEnum, DigestTypeEnum, STEP_TYPE_TO_CHANNEL_TYPE, StepTypeEnum } from '@novu/shared';

import { CreateNotificationJobsCommand } from './create-notification-jobs.command';
import { DigestFilterSteps, DigestFilterStepsCommand } from '../digest-filter-steps';
import { EventsPerformanceService } from '../../services/performance-service';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { InstrumentUsecase } from '@novu/application-generic';

const LOG_CONTEXT = 'CreateNotificationUseCase';
type NotificationJob = Omit<JobEntity, '_id' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class CreateNotificationJobs {
  constructor(
    private digestFilterSteps: DigestFilterSteps,
    private notificationRepository: NotificationRepository,
    protected performanceService: EventsPerformanceService
  ) {}

  @InstrumentUsecase()
  public async execute(command: CreateNotificationJobsCommand): Promise<NotificationJob[]> {
    const mark = this.performanceService.buildCreateNotificationJobsMark(
      command.identifier,
      command.transactionId,
      command.to.subscriberId
    );

    const notification = await this.notificationRepository.create({
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
      _subscriberId: command.subscriber._id,
      _templateId: command.template._id,
      transactionId: command.transactionId,
      to: command.to,
      payload: command.payload,
    });

    if (!notification) {
      const message = 'Notification could not be created';
      Logger.error(message, LOG_CONTEXT);
      throw new ApiException(message);
    }

    const jobs: NotificationJob[] = [];

    const steps = await this.createSteps(command, notification);

    for (const step of steps) {
      if (!step.template) throw new ApiException('Step template was not found');

      const providerId = command.templateProviderIds.get(
        STEP_TYPE_TO_CHANNEL_TYPE.get(step.template.type) as ChannelTypeEnum
      );

      const job = {
        identifier: command.identifier,
        payload: command.payload,
        overrides: command.overrides,
        step,
        transactionId: command.transactionId,
        _notificationId: notification._id,
        _environmentId: command.environmentId,
        _organizationId: command.organizationId,
        _userId: command.userId,
        subscriberId: command.subscriber.subscriberId,
        _subscriberId: command.subscriber._id,
        status: JobStatusEnum.PENDING,
        _templateId: notification._templateId,
        digest: step.metadata,
        type: step.template.type,
        providerId: providerId,
        ...(command.actor && { _actorId: command.actor?._id }),
      };

      jobs.push(job);
    }

    this.performanceService.setEnd(mark);

    return jobs;
  }

  private async createSteps(
    command: CreateNotificationJobsCommand,
    notification: NotificationEntity
  ): Promise<NotificationStepEntity[]> {
    const activeSteps = this.filterActiveSteps(command.template.steps);

    return await this.filterDigestSteps(command, notification, activeSteps);
  }

  private filterActiveSteps(steps: NotificationStepEntity[]): NotificationStepEntity[] {
    return steps.filter((step) => step.active === true);
  }

  private createTriggerStep(command: CreateNotificationJobsCommand): NotificationStepEntity {
    return {
      template: {
        _environmentId: command.environmentId,
        _organizationId: command.organizationId,
        _creatorId: command.userId,
        type: StepTypeEnum.TRIGGER,
        content: '',
      } as MessageTemplateEntity,
      _templateId: command.template._id,
    };
  }

  private async filterDigestSteps(
    command: CreateNotificationJobsCommand,
    notification: NotificationEntity,
    steps: NotificationStepEntity[]
  ): Promise<NotificationStepEntity[]> {
    // TODO: Review this for workflows with more than one digest as this will return the first element found
    const digestStep = steps.find((step) => step.template?.type === StepTypeEnum.DIGEST);

    if (digestStep && digestStep.metadata?.type) {
      return await this.digestFilterSteps.execute(
        DigestFilterStepsCommand.create({
          _subscriberId: command.subscriber._id,
          payload: command.payload,
          steps: command.template.steps,
          environmentId: command.environmentId,
          organizationId: command.organizationId,
          userId: command.userId,
          templateId: command.template._id,
          notificationId: notification._id,
          transactionId: command.transactionId,
          type: digestStep.metadata.type as DigestTypeEnum, // We already checked it is a DIGEST
        })
      );
    }

    return steps;
  }
}
