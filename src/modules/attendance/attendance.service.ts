import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit');
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AttendanceService {
  constructor(private supabaseService: SupabaseService) {}

  async findAll(filters: { search?: string; date?: string; serviceType?: string; limit?: number; offset?: number }) {
    const client = this.supabaseService.getClient();
    
    // We select attendance joining member details
    let query = client
      .from('attendance')
      .select(`
        *,
        members (
          first_name,
          last_name,
          full_name,
          department,
          profile_photo_url
        )
      `, { count: 'exact' });

    if (filters.date) {
      query = query.eq('date', filters.date);
    }
    if (filters.serviceType) {
      query = query.eq('service_type', filters.serviceType);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1).order('date', { ascending: false }).order('time', { ascending: false });

    const { data, count, error } = await query;
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Client-side mapping to resolve nested array structure and search filtering
    let records = data || [];
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      records = records.filter(r => {
        const member = r.members as any;
        if (!member) return false;
        const fullName = member.full_name || `${member.first_name || ''} ${member.last_name || ''}`;
        return fullName.toLowerCase().includes(searchLower);
      });
    }

    // Map records to include member_name for frontend
    const mappedRecords = records.map(r => {
      const member = r.members as any;
      const rawMarkedBy: string = r.marked_by || '';
      return {
        ...r,
        member_name: member?.full_name || `${member?.first_name || ''} ${member?.last_name || ''}`.trim() || 'Unknown',
        member_photo: member?.profile_photo_url || null,
        service_session: r.service_type,
        marked_at: r.created_at || `${r.date}T${r.time}`,
        // Normalize status to lowercase so frontend STATUS_CONFIG matches
        status: (r.status || 'present').toLowerCase(),
        // Map marked_by to 'ai' or 'manual' for frontend badge
        marked_by: rawMarkedBy.toUpperCase().startsWith('AI') ? 'ai' : 'manual',
        marked_by_label: rawMarkedBy, // keep original label for display
      };
    });

    console.log(`[DEBUG] getAttendance filters:`, filters);
    console.log(`[DEBUG] getAttendance returning ${mappedRecords.length} records. Count: ${count}. Error:`, error);
    return { items: mappedRecords, total: count };
  }


  async lookupByPhone(last4: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('members')
      .select('id, full_name, profile_photo_url, phone_number')
      .like('phone_number', `%${last4}`);
    
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return data;
  }

  async lookupByQrCode(qrCode: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('members')
      .select('id, full_name, profile_photo_url, phone_number, qr_code')
      .eq('qr_code', qrCode)
      .maybeSingle();
    
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    if (!data) {
      throw new HttpException('Member not found with this QR code', HttpStatus.NOT_FOUND);
    }
    return data;
  }

  async markAttendance(body: { memberId: string; serviceType: string; method: string; status?: string }) {
    const client = this.supabaseService.getClient();
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toTimeString().split(' ')[0];

    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', body.memberId)
      .eq('date', date)
      .eq('service_type', body.serviceType)
      .maybeSingle();

    if (existing) {
      throw new HttpException('Attendance already recorded for this member and service session', HttpStatus.CONFLICT);
    }

    const { data, error } = await client
      .from('attendance')
      .insert({
        member_id: body.memberId,
        date,
        time,
        service_type: body.serviceType,
        status: body.status || 'present',
        marked_by: body.method === 'QR Code' ? 'QR Check-in' : 'Phone Check-in',
        method: body.method
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  // Debug helper - returns raw attendance rows (no mapping) for diagnostics
  async debugRaw(limit = 100) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client.from('attendance').select('*').limit(limit).order('created_at', { ascending: false });
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return data;
  }

  async markManually(body: { memberId: string; date?: string; time?: string; serviceType: string; status: string }) {
    const client = this.supabaseService.getClient();
    const date = body.date || new Date().toISOString().split('T')[0];
    const time = body.time || new Date().toTimeString().split(' ')[0];

    // Check duplicate check-in
    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', body.memberId)
      .eq('date', date)
      .eq('service_type', body.serviceType)
      .maybeSingle();

    if (existing) {
      throw new HttpException('Attendance already recorded for this member and service session', HttpStatus.CONFLICT);
    }

    const { data, error } = await client
      .from('attendance')
      .insert({
        member_id: body.memberId,
        date,
        time,
        service_type: body.serviceType,
        status: body.status || 'Present',
        marked_by: 'Manual Check'
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  async update(id: string, body: { status?: string; serviceType?: string; date?: string; time?: string }) {
    const updateData: any = {};
    if (body.status !== undefined) updateData.status = body.status;
    if (body.serviceType !== undefined) updateData.service_type = body.serviceType;
    if (body.date !== undefined) updateData.date = body.date;
    if (body.time !== undefined) updateData.time = body.time;

    const { data, error } = await this.supabaseService.getClient()
      .from('attendance')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  async remove(id: string) {
    const { data, error } = await this.supabaseService.getClient()
      .from('attendance')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { message: 'Attendance record deleted successfully', id };
  }

  async todayStats() {
    const client = this.supabaseService.getClient();
    const today = new Date().toISOString().split('T')[0];

    const [members, todayAtt, cameras] = await Promise.all([
      client.from('members').select('id', { count: 'exact', head: true }),
      client.from('attendance').select('id', { count: 'exact', head: true }).eq('date', today),
      client.from('camera_streams').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    const unknownRes = await client
      .from('unknown_visitors')
      .select('id', { count: 'exact', head: true })
      .eq('review_status', 'pending');

    const totalMembers = members.count ?? 0;
    const todayAttendance = todayAtt.count ?? 0;
    const attendanceRate = totalMembers > 0 ? Math.round((todayAttendance / totalMembers) * 100) : 0;

    return {
      totalMembers,
      todayAttendance,
      activeCameras: cameras.count ?? 0,
      unknownVisitors: unknownRes.count ?? 0,
      attendanceRate,
    };
  }

  async weeklyStats() {
    const client = this.supabaseService.getClient();
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday

    const result = await Promise.all(
      days.map(async (day, i) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];

        const [att, vis] = await Promise.all([
          client.from('attendance').select('id', { count: 'exact', head: true }).eq('date', dateStr),
          client.from('unknown_visitors').select('id', { count: 'exact', head: true }).gte('created_at', `${dateStr}T00:00:00`).lte('created_at', `${dateStr}T23:59:59`),
        ]);
        return { day, count: att.count ?? 0, visitors: vis.count ?? 0 };
      })
    );

    return result;
  }

  async sessionStats() {
    const client = this.supabaseService.getClient();
    const today = new Date().toISOString().split('T')[0];

    const { data } = await client
      .from('attendance')
      .select('service_type')
      .eq('date', today);

    if (!data) return [];

    const breakdown: Record<string, number> = {};
    for (const row of data) {
      const key = row.service_type || 'Other';
      breakdown[key] = (breakdown[key] || 0) + 1;
    }

    return Object.entries(breakdown).map(([name, value]) => ({ name, value }));
  }

  /**
   * Generates a raw CSV spreadsheet string containing the filtered check-in logs
   */
  async exportCsv(filters: { date?: string; serviceType?: string }) {
    const { items: records } = await this.findAll({ ...filters, limit: 10000 });
    
    let csv = 'ID,Name,Department,Date,Time,Service,Status,Marked By\n';
    
    for (const r of records as any[]) {
      const name = `"${r.member_name || 'Unknown'}"`;
      const dept = `"${(r.members as any)?.department || ''}"`;
      csv += `${r.id},${name},${dept},${r.date},${r.time},"${r.service_type}",${r.status},"${r.marked_by}"\n`;
    }

    return csv;
  }


  async exportExcel(filters: { date?: string; serviceType?: string }) {
    const { items: records } = await this.findAll({ ...filters, limit: 10000 });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Attendance');
    
    sheet.columns = [
      { header: 'ID', key: 'id', width: 32 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Time', key: 'time', width: 15 },
      { header: 'Service', key: 'service', width: 25 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Marked By', key: 'markedBy', width: 20 },
    ];
    
    for (const r of records as any[]) {
      sheet.addRow({
        id: r.id,
        name: r.member_name || 'Unknown',
        department: (r.members as any)?.department || '',
        date: r.date,
        time: r.time,
        service: r.service_type,
        status: r.status,
        markedBy: r.marked_by
      });
    }
    
    return await workbook.xlsx.writeBuffer();
  }

  async exportPdf(filters: { date?: string; serviceType?: string }): Promise<Buffer> {
    const { items: records } = await this.findAll({ ...filters, limit: 10000 });
    
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 30 });
        const buffers: Buffer[] = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        
        doc.fontSize(20).text('Attendance Report', { align: 'center' });
        doc.moveDown();
        
        for (const r of records as any[]) {
          const name = r.member_name || 'Unknown';
          const dept = (r.members as any)?.department || 'N/A';
          doc.fontSize(10).text(`Name: ${name} | Dept: ${dept} | Service: ${r.service_type} | Date: ${r.date} ${r.time} | Status: ${r.status}`);
        }
        
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  async exportDocx(filters: { date?: string; serviceType?: string }): Promise<Buffer> {
    const { items: records } = await this.findAll({ ...filters, limit: 10000 });
    
    let html = '<html><head><meta charset="utf-8"><style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #333;padding:6px 10px;text-align:left;font-size:12px}th{background:#2c5aa0;color:#fff;font-weight:bold}tr:nth-child(even){background:#f2f6fc}h1{font-family:Arial;color:#2c5aa0;text-align:center}</style></head><body>';
    html += '<h1>Attendance Report</h1>';
    html += '<table><tr><th>Name</th><th>Department</th><th>Date</th><th>Time</th><th>Service</th><th>Status</th><th>Marked By</th></tr>';
    
    for (const r of records as any[]) {
      html += '<tr>';
      html += `<td>${r.member_name || 'Unknown'}</td>`;
      html += `<td>${(r.members as any)?.department || ''}</td>`;
      html += `<td>${r.date}</td>`;
      html += `<td>${r.time}</td>`;
      html += `<td>${r.service_type || ''}</td>`;
      html += `<td>${r.status || ''}</td>`;
      html += `<td>${r.marked_by || ''}</td>`;
      html += '</tr>';
    }
    
    html += '</table></body></html>';
    return Buffer.from(html, 'utf8');
  }

  async reportSummary() {
    const client = this.supabaseService.getClient();
    
    const { count: totalMembers } = await client
      .from('members')
      .select('*', { count: 'exact', head: true });
      
    const { count: totalVisitors } = await client
      .from('visitors')
      .select('*', { count: 'exact', head: true });
      
    const { data: attendance } = await client
      .from('attendance')
      .select('date');
      
    const uniqueSessions = new Set(attendance?.map(a => a.date) || []).size || 1;
    const totalAttendance = attendance?.length || 0;
    
    const avgAttendance = Math.round(totalAttendance / uniqueSessions);
    const attendanceRate = (totalMembers ?? 0) > 0 ? Math.round((avgAttendance / (totalMembers ?? 1)) * 100) : 0;
    
    const growthRate = 12.5;

    return {
      totalMembers: totalMembers || 0,
      totalVisitors: totalVisitors || 0,
      avgAttendance,
      attendanceRate,
      growthRate
    };
  }

  async monthlyOverview() {
    const client = this.supabaseService.getClient();
    
    const currentYear = new Date().getFullYear();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const result = [];
    
    for (let i = 0; i < 12; i++) {
      const monthStr = `${currentYear}-${String(i + 1).padStart(2, '0')}`;
      
      const { count: membersCount } = await client
        .from('attendance')
        .select('id', { count: 'exact', head: true })
        .like('date', `${monthStr}%`);
        
      const { count: visitorsCount } = await client
        .from('visitors')
        .select('id', { count: 'exact', head: true })
        .like('created_at', `${monthStr}%`);
        
      result.push({
        name: months[i],
        members: membersCount || 0,
        visitors: visitorsCount || 0
      });
    }
    
    return result;
  }

  async groupBreakdown() {
    const client = this.supabaseService.getClient();
    
    const { data } = await client
      .from('members')
      .select('department');
      
    if (!data) return [];
    
    const breakdown = {};
    for (const row of data) {
      const dept = row.department || 'Unassigned';
      breakdown[dept] = (breakdown[dept] || 0) + 1;
    }
    
    return Object.entries(breakdown).map(([name, count]) => ({ name, count }));
  }

  async sessionTrend() {
    const client = this.supabaseService.getClient();
    
    const { data: dates } = await client
      .from('attendance')
      .select('date')
      .order('date', { ascending: false })
      .limit(100);
      
    const uniqueDates = [...new Set(dates?.map(d => d.date) || [])].slice(0, 4).reverse();
    
    const result = [];
    for (let i = 0; i < uniqueDates.length; i++) {
      const date = uniqueDates[i];
      const { data } = await client
        .from('attendance')
        .select('service_type')
        .eq('date', date);
        
      const breakdown = { name: `Week ${i + 1}` };
      for (const row of (data || [])) {
        const type = row.service_type || 'General Gathering';
        let shortType = 'evening';
        if (type.includes('First Service') || type.includes('1st')) shortType = 'first';
        else if (type.includes('Second Service') || type.includes('2nd')) shortType = 'second';
        else if (type.includes('Third Service') || type.includes('3rd')) shortType = 'third';
        
        breakdown[shortType] = (breakdown[shortType] || 0) + 1;
      }
      
      result.push(breakdown);
    }
    
    if (result.length === 0) {
       return [
         { name: 'Week 1', first: 0, second: 0, third: 0, evening: 0 },
         { name: 'Week 2', first: 0, second: 0, third: 0, evening: 0 }
       ];
    }
    
    return result;
  }

}
