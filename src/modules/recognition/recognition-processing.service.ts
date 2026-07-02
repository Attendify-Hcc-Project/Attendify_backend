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
              // convert detection_time to a rough timestamp for today
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
    // Clean up older than 12 hours
    this.recentUnknownVisitors = this.recentUnknownVisitors.filter(v => now - v.timestamp < 12 * 60 * 60 * 1000);

    const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');
    // Using euclidean distance logic that face-api typically uses
    for (const v of this.recentUnknownVisitors) {
      let sum = 0;
      for (let i = 0; i < descriptor.length; i++) {
        sum += Math.pow(descriptor[i] - v.descriptor[i], 2);
      }
      const distance = Math.sqrt(sum);
      // for Euclidean distance, lower is better. Assuming threshold is around 0.5 - 0.6 for a match.
      // If we are doing similarity (inner product) we might need cosine distance. 
      // But typically distance < 0.5 is a match for euclidean. Let's use 0.5 as safe cutoff.
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
    this.logger.log(`Kiosk frame received. Buffer size: ${frameBuffer.length}`);
    try {
      const detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      this.logger.log(`Kiosk face detections: ${detections.length}`);

      if (detections.length > 0) {
        const client = this.supabaseService.getClient();
        const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

        for (const det of detections) {
          const descriptor = Array.from(det.descriptor);
          const bestMemberMatch = await this.findBestMemberMatch(client, descriptor, threshold);

          if (bestMemberMatch) {
            const isAlreadyMarked = await this.markMatchAttendance(bestMemberMatch.memberId, cameraName);
            return { matched: true, memberId: bestMemberMatch.memberId, alreadyMarked: isAlreadyMarked };
          }

          const isDuplicate = this.isDuplicateUnknown(descriptor);
          if (isDuplicate) {
            this.logger.log(`Skipping duplicate unknown visitor for camera: ${cameraName}`);
            return { matched: false, alreadyMarked: false, alreadyCaptured: true };
          }

          const existingVisitor = await this.findSimilarPendingVisitor(client, descriptor, threshold);
          if (existingVisitor) {
            this.logger.log(`Skipping repeated pending visitor capture for camera: ${cameraName}`);
            return { matched: false, alreadyMarked: false, alreadyCaptured: true };
          }

          await this.processUnknownVisitor(null, cameraName, frameBuffer, det.croppedBuffer, det.descriptor);
          return { matched: false, alreadyMarked: false, alreadyCaptured: false };
        }
      }

      this.logger.warn(`No face detected by face-api; skipping visitor capture.`);
      return { matched: false };
    } catch (err) {
      this.logger.error(`Kiosk frame processing failed`, err);
      // Even on error try to save snapshot
      try {
        await this.processUnknownVisitor(null, cameraName, frameBuffer, frameBuffer, new Float32Array(128));
      } catch (_) { }
      return { matched: false };
    }
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
        const descriptor = Array.from(det.descriptor);
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

    // Use the server's OS local time — Node.js getHours/getDay/etc. all respect the OS timezone.
    // This correctly reflects the actual local time wherever the server is running.
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

    // Load member name & details early so we can broadcast errors
    const { data: member } = await client
      .from('members')
      .select('first_name, last_name, profile_photo_url')
      .eq('id', memberId)
      .single();

    if (!member) return false;

    // Check duplicate check-in window (already marked for this service today)
    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', memberId)
      .eq('date', today)
      .eq('service_type', serviceType)
      .maybeSingle();

    if (existing) {
      this.logger.log(`Member ${memberId} already checked in today for ${serviceType}`);
      // Emit live WebSocket event so the kiosk UI shows "Already Marked"
      this.recognitionGateway.server.emit('visitor_detected', {
        id: crypto.randomUUID(),
        alreadyMarked: true,
        memberName: `${member.first_name} ${member.last_name}`,
        serviceType,
        time: currentTime
      });
      return true;
    }

    // Calculate punctuality using system local hour/minute
    const currentMins = localHour * 60 + localMin;
    const startMins = activeService.startTimeHour * 60 + activeService.startTimeMinute;
    const minutes_difference = currentMins - startMins; // Negative = early, positive = late

    let punctuality_status = 'On Time';
    if (minutes_difference < -15) punctuality_status = 'Early';
    else if (minutes_difference > 15) punctuality_status = 'Late';

    // Create attendance record
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

    // Emit live Socket.io event to frontend UI
    this.recognitionGateway.broadcastAttendanceMarked({
      id: newRecord.id,
      memberName: `${member.first_name} ${member.last_name}`,
      photoUrl: member.profile_photo_url || '',
      time: currentTime,
      serviceType,
      status: 'Present'
    });
    return false; // not "already marked", it was a fresh mark!
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

      // Upload files to Supabase Storage if buffers are non-empty
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

      // Default fallback images for demonstration if upload is bypassed
      // if (!snapshotUrl) snapshotUrl = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400';
      // if (!cropUrl) cropUrl = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150';

      if (!snapshotUrl || !cropUrl) {
        throw new Error('Failed to upload snapshot or crop to Supabase Storage.');
      }

      // Insert visitor record
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

      // Broadcast WebSocket notification to dashboard
      const location = cameraId ? await this.getCameraLocation(cameraId) : 'Live Kiosk';
      this.recognitionGateway.broadcastVisitorDetected({
        id: visitorId,
        capturedFaceUrl: cropUrl,
        snapshotUrl: snapshotUrl,
        time: currentTime,
        cameraName,
        location
      });
    } catch (err) {
      this.logger.error(`Failed to record unrecognized visitor: ${err?.message || err}`);
    }
  }

  private getActiveServiceDetails(localNow: Date): { name: string, startTimeHour: number, startTimeMinute: number } {
    // ─── DEVELOPER TEST OVERRIDE ──────────────────────────────────────────────
    // If DEV_SERVICE_OVERRIDE is set in .env, skip real-time detection entirely.
    // Remove the env var before going live.
    const devOverride = process.env.DEV_SERVICE_OVERRIDE?.trim();
    if (devOverride) {
      this.logger.warn(`[DEV MODE] Service overridden to: "${devOverride}" — remove DEV_SERVICE_OVERRIDE from .env for production!`);
      return { name: devOverride, startTimeHour: localNow.getHours(), startTimeMinute: localNow.getMinutes() };
    }
    // ─────────────────────────────────────────────────────────────────────────

    const day = localNow.getDay();       // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
    const hour = localNow.getHours();
    const mins = localNow.getMinutes();
    const currentMins = hour * 60 + mins;


    // Helper to determine Sunday theme based on week-of-month
    const getSundayTheme = (d: Date) => {
      const dayOfMonth = d.getDate();
      const month = d.getMonth();
      const year = d.getFullYear();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      // Find last Sunday of month
      const lastDay = new Date(year, month, daysInMonth);
      const lastSundayDate = daysInMonth - lastDay.getDay();

      if (dayOfMonth >= lastSundayDate) return 'Communion Service';
      if (dayOfMonth <= 7) return 'Thanksgiving Service';
      if (dayOfMonth <= 14) return 'Family Service';
      return 'Normal Service';
    };

    // ----- Service Schedule (HCC Achievers Arena Abuja) -----
    // Sunday: First Service 8am–10am, Second Service 10am–12pm
    if (day === 0) {
      const theme = getSundayTheme(localNow);
      if (currentMins >= 7 * 60 && currentMins < 10 * 60) {
        return { name: `Sunday First Service – ${theme}`, startTimeHour: 8, startTimeMinute: 0 };
      }
      if (currentMins >= 10 * 60 && currentMins < 13 * 60) {
        return { name: `Sunday Second Service – ${theme}`, startTimeHour: 10, startTimeMinute: 0 };
      }
    }

    // Tuesday: Breakthrough Fire Service 9am–11am
    if (day === 2 && currentMins >= 8 * 60 && currentMins <= 12 * 60) {
      return { name: 'Breakthrough Fire Service', startTimeHour: 9, startTimeMinute: 0 };
    }

    // Thursday: Empowerment Service 5:30pm–7:30pm
    if (day === 4 && currentMins >= 16 * 60 && currentMins <= 21 * 60) {
      return { name: 'Empowerment Service', startTimeHour: 17, startTimeMinute: 30 };
    }

    // Outside scheduled service hours — label clearly as practice/testing
    return { name: 'Practice / Testing Session', startTimeHour: hour, startTimeMinute: mins };
  }

  private async getCameraLocation(cameraId: string): Promise<string> {
    const client = this.supabaseService.getClient();
    const { data } = await client.from('camera_streams').select('location').eq('id', cameraId).maybeSingle();
    return data?.location || 'Unknown Location';
  }
}
