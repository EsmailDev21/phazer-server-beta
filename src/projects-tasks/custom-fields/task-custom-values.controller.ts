import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { SetCustomValueDto } from './dto/set-custom-value.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';

@Controller('tasks/:id/custom-values')
export class TaskCustomValuesController {
  constructor(private readonly customFieldsService: CustomFieldsService) {}

  @RequireAccess('editTask')
  @Put(':fieldId')
  async setValue(
    @Param('id') taskId: string,
    @Param('fieldId') fieldId: string,
    @Body() dto: SetCustomValueDto,
  ) {
    return this.customFieldsService.setValue(taskId, fieldId, dto.value);
  }

  @RequireAccess('editTask')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':fieldId')
  async deleteValue(
    @Param('id') taskId: string,
    @Param('fieldId') fieldId: string,
  ) {
    await this.customFieldsService.deleteValue(taskId, fieldId);
  }
}
