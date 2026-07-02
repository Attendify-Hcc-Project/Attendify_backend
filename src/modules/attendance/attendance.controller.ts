import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AttendanceService } from './attendance.service';

@Controller('attendance')
// @UseGuards(AuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) { }

  @Get('stats/today')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getTodayStats() {
    return this.attendanceService.todayStats();
  }

  @Get('debug-direct')
  async getDebugDirect() {
    try {
      const client = (this.attendanceService as any).supabaseService.getClient();
      const { data, count, error } = await client
        .from('attendance')
        .select('*', { count: 'exact' })
        .range(0, 9);
      return { success: true, count, dataLength: data?.length, data, error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  @Get('stats/weekly')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getWeeklyStats() {
    return this.attendanceService.weeklyStats();
  }

  @Get('stats/sessions')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getSessionStats() {
    return this.attendanceService.sessionStats();
  }

  @Get()
  // @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getAttendance(
    @Query('search') search?: string,
    @Query('date') date?: string,
    @Query('serviceType') serviceType?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.attendanceService.findAll({
      search,
      date,
      serviceType,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  // Temporary debug endpoint to inspect raw attendance rows. Enabled only in non-production.
  @Get('debug/raw')
  @Roles('Super Admin', 'Church Admin')
  async getRaw(@Query('limit') limit?: string) {
    const max = limit ? parseInt(limit) : 100;
    return this.attendanceService.debugRaw(max);
  }

  @Post()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async markAttendance(
    @Body()
    body: {
      memberId: string;
      date?: string;
      time?: string;
      serviceType: string;
      status: string;
    },
  ) {
    return this.attendanceService.markManually(body);
  }

  @Put(':id')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async updateAttendance(
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      serviceType?: string;
      date?: string;
      time?: string;
    },
  ) {
    return this.attendanceService.update(id, body);
  }

  @Delete(':id')
  @Roles('Super Admin', 'Church Admin')
  async deleteAttendance(@Param('id') id: string) {
    return this.attendanceService.remove(id);
  }

  @Get('export/csv')
  @Roles('Super Admin', 'Church Admin', 'Pastor')
  async downloadCsv(
    @Res() res: Response,
    @Query('date') date?: string,
    @Query('serviceType') serviceType?: string,
  ) {
    const csvContent = await this.attendanceService.exportCsv({ date, serviceType });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_export_${Date.now()}.csv`);
    return res.status(HttpStatus.OK).send(csvContent);
  }
}
