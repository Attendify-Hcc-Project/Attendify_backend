import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../modules/supabase/supabase.service';

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
      const { data: { user }, error } = await this.supabaseService.getClient().auth.getUser(token);

      if (error || !user) {
        throw new Error(error?.message || 'Invalid user token');
      }

      const isEmailConfirmed = user.app_metadata?.provider !== 'email' || 
                              user.user_metadata?.email_verified || 
                              user.email_confirmed_at;

      request.user = {
        id: user.id,
        role: user.role || user.app_metadata?.role || user.user_metadata?.role || 'Viewer',
        email: user.email,
        email_confirmed_at: isEmailConfirmed ? new Date().toISOString() : null,
      };

      if (user.app_metadata?.provider === 'email' && !request.user.email_confirmed_at) {
         throw new UnauthorizedException('Please verify your email address before logging in.');
      }

      return true;
    } catch (err) {
      console.error('[AuthGuard] Token verification failed:', err?.message || err);
      throw new UnauthorizedException(`Session expired or invalid token: ${err?.message}`);
    }
  }
}
