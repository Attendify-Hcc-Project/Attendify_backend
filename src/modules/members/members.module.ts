import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { EmailService } from './email.service';
import { RecognitionModule } from '../recognition/recognition.module';

@Module({
  imports: [RecognitionModule],
  controllers: [MembersController],
  providers: [MembersService, EmailService],
  exports: [MembersService, EmailService],
})
export class MembersModule {}
