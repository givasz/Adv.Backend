import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { BookingsController } from './bookings.controller'
import { BookingsService } from './bookings.service'

@Module({
  controllers: [BookingsController],
  providers: [BookingsService, PrismaService],
})
export class BookingsModule {}
