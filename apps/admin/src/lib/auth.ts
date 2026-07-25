import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/* 全应用共享同一个 authClient 实例(session store 唯一) */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});
