import { IsEmail, IsLocale, IsOptional, IsString } from 'class-validator';
import { EnvironmentCommand } from '../../../shared/commands/project.command';
import { SubscriberEntity } from '@novu/dal';
import { SubscriberCustomData } from '@novu/shared';
import { Transform } from 'class-transformer';

export class UpdateSubscriberCommand extends EnvironmentCommand {
  @IsString()
  subscriberId: string;

  @IsOptional()
  firstName?: string;

  @IsOptional()
  lastName?: string;

  @Transform((params) => (params.value === '' ? null : params.value))
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsLocale()
  @IsOptional()
  locale?: string;

  @IsOptional()
  data?: SubscriberCustomData;

  @IsOptional()
  subscriber?: SubscriberEntity;
}
