import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT') || 587;
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log('Email transporter initialized');
    } else {
      this.logger.warn('SMTP credentials not configured. Email sending will be disabled.');
    }
  }

  async sendQrCode(to: string, memberName: string, qrCodeValue: string): Promise<{ success: boolean; message: string }> {
    if (!this.transporter) {
      return { success: false, message: 'Email service not configured. Please add SMTP settings to .env' };
    }

    const from = this.configService.get<string>('SMTP_FROM') || 'HCC Attendance';

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: `Welcome to HCC, ${memberName}! Your Check-In QR Code`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 16px 16px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to HCC!</h1>
              <p style="color: rgba(255,255,255,0.85); margin-top: 8px;">Hello, ${memberName}. We're glad to have you!</p>
            </div>
            <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="font-size: 16px; color: #444;">Your unique Church Check-In QR Code is below:</p>
              <div style="background: white; display: inline-block; padding: 16px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin: 16px 0;">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrCodeValue}" 
                     alt="Your QR Code" width="200" height="200" style="display: block;" />
              </div>
              <p style="font-size: 14px; color: #666; margin-top: 16px;">
                Present this QR code at the church entrance to check in for any service.
              </p>
              <p style="font-size: 12px; color: #999; margin-top: 24px;">
                God bless you! — HCC Attendance Team
              </p>
            </div>
          </div>
        `,
      });
      this.logger.log(`QR code email sent to ${to}`);
      return { success: true, message: `Email successfully sent to ${to}` };
    } catch (err: any) {
      this.logger.error('Failed to send QR code email:', err.message);
      return { success: false, message: err.message };
    }
  }
}
