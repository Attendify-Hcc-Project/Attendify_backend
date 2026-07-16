import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { FaceRecognitionService } from './face-recognition.service';
import { RecognitionGateway } from './recognition.gateway';
import * as crypto from 'crypto';

interface RecentUnknownVisitor {
  descriptor: number[];
  timestamp: number;
}

@Injectable()
export class RecognitionProcessingService implements OnModuleInit {
  private readonly logger = new Logger(RecognitionProcessingService.name);

  constructor(
    private supabaseService: SupabaseService,
    private faceRecognitionService: FaceRecognitionService,
    private recognitionGateway: RecognitionGateway,
    private configService: ConfigService,
  ) { }

  private recentUnknownVisitors: RecentUnknownVisitor[] = [];

  private parseDescriptor(notes: string | null | undefined): number[] | null {
    if (!notes) return null;

    try {
      const trimmed = notes.trim();
      if (!trimmed) return null;
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const values = parsed.map((value: any) => Number(value)).filter(Number.isFinite);
        return values.length > 0 ? values : null;
      }
    } catch {
      // Fallback to comma-separated values in the notes column
    }

    try {
      const trimmed = notes.trim();
      const normalized = trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;
      const values = normalized.split(',').map(value => Number(value.trim())).filter(Number.isFinite);
      return values.length > 0 ? values : null;
    } catch {
      return null;
    }
  }

  private getDescriptorDistance(left: number[], right: number[]): number {
    if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY;

    let sum = 0;
    for (let i = 0; i < left.length; i++) {
      const diff = left[i] - right[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  private async findBestMemberMatch(client: any, descriptor: number[], threshold: number) {
    try {
      const { data: matches, error } = await client.rpc('match_face', {
        query_embedding: `[${descriptor.join(',')}]`,
        match_threshold: threshold,
        match_count: 1,
      });

      if (!error && matches && matches.length > 0) {
        return { memberId: matches[0].member_id, score: matches[0].similarity ?? 1 };
      }
    } catch (error) {
      this.logger.warn(`RPC face matching unavailable, falling back to embedded comparison: ${error.message || error}`);
    }

    const { data: faces, error: facesError } = await client
      .from('member_faces')
      .select('member_id, embedding');

    if (facesError || !faces || faces.length === 0) {
      return null;
    }

    let bestMatch: { memberId: string; score: number } | null = null;
    const maxDistance = threshold < 1 ? threshold : 0.6;

    for (const face of faces) {
      const storedDescriptor = this.parseDescriptor(face.embedding);
      if (!storedDescriptor) continue;

      const distance = this.getDescriptorDistance(descriptor, storedDescriptor);
      if (distance < maxDistance && (!bestMatch || distance < bestMatch.score)) {
        bestMatch = { memberId: face.member_id, score: distance };
      }
    }

    return bestMatch;
  }

  private async findSimilarPendingVisitor(client: any, descriptor: number[], threshold: number) {
    const today = new Date().toISOString().split('T')[0];
    const { data: visitors, error } = await client
      .from('visitors')
      .select('id, notes')
      .eq('status', 'Pending')
      .eq('detection_date', today);

    if (error || !visitors || visitors.length === 0) {
      return null;
    }

    const maxDistance = threshold < 1 ? threshold : 0.6;
    for (const visitor of visitors) {
      const storedDescriptor = this.parseDescriptor(visitor.notes);
      if (!storedDescriptor) continue;

      const distance = this.getDescriptorDistance(descriptor, storedDescriptor);
      if (distance < maxDistance) {
        return visitor;
      }
    }

    return null;
  }

  async onModuleInit() {
    try {
      const client = this.supabaseService.getClient();
      const today = new Date().toISOString().split('T')[0];

      const { data: visitors } = await client
        .from('visitors')
        .select('notes, detection_time')
        .eq('status', 'Pending')
        .eq('detection_date', today);

      if (visitors && visitors.length > 0) {
        let loadedCount = 0;
        for (const v of visitors) {
          if (v.notes && v.notes.startsWith('[')) {
            try {
              const descriptor = JSON.parse(v.notes);
              const [hours, minutes, seconds] = v.detection_time.split(':');
              const d = new Date();
              d.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds), 0);

              this.recentUnknownVisitors.push({
                descriptor,
                timestamp: d.getTime()
              });
              loadedCount++;
            } catch (e) { }
          }
        }
        this.logger.log(`Loaded ${loadedCount} pending visitors into deduplication cache from DB.`);
      }
    } catch (err) {
      this.logger.error('Failed to load pending visitors for deduplication cache', err);
    }
  }

  private isDuplicateUnknown(descriptor: number[]): boolean {
    const now = Date.now();
    this.recentUnknownVisitors = this.recentUnknownVisitors.filter(v => now - v.timestamp < 12 * 60 * 60 * 1000);

    const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');
    for (const v of this.recentUnknownVisitors) {
      let sum = 0;
      for (let i = 0; i < descriptor.length; i++) {
        sum += Math.pow(descriptor[i] - v.descriptor[i], 2);
      }
      const distance = Math.sqrt(sum);
      if (distance < 0.55) {
        return true;
      }
    }
    this.recentUnknownVisitors.push({ descriptor: Array.from(descriptor), timestamp: now });
    return false;
  }

  /**
   * Processes a kiosk frame — tries face recognition first,
   * but ALWAYS saves the snapshot as a visitor if no known member is matched.
   * This guarantees every kiosk capture appears in the Pending visitors tab.
   */
  async processKioskFrame(cameraName: string, frameBuffer: Buffer): Promise<{ matched: boolean; memberId?: string; alreadyMarked?: boolean; alreadyCaptured?: boolean }> {
    this.logger.log(`[KIOSK] Frame received. Buffer size: ${frameBuffer.length}`);
    try {
      let detections: any[] = [];
      try {
        detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      } catch (faceErr: any) {
        this.logger.warn(`[KIOSK] Face detection threw error: ${faceErr?.message}. Will save raw image.`);
      }
      this.logger.log(`[KIOSK] Face detections: ${detections.length}`);

      if (detections.length > 0) {
        const client = this.supabaseService.getClient();
        const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

        for (const det of detections) {
          const descriptor = Array.from(det.descriptor) as number[];
          const bestMemberMatch = await this.findBestMemberMatch(client, descriptor, threshold);

          if (bestMemberMatch) {
            const isAlreadyMarked = await this.markMatchAttendance(bestMemberMatch.memberId, cameraName);
            return { matched: true, memberId: bestMemberMatch.memberId, alreadyMarked: isAlreadyMarked };
          }

          // Not a known member - save as visitor with cropped face
          await this.processUnknownVisitor(null, cameraName, frameBuffer, det.croppedBuffer, det.descriptor);
          return { matched: false, alreadyMarked: false, alreadyCaptured: false };
        }
      }

      // No face detected OR face-api threw. ALWAYS save the raw frame for kiosk captures.
      this.logger.log(`[KIOSK] No face detected by face-api. Saving raw frame as visitor.`);
      await this.saveKioskRawVisitor(cameraName, frameBuffer);
      return { matched: false, alreadyMarked: false, alreadyCaptured: false };
    } catch (err: any) {
      this.logger.error(`[KIOSK] Frame processing failed: ${err?.message}`, err?.stack);
      // Last resort: try saving raw frame
      try {
        await this.saveKioskRawVisitor(cameraName, frameBuffer);
      } catch (e: any) {
        this.logger.error(`[KIOSK] Even raw save failed: ${e?.message}`);
      }
      return { matched: false };
    }
  }

  /**
   * Saves a raw kiosk frame directly as a visitor — bypasses face detection entirely.
   * Used when face-api cannot find a face in the image.
   */
  private async saveKioskRawVisitor(cameraName: string, frameBuffer: Buffer) {
    const client = this.supabaseService.getClient();
    const visitorId = crypto.randomUUID();
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0];

    // Upload snapshot
    const snapshotPath = `snapshots/${visitorId}_snapshot.jpg`;
    const { error: snapErr } = await client.storage
      .from('camera-snapshots')
      .upload(snapshotPath, frameBuffer, { contentType: 'image/jpeg' });

    if (snapErr) {
      this.logger.error(`[KIOSK] Snapshot upload failed: ${snapErr.message}`);
      throw snapErr;
    }
    const snapshotUrl = client.storage.from('camera-snapshots').getPublicUrl(snapshotPath).data.publicUrl;

    // Upload crop (same image for raw saves)
    const cropPath = `crops/${visitorId}_crop.jpg`;
    const { error: cropErr } = await client.storage
      .from('visitor-images')
      .upload(cropPath, frameBuffer, { contentType: 'image/jpeg' });

    if (cropErr) {
      this.logger.error(`[KIOSK] Crop upload failed: ${cropErr.message}`);
      throw cropErr;
    }
    const cropUrl = client.storage.from('visitor-images').getPublicUrl(cropPath).data.publicUrl;

    // Insert visitor record
    const { data: visitor, error: insertErr } = await client
      .from('visitors')
      .insert({
        id: visitorId,
        captured_face_url: cropUrl,
        snapshot_url: snapshotUrl,
        detection_date: today,
        detection_time: currentTime,
        status: 'Pending',
        notes: 'Kiosk capture (no face detected)',
      })
      .select()
      .single();

    if (insertErr) {
      this.logger.error(`[KIOSK] Visitor DB insert failed: ${JSON.stringify(insertErr)}`);
      throw insertErr;
    }
    this.logger.log(`[KIOSK] Visitor saved to database: ${visitor.id}`);

    this.recognitionGateway.broadcastVisitorDetected({
      id: visitorId,
      capturedFaceUrl: cropUrl,
      snapshotUrl: snapshotUrl,
      time: currentTime,
      cameraName,
      location: 'Live Kiosk',
    });
  }

  /**
   * Processes a single image frame buffer for face recognition.
   * Used by CCTV streams (ffmpeg). Does NOT force-save.
   */
  async processFrame(cameraId: string | null, cameraName: string, frameBuffer: Buffer) {
    try {
      const detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      if (detections.length === 0) return;

      const client = this.supabaseService.getClient();
      const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

      for (const det of detections) {
        const descriptor = Array.from(det.descriptor) as number[];
        const bestMemberMatch = await this.findBestMemberMatch(client, descriptor, threshold);

        if (bestMemberMatch) {
          await this.markMatchAttendance(bestMemberMatch.memberId, cameraName);
        } else {
          const isDuplicate = this.isDuplicateUnknown(descriptor);
          if (!isDuplicate) {
            const existingVisitor = await this.findSimilarPendingVisitor(client, descriptor, threshold);
            if (!existingVisitor) {
              await this.processUnknownVisitor(cameraId, cameraName, frameBuffer, det.croppedBuffer, det.descriptor);
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`Frame execution failed on source ${cameraName}`, err);
    }
  }

  /**
   * Helper to write attendance logs in the database & push alerts
   */
  private async markMatchAttendance(memberId: string, cameraName: string) {
    const client = this.supabaseService.getClient();
    const now = new Date();

    const localYear = now.getFullYear();
    const localMonth = String(now.getMonth() + 1).padStart(2, '0');
    const localDay = String(now.getDate()).padStart(2, '0');
    const localHour = now.getHours();
    const localMin = now.getMinutes();
    const localSec = now.getSeconds();

    const today = `${localYear}-${localMonth}-${localDay}`;
    const currentTime = `${String(localHour).padStart(2, '0')}:${String(localMin).padStart(2, '0')}:${String(localSec).padStart(2, '0')}`;

    this.logger.log(`[Attendance] System local time: ${today} ${currentTime}, Day=${now.getDay()} (0=Sun,1=Mon...4=Thu)`);

    const activeService = this.getActiveServiceDetails(now);
    const serviceType = activeService.name;

    this.logger.log(`[Attendance] Detected service: "${serviceType}"`);

    const { data: member } = await client
      .from('members')
      .select('first_name, last_name, profile_photo_url')
      .eq('id', memberId)
      .single();

    if (!member) return false;

    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', memberId)
      .eq('date', today)
      .eq('service_type', serviceType)
      .maybeSingle();

    if (existing) {
      this.logger.log(`Member ${memberId} already checked in today for ${serviceType}`);
      this.recognitionGateway.server.emit('visitor_detected', {
        id: crypto.randomUUID(),
        alreadyMarked: true,
        memberName: `${member.first_name} ${member.last_name}`,
        serviceType,
        time: currentTime
      });
      return true;
    }

    const currentMins = localHour * 60 + localMin;
    const startMins = activeService.startTimeHour * 60 + activeService.startTimeMinute;
    const minutes_difference = currentMins - startMins;

    let punctuality_status = 'On Time';
    if (minutes_difference < -15) punctuality_status = 'Early';
    else if (minutes_difference > 15) punctuality_status = 'Late';

    const { data: newRecord, error } = await client
      .from('attendance')
      .insert({
        member_id: memberId,
        date: today,
        time: currentTime,
        service_type: serviceType,
        status: 'Present',
        marked_by: `AI (${cameraName})`,
        punctuality_status,
        minutes_difference,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to record attendance in database`, error.message);
      return false;
    }

    this.recognitionGateway.broadcastAttendanceMarked({
      id: newRecord.id,
      memberName: `${member.first_name} ${member.last_name}`,
      photoUrl: member.profile_photo_url || '',
      time: currentTime,
      serviceType,
      status: 'Present'
    });
    return false;
  }

  /**
   * Processes unknown face: uploads files, saves record, broadcasts ws alert
   */
  private async processUnknownVisitor(cameraId: string | null, cameraName: string, snapshot: Buffer, crop: Buffer, descriptor: Float32Array) {
    const client = this.supabaseService.getClient();
    const visitorId = crypto.randomUUID();
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0];

    try {
      let snapshotUrl = '';
      let cropUrl = '';

      if (snapshot && snapshot.length > 0) {
        const snapshotPath = `snapshots/${visitorId}_snapshot.jpg`;
        const { error: err1 } = await client.storage
          .from('camera-snapshots')
          .upload(snapshotPath, snapshot, { contentType: 'image/jpeg' });

        if (!err1) {
          snapshotUrl = client.storage.from('camera-snapshots').getPublicUrl(snapshotPath).data.publicUrl;
        } else {
          this.logger.error(`Snapshot upload failed: ${err1.message}`);
        }
      }

      if (crop && crop.length > 0) {
        const cropPath = `crops/${visitorId}_crop.jpg`;
        const { error: err2 } = await client.storage
          .from('visitor-images')
          .upload(cropPath, crop, { contentType: 'image/jpeg' });

        if (!err2) {
          cropUrl = client.storage.from('visitor-images').getPublicUrl(cropPath).data.publicUrl;
        } else {
          this.logger.error(`Crop upload failed: ${err2.message}`);
        }
      }

      if (!snapshotUrl || !cropUrl) {
        throw new Error('Failed to upload snapshot or crop to Supabase Storage.');
      }

      const insertPayload: any = {
        id: visitorId,
        captured_face_url: cropUrl,
        snapshot_url: snapshotUrl,
        detection_date: today,
        detection_time: currentTime,
        status: 'Pending',
        notes: `[${Array.from(descriptor).join(',')}]`
      };

      if (cameraId) {
        insertPayload.camera_id = cameraId;
      }

      const { data: visitor, error } = await client
        .from('visitors')
        .insert(insertPayload)
        .select()
        .single();

      if (error) {
        this.logger.error(`Visitor insert error: ${JSON.stringify(error)}`);
        throw error;
      }
      this.logger.log(`Visitor saved to database: ${visitor.id}`);

      const location = cameraId ? await this.getCameraLocation(cameraId) : 'Live Kiosk';
      this.recognitionGateway.broadcastVisitorDetected({
        id: visitorId,
        capturedFaceUrl: cropUrl,
        snapshotUrl: snapshotUrl,
        time: currentTime,
        cameraName,
        location
      });
    } catch (err: any) {
      this.logger.error(`Failed to record unrecognized visitor: ${err?.message || err}`);
    }
  }

  private getActiveServiceDetails(localNow: Date): { name: string, startTimeHour: number, startTimeMinute: number } {
    const devOverride = process.env.DEV_SERVICE_OVERRIDE?.trim();
    if (devOverride) {
      this.logger.warn(`[DEV MODE] Service overridden to: "${devOverride}" — remove DEV_SERVICE_OVERRIDE from .env for production!`);
      return { name: devOverride, startTimeHour: localNow.getHours(), startTimeMinute: localNow.getMinutes() };
    }

    const day = localNow.getDay();
    const hour = localNow.getHours();
    const mins = localNow.getMinutes();
    const currentMins = hour * 60 + mins;

    const getSundayTheme = (d: Date) => {
      const dayOfMonth = d.getDate();
      const month = d.getMonth();
      const year = d.getFullYear();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const lastDay = new Date(year, month, daysInMonth);
      const lastSundayDate = daysInMonth - lastDay.getDay();

      if (dayOfMonth >= lastSundayDate) return 'Communion Service';
      if (dayOfMonth <= 7) return 'Thanksgiving Service';
      if (dayOfMonth <= 14) return 'Family Service';
      return 'Normal Service';
    };

    if (day === 0) {
      const theme = getSundayTheme(localNow);
      if (currentMins >= 7 * 60 && currentMins < 10 * 60) {
        return { name: `Sunday First Service – ${theme}`, startTimeHour: 8, startTimeMinute: 0 };
      }
      if (currentMins >= 10 * 60 && currentMins < 13 * 60) {
        return { name: `Sunday Second Service – ${theme}`, startTimeHour: 10, startTimeMinute: 0 };
      }
    }

    if (day === 2 && currentMins >= 8 * 60 && currentMins <= 12 * 60) {
      return { name: 'Breakthrough Fire Service', startTimeHour: 9, startTimeMinute: 0 };
    }

    if (day === 4 && currentMins >= 16 * 60 && currentMins <= 21 * 60) {
      return { name: 'Empowerment Service', startTimeHour: 17, startTimeMinute: 30 };
    }

    return { name: 'Practice / Testing Session', startTimeHour: hour, startTimeMinute: mins };
  }

  private async getCameraLocation(cameraId: string): Promise<string> {
    const client = this.supabaseService.getClient();
    const { data } = await client.from('camera_streams').select('location').eq('id', cameraId).maybeSingle();
    return data?.location || 'Unknown Location';
  }
}
