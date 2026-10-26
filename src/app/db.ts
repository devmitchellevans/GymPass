import Dexie, { Table } from 'dexie';
import { CheckIn, LocalMember } from './models';

export interface MetaRow {
  key: string;
  value: string | number;
}

/**
 * Local-first storage. Every read in the UI comes from here, so the app behaves identically
 * with or without a network. The server (SQLite) is the shared copy that devices sync to.
 */
export class GymDb extends Dexie {
  members!: Table<LocalMember, string>;
  checkIns!: Table<CheckIn, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'gympass') {
    super(name);
    this.version(1).stores({
      members: 'id, sync, name',
      checkIns: 'clientId, memberId, checkedInAt, sync',
      meta: 'key',
    });
  }

  async getMeta<T extends string | number>(key: string, fallback: T): Promise<T> {
    const row = await this.meta.get(key);
    return ((row?.value as T | undefined) ?? fallback) as T;
  }

  setMeta(key: string, value: string | number) {
    return this.meta.put({ key, value });
  }
}

export const GYM_DB = new GymDb();
