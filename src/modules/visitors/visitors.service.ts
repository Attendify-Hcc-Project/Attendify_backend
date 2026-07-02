import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { MembersService } from '../members/members.service';

@Injectable()
export class VisitorsService {
  constructor(
    private supabaseService: SupabaseService,
    private membersService: MembersService,
  ) {}

  async findAll(filters: { status?: string; limit?: number; offset?: number }) {
    const client = this.supabaseService.getClient();
    let query = client
      .from('visitors')
      .select('*', { count: 'exact' });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });

    const { data, count, error } = await query;
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { visitors: data, totalCount: count };
  }

  async updateStatus(id: string, status: 'Pending' | 'Registered' | 'Ignored') {
    const { data, error } = await this.supabaseService.getClient()
      .from('visitors')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  /**
   * Promotes a visitor to a full registered member, copying their captured face photo
   */
  async promoteToMember(
    visitorId: string,
    memberData: {
      firstName: string;
      lastName: string;
      phoneNumber?: string;
      email?: string;
      gender: string;
      dateOfBirth?: string;
      department?: string;
    },
  ) {
    const client = this.supabaseService.getClient();

    // 1. Fetch visitor details
    const { data: visitor, error: fetchErr } = await client
      .from('visitors')
      .select('*')
      .eq('id', visitorId)
      .single();

    if (fetchErr || !visitor) {
      throw new HttpException('Visitor not found', HttpStatus.NOT_FOUND);
    }

    // 2. Create the member record with all provided fields
    const member = await this.membersService.create({
      firstName: memberData.firstName,
      lastName: memberData.lastName,
      phoneNumber: memberData.phoneNumber,
      email: memberData.email,
      gender: memberData.gender,
      dateOfBirth: memberData.dateOfBirth,
      department: memberData.department,
      profilePhotoUrl: visitor.captured_face_url || null,
      status: 'Active',
    });

    // 3. Copy face embedding from visitor to member_faces
    if (visitor.notes && visitor.notes.startsWith('[')) {
      try {
        const embedding = visitor.notes;
        const { error: dbErr } = await client
          .from('member_faces')
          .insert({
            member_id: member.id,
            face_type: 'front',
            photo_url: visitor.captured_face_url,
            embedding: embedding
          });

        if (dbErr) {
          console.error('Failed to insert member face from visitor notes:', dbErr.message);
        }
      } catch (err) {
        console.error('Failed to copy visitor face embedding to member faces:', err?.message || err);
      }
    } else {
      console.warn('Visitor had no face descriptor stored in notes. Face will need to be re-registered manually.');
    }

    // 4. Update visitor status to 'Registered'
    await this.updateStatus(visitorId, 'Registered');

    return member;
  }
}

