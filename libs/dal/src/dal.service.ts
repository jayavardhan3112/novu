import { Connection, ConnectOptions } from 'mongoose';
import * as mongoose from 'mongoose';

export class DalService {
  connection: Connection;

  async connect(url: string, config: ConnectOptions = {}) {
    const baseConfig: ConnectOptions = {
      maxPoolSize: 700,
      minPoolSize: process.env.NODE_ENV === 'prod' ? 200 : 10,
      autoIndex: process.env.AUTO_CREATE_INDEXES === 'true',
    };

    const instance = await mongoose.connect(url, {
      ...baseConfig,
      ...config,
    });

    this.connection = instance.connection;

    return this.connection;
  }

  isConnected(): boolean {
    return this.connection && this.connection.readyState === 1;
  }

  async disconnect() {
    await mongoose.disconnect();
  }

  async destroy() {
    if (process.env.NODE_ENV !== 'test') throw new Error('Allowed only in test mode');

    await mongoose.connection.dropDatabase();
  }
}
