import { IsDefined, IsMongoId, IsString } from 'class-validator';
import { NotificationStepEntity } from '@novu/dal';
import { DigestTypeEnum } from '@novu/shared';

import { EnvironmentWithUserCommand } from '../../../shared/commands/project.command';

export class DigestFilterStepsCommand extends EnvironmentWithUserCommand {
  @IsMongoId()
  _subscriberId: string;

  @IsDefined()
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  @IsDefined()
  steps: NotificationStepEntity[];

  @IsMongoId()
  templateId: string;

  @IsMongoId()
  notificationId: string;

  @IsString()
  transactionId: string;

  @IsString()
  type: DigestTypeEnum;
}
