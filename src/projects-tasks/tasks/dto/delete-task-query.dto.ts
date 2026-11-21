import { IsBoolean, IsOptional } from 'class-validator';
import { BooleanQuery } from '../../../common/dto/boolean-query';

export class DeleteTaskQueryDto {
  /**
   * Delete the whole subtree too. Without it, deleting a task that has
   * subtasks is refused with a 409 (ADR-0005 decision 4).
   */
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  cascade?: boolean;
}
