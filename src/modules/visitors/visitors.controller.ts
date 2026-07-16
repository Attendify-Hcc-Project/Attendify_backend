import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { VisitorsService } from './visitors.service';

@Controller('visitors')
@UseGuards(AuthGuard, RolesGuard)
export class VisitorsController {
  constructor(private readonly visitorsService: VisitorsService) {}

  @Get()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getVisitors(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.visitorsService.findAll({
      status,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  @Put(':id/status')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: 'Pending' | 'Registered' | 'Ignored',
  ) {
    if (!status || !['Pending', 'Registered', 'Ignored'].includes(status)) {
      throw new HttpException('Invalid status value', HttpStatus.BAD_REQUEST);
    }
    return this.visitorsService.updateStatus(id, status);
  }

  @Post(':id/promote')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async promoteVisitor(
    @Param('id') id: string,
    @Body() body: {
      firstName: string;
      lastName: string;
      gender: string;
      email?: string;
      phoneNumber?: string;
      department?: string;
      dateOfBirth?: string;
      address?: string;
    },
  ) {
    if (!body.firstName || !body.lastName || !body.gender) {
      throw new HttpException('First name, last name, and gender are required', HttpStatus.BAD_REQUEST);
    }
    return this.visitorsService.promoteToMember(id, body);
  }
}
