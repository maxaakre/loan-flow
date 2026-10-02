import { TEST_COMPANIES } from '@loanflow/core';
import { httpHandler } from '../http';

// Only name and org number: credit data stays on the server
export const handler = httpHandler(async () => ({
  status: 200,
  body: TEST_COMPANIES.map(({ orgNr, name }) => ({ orgNr, name })),
}));
