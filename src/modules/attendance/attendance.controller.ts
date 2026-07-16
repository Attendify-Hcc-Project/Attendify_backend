import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Res, HttpStatus, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AttendanceService } from './attendance.service';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) { }


  @Get('stats/report-summary')
  async getReportSummary() {
    return this.attendanceService.reportSummary();
  }

  @Get('stats/monthly-overview')
  async getMonthlyOverview() {
    return this.attendanceService.monthlyOverview();
  }

  @Get('stats/group-breakdown')
  async getGroupBreakdown() {
    return this.attendanceService.groupBreakdown();
  }

  @Get('stats/session-trend')
  async getSessionTrend() {
    return this.attendanceService.sessionTrend();
  }

  @Get('stats/today')
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
  async getWeeklyStats() {
    return this.attendanceService.weeklyStats();
  }

  @Get('stats/sessions')
  async getSessionStats() {
    return this.attendanceService.sessionStats();
  }

  // NO AUTH GUARD - this is called from the kiosk (unauthenticated)
  @Get('lookup')
  async lookupByPhone(@Query('last4') last4: string) {
    if (!last4 || last4.length < 4) {
      throw new HttpException('Provide at least 4 digits of the phone number', HttpStatus.BAD_REQUEST);
    }
    return this.attendanceService.lookupByPhone(last4);
  }

  // NO AUTH GUARD - this is called from the kiosk for QR code lookup
  @Get('lookup-qr')
  async lookupByQrCode(@Query('qr') qr: string) {
    if (!qr) {
      throw new HttpException('Provide the QR code value', HttpStatus.BAD_REQUEST);
    }
    return this.attendanceService.lookupByQrCode(qr);
  }

  @Get()
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

  @Get('debug/raw')
  async getRaw(@Query('limit') limit?: string) {
    const max = limit ? parseInt(limit) : 100;
    return this.attendanceService.debugRaw(max);
  }

  @Post()
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
  async deleteAttendance(@Param('id') id: string) {
    return this.attendanceService.remove(id);
  }

  @Get('export/csv')
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

  // NO AUTH GUARD - this is called from kiosk
  @Post('mark')
  async markAttendanceMethod(@Body() body: { memberId: string; serviceType: string; method: string; status?: string }) {
    if (!body.memberId || !body.serviceType || !body.method) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }
    return this.attendanceService.markAttendance(body);
  }

  @Get('export/:format')
  @Roles('Super Admin', 'Church Admin', 'Pastor')
  async exportFormat(
    @Param('format') format: string,
    @Query('date') date: string,
    @Query('serviceType') serviceType: string,
    @Res() res: Response,
  ) {
    const filters = { date, serviceType };
    
    if (format === 'csv') {
      const csv = await this.attendanceService.exportCsv(filters);
      res.header('Content-Type', 'text/csv');
      res.attachment('attendance.csv');
      return res.send(csv);
    } else if (format === 'xlsx') {
      const buffer = await this.attendanceService.exportExcel(filters);
      res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.attachment('attendance.xlsx');
      return res.send(buffer);
    } else if (format === 'pdf') {
      const buffer = await this.attendanceService.exportPdf(filters);
      res.header('Content-Type', 'application/pdf');
      res.attachment('attendance.pdf');
      return res.send(buffer);
    } else if (format === 'docx') {
      const buffer = await this.attendanceService.exportDocx(filters);
      res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.attachment('attendance.docx');
      return res.send(buffer);
    }
    
    return res.status(400).send('Invalid format');
  }

}