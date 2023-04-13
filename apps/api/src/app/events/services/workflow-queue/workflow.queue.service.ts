import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Job, JobsOptions, QueueBaseOptions, WorkerOptions } from 'bullmq';
// TODO: Remove this DAL dependency, maybe through a DTO or shared entity
import { JobEntity } from '@novu/dal';
import { ExecutionDetailsSourceEnum, ExecutionDetailsStatusEnum, getRedisPrefix } from '@novu/shared';
import { ConnectionOptions } from 'tls';
const nr = require('newrelic');

import { RunJob, RunJobCommand } from '../../usecases/run-job';
import { QueueNextJob, QueueNextJobCommand } from '../../usecases/queue-next-job';
import {
  SetJobAsCommand,
  SetJobAsCompleted,
  SetJobAsFailed,
  SetJobAsFailedCommand,
} from '../../usecases/update-job-status';
import { WebhookFilterBackoffStrategy } from '../../usecases/webhook-filter-backoff-strategy';

import {
  CreateExecutionDetails,
  CreateExecutionDetailsCommand,
} from '../../../execution-details/usecases/create-execution-details';
import { DetailEnum } from '../../../execution-details/types';
import { BullmqService } from '@novu/application-generic';
import { PinoLogger, storage, Store } from '@novu/application-generic';

export const WORKER_NAME = 'standard';

export enum BackoffStrategiesEnum {
  WEBHOOK_FILTER_BACKOFF = 'webhookFilterBackoff',
}

@Injectable()
export class WorkflowQueueService {
  private bullConfig: QueueBaseOptions = {
    connection: {
      db: Number(process.env.REDIS_DB_INDEX),
      port: Number(process.env.REDIS_PORT),
      host: process.env.REDIS_HOST,
      password: process.env.REDIS_PASSWORD,
      connectTimeout: 50000,
      keepAlive: 30000,
      family: 4,
      keyPrefix: getRedisPrefix(),
      tls: process.env.REDIS_TLS as ConnectionOptions,
    },
  };
  readonly DEFAULT_ATTEMPTS = 3;

  public readonly bullMqService: BullmqService;

  constructor(
    @Inject(forwardRef(() => QueueNextJob)) private queueNextJob: QueueNextJob,
    @Inject(forwardRef(() => RunJob)) private runJob: RunJob,
    @Inject(forwardRef(() => SetJobAsCompleted)) private setJobAsCompleted: SetJobAsCompleted,
    @Inject(forwardRef(() => SetJobAsFailed)) private setJobAsFailed: SetJobAsFailed,
    @Inject(forwardRef(() => WebhookFilterBackoffStrategy))
    private webhookFilterWebhookFilterBackoffStrategy: WebhookFilterBackoffStrategy,
    @Inject(forwardRef(() => CreateExecutionDetails)) private createExecutionDetails: CreateExecutionDetails
  ) {
    this.bullMqService = new BullmqService();

    this.bullMqService.createQueue(WORKER_NAME, {
      ...this.bullConfig,
      defaultJobOptions: {
        removeOnComplete: true,
      },
    });
    this.bullMqService.createWorker(WORKER_NAME, this.getWorkerProcessor(), this.getWorkerOpts());

    this.bullMqService.worker.on('completed', async (job) => {
      await this.jobHasCompleted(job);
    });

    this.bullMqService.worker.on('failed', async (job, error) => {
      await this.jobHasFailed(job, error);
    });
  }

  public async gracefulShutdown() {
    // Right now we only want this for testing purposes
    if (process.env.NODE_ENV === 'test') {
      await this.bullMqService.queue.drain();
      await this.bullMqService.worker.close();
    }
  }

  private getWorkerOpts(): WorkerOptions {
    return {
      ...this.bullConfig,
      lockDuration: 90000,
      concurrency: 200,
      settings: {
        backoffStrategy: this.getBackoffStrategies(),
      },
    } as WorkerOptions;
  }

  private getWorkerProcessor() {
    return async ({ data }: { data: JobEntity }) => {
      return await new Promise(async (resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;

        nr.startBackgroundTransaction('job-processing-queue', 'Trigger Engine', function () {
          const transaction = nr.getTransaction();

          storage.run(new Store(PinoLogger.root), () => {
            _this.runJob
              .execute(
                RunJobCommand.create({
                  jobId: data._id,
                  environmentId: data._environmentId,
                  organizationId: data._organizationId,
                  userId: data._userId,
                })
              )
              .then(resolve)
              .catch(reject)
              .finally(() => {
                transaction.end();
              });
          });
        });
      });
    };
  }

  private async jobHasCompleted(job): Promise<void> {
    await this.setJobAsCompleted.execute(
      SetJobAsCommand.create({
        environmentId: job.data._environmentId,
        _jobId: job.data._id,
        organizationId: job.data._organizationId,
      })
    );
  }

  private async jobHasFailed(job, error): Promise<void> {
    const hasToBackoff = this.runJob.shouldBackoff(error);

    if (!hasToBackoff) {
      await this.setJobAsFailed.execute(
        SetJobAsFailedCommand.create({
          environmentId: job.data._environmentId,
          error,
          _jobId: job.data._id,
          organizationId: job.data._organizationId,
        })
      );
    }

    const lastWebhookFilterRetry = job.attemptsMade === this.DEFAULT_ATTEMPTS && hasToBackoff;

    if (lastWebhookFilterRetry) {
      await this.handleLastFailedWebhookFilter(job, error);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleLastFailedWebhookFilter(job: any, error: Error) {
    await this.setJobAsFailed.execute(
      SetJobAsFailedCommand.create({
        environmentId: job.data._environmentId,
        error,
        _jobId: job.data._id,
        organizationId: job.data._organizationId,
      })
    );

    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        ...CreateExecutionDetailsCommand.getDetailsFromJob(job.data),
        detail: DetailEnum.WEBHOOK_FILTER_FAILED_LAST_RETRY,
        source: ExecutionDetailsSourceEnum.WEBHOOK,
        status: ExecutionDetailsStatusEnum.PENDING,
        isTest: false,
        isRetry: true,
        raw: JSON.stringify({ message: JSON.parse(error.message).message }),
      })
    );

    if (!job?.data?.step?.shouldStopOnFail) {
      await this.queueNextJob.execute(
        QueueNextJobCommand.create({
          parentId: job?.data._id,
          environmentId: job?.data._environmentId,
          organizationId: job?.data._organizationId,
          userId: job?.data._userId,
        })
      );
    }
  }

  public async addToQueue(id: string, data: JobEntity, delay?: number | undefined, organizationId?: string) {
    const options: JobsOptions = {
      removeOnComplete: true,
      removeOnFail: true,
      delay,
    };

    const stepContainsWebhookFilter = this.stepContainsFilter(data, 'webhook');

    if (stepContainsWebhookFilter) {
      options.backoff = {
        type: BackoffStrategiesEnum.WEBHOOK_FILTER_BACKOFF,
      };
      options.attempts = this.DEFAULT_ATTEMPTS;
    }

    await this.bullMqService.add(id, data, options, organizationId);
  }

  private stepContainsFilter(data: JobEntity, onFilter: string) {
    return data.step.filters?.some((filter) => {
      return filter.children?.some((child) => {
        return child.on === onFilter;
      });
    });
  }

  private getBackoffStrategies = () => {
    return async (attemptsMade: number, type: string, eventError: Error, eventJob: Job): Promise<number> => {
      // TODO: Review why when using `Command.create` class-transformer fails with `undefined has no property toKey()`
      const command = {
        attemptsMade,
        environmentId: eventJob?.data?._environmentId,
        eventError,
        eventJob,
        organizationId: eventJob?.data?._organizationId,
        userId: eventJob?.data?._userId,
      };

      return await this.webhookFilterWebhookFilterBackoffStrategy.execute(command);
    };
  };
}
