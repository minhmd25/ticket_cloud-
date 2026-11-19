import 'dotenv/config';
import { migrate } from '../src/scripts/migrate';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://ticketing:ticketing@localhost:5432/ticketing_test';
  await migrate(url, false);
}
