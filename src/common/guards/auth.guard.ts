import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../modules/supabase/supabase.service';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error('JWT_SECRET not configured on server');
      }
      
      const decoded = jwt.verify(token, secret) as any;
      
      // We don't have full user data from token alone, but we have enough for role checks
      // Usually roles are in decoded.app_metadata or decoded.role

      // Email verification check (from GoTrue token metadata)
      const isEmailConfirmed = decoded.app_metadata?.provider !== 'email' || 
                              decoded.user_metadata?.email_verified || 
                              decoded.email_confirmed_at;

      request.user = {
        id: decoded.sub,
        role: decoded.role || decoded.app_metadata?.role || decoded.user_metadata?.role || 'Viewer',
        email: decoded.email,
        email_confirmed_at: isEmailConfirmed ? new Date().toISOString() : null,
      };

      // strict block for unconfirmed emails
      if (decoded.app_metadata?.provider === 'email' && !request.user.email_confirmed_at) {
         throw new UnauthorizedException('Please verify your email address before logging in.');
      }

      return true;
    } catch (err) {
      console.error('[AuthGuard] Token verification failed:', err?.message || err);
      
      // If it's explicitly a jwt malformed or invalid signature error, maybe the secret is wrong?
      if (err?.message?.includes('signature') || err?.message?.includes('malformed')) {
        console.error('[AuthGuard] CRITICAL: JWT_SECRET might be incorrect or token is severely malformed.');
      }
      
      throw new UnauthorizedException(`Session expired or invalid token: ${err?.message}`);
    }
  }
}
