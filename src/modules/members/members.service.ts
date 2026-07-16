import * as crypto from 'crypto';
import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { FaceRecognitionService } from '../recognition/face-recognition.service';

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private supabaseService: SupabaseService,
    private faceRecognitionService: FaceRecognitionService,
  ) {}

  async findAll(filters: { search?: string; department?: string; status?: string; limit?: number; offset?: number }) {
    const client = this.supabaseService.getClient();
    let query = client.from('members').select('*', { count: 'exact' });

    if (filters.search) {
      query = query.or(`first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%`);
    }
    if (filters.department) {
      query = query.eq('department', filters.department);
    }
    if (filters.status) {
      query = query.eq('membership_status', filters.status);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });

    const { data, count, error } = await query;
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { members: data, totalCount: count };
  }

  async findOne(id: string) {
    const client = this.supabaseService.getClient();
    const { data: member, error: memberErr } = await client
      .from('members')
      .select('*')
      .eq('id', id)
      .single();

    if (memberErr || !member) {
      throw new HttpException('Member not found', HttpStatus.NOT_FOUND);
    }

    const { data: faces, error: facesErr } = await client
      .from('member_faces')
      .select('id, face_type, photo_url')
      .eq('member_id', id);

    return {
      ...member,
      faces: facesErr ? [] : faces,
    };
  }

  async create(body: {
    firstName: string;
    lastName: string;
    phoneNumber?: string;
    email?: string;
    gender: string;
    dateOfBirth?: string;
    department?: string;
    address?: string;
    status?: string;
    profilePhotoUrl?: string;
  }) {
    const { data, error } = await this.supabaseService.getClient()
      .from('members')
      .insert({
        first_name: body.firstName,
        last_name: body.lastName,
        full_name: `${body.firstName} ${body.lastName}`,
        phone_number: body.phoneNumber || null,
        email: body.email || null,
        gender: body.gender,
        date_of_birth: body.dateOfBirth || null,
        department: body.department || null,
        membership_status: body.status || 'Active',
        profile_photo_url: body.profilePhotoUrl || null,
        address: body.address || null,
        qr_code: require('crypto').randomUUID(),
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  async update(id: string, body: any) {
    const updateData: any = {};
    if (body.firstName !== undefined) updateData.first_name = body.firstName;
    if (body.lastName !== undefined) updateData.last_name = body.lastName;
    if (body.phoneNumber !== undefined) updateData.phone_number = body.phoneNumber;
    if (body.email !== undefined) updateData.email = body.email;
    if (body.gender !== undefined) updateData.gender = body.gender;
    if (body.dateOfBirth !== undefined) updateData.date_of_birth = body.dateOfBirth;
    if (body.department !== undefined) updateData.department = body.department;
    if (body.status !== undefined) updateData.membership_status = body.status;
    if (body.profilePhotoUrl !== undefined) updateData.profile_photo_url = body.profilePhotoUrl;
    if (body.address !== undefined) updateData.address = body.address;

    const { data, error } = await this.supabaseService.getClient()
      .from('members')
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
      .from('members')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { message: 'Member profile deleted successfully', id };
  }

  /**
   * Generates face embedding for an uploaded photo and stores the face mapping in public.member_faces
   */
  async registerFaceImage(memberId: string, faceType: 'front' | 'left' | 'right', fileBuffer: Buffer, fileName: string) {
    const client = this.supabaseService.getClient();

    // 1. Process image using FaceRecognitionService
    const detections = await this.faceRecognitionService.processImageBuffer(fileBuffer);
    
    if (detections.length === 0) {
      throw new HttpException('No face detected in the uploaded image. Please retry with a clear photo.', HttpStatus.BAD_REQUEST);
    }
    if (detections.length > 1) {
      throw new HttpException('Multiple faces detected. Please upload an image with only one person.', HttpStatus.BAD_REQUEST);
    }

    const faceData = detections[0];
    const embeddingArray = Array.from(faceData.descriptor);

    // 2. Upload file to Supabase Storage Bucket
    const storagePath = `faces/${memberId}/${faceType}_${Date.now()}.jpg`;
    const { error: uploadError } = await client.storage
      .from('member-photos')
      .upload(storagePath, fileBuffer, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      this.logger.error(`Failed to upload face image to storage`, uploadError.message);
      throw new HttpException(`Storage upload failed: ${uploadError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const { data: { publicUrl } } = client.storage.from('member-photos').getPublicUrl(storagePath);

    // 3. Delete existing face of same type for the member if present
    await client.from('member_faces').delete().eq('member_id', memberId).eq('face_type', faceType);

    // 4. Save embedding and url
    const { data, error: dbErr } = await client
      .from('member_faces')
      .insert({
        member_id: memberId,
        face_type: faceType,
        photo_url: publicUrl,
        embedding: `[${embeddingArray.join(',')}]`
      })
      .select()
      .single();

    if (dbErr) {
      this.logger.error(`Failed to save face embedding to database`, dbErr.message);
      throw new HttpException(`Database save failed: ${dbErr.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Update member's primary profile photo if registering front face
    if (faceType === 'front') {
      await client.from('members').update({ profile_photo_url: publicUrl }).eq('id', memberId);
    }

    return data;
  }
}
