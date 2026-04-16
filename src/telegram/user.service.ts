import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SheetsService, UserRecord } from '../sheets/sheets.service';

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);
  private readonly adminId: number;
  private readonly cache = new Map<number, UserRecord>();

  constructor(
    private readonly sheetsService: SheetsService,
    private readonly configService: ConfigService,
  ) {
    this.adminId = parseInt(
      this.configService.get<string>('ALLOWED_TELEGRAM_USER_ID', '0'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.refreshCache();
  }

  async refreshCache(): Promise<void> {
    try {
      const users = await this.sheetsService.getUsers();
      this.cache.clear();
      for (const u of users) this.cache.set(u.telegramId, u);
      this.logger.log(`User cache refreshed: ${users.length} user(s)`);
    } catch (error) {
      this.logger.error('Error refreshing user cache', error);
    }
  }

  isAdmin(telegramId: number): boolean {
    return telegramId === this.adminId;
  }

  isAllowed(telegramId: number): boolean {
    if (this.isAdmin(telegramId)) return true;
    const user = this.cache.get(telegramId);
    return user?.active ?? false;
  }

  getAdminId(): number {
    return this.adminId;
  }

  listUsers(): UserRecord[] {
    return Array.from(this.cache.values());
  }

  async addUser(telegramId: number, name: string): Promise<void> {
    await this.sheetsService.addUser(telegramId, name);
    await this.refreshCache();
  }

  async setUserActive(telegramId: number, active: boolean): Promise<void> {
    const user = this.cache.get(telegramId);
    if (!user) throw new Error(`Usuario ${telegramId} no encontrado en caché`);
    await this.sheetsService.setUserActive(user.rowIndex, active);
    await this.refreshCache();
  }
}
