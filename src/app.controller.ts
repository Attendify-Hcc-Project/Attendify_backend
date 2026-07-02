import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello() {
    return {
      status: 'ok',
      message: 'Attendify API is running smoothly!',
      timestamp: new Date().toISOString()
    };
  }

  /** Public diagnostic — no auth. Visit http://localhost:3001/api/server-time in browser */
  @Get('server-time')
  getServerTime() {
    const now = new Date();
    const DAY = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const localTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const day  = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();

    // Check developer override
    const devOverride = process.env.DEV_SERVICE_OVERRIDE?.trim();

    let activeService: string;
    let devModeActive = false;

    if (devOverride) {
      activeService = `🛠️ [DEV OVERRIDE] "${devOverride}"`;
      devModeActive = true;
    } else if (day === 0 && mins >= 7*60  && mins < 10*60)  activeService = '✅ Sunday First Service (8:00–10:00 AM)';
    else if   (day === 0 && mins >= 10*60 && mins < 13*60)  activeService = '✅ Sunday Second Service (10:00 AM–12:00 PM)';
    else if   (day === 2 && mins >= 8*60  && mins <= 12*60)  activeService = '✅ Breakthrough Fire Service — Tuesday';
    else if   (day === 4 && mins >= 16*60 && mins <= 21*60)  activeService = '✅ Empowerment Service — Thursday';
    else activeService = '⚠️  No service scheduled right now — Practice / Testing mode';

    return {
      serverLocalTime: localTime,
      dayOfWeek: DAY[day],
      utcTime: now.toISOString(),
      timezoneOffset: `UTC${-now.getTimezoneOffset() >= 0 ? '+' : ''}${-now.getTimezoneOffset() / 60}`,
      activeService,
      devModeActive,
      devModeNote: devModeActive
        ? '⚠️ DEV_SERVICE_OVERRIDE is active in .env — remove it before going live!'
        : '✅ Running in production mode (real schedule)',
      schedule: {
        tuesday:  'Breakthrough Fire Service  —  9:00 AM to 11:00 AM',
        thursday: 'Empowerment Service        —  5:30 PM to  7:30 PM',
        sunday:   'First Service 8–10 AM  |  Second Service 10 AM–12 PM',
      },
    };
  }

  @Get('debug-attendance')
  async getDebugAttendance() {
    return { ok: true };
  }
}
