import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GameClient } from './gameClient';
import type { Account } from './types';

interface Ctx {
  client: GameClient;
  account: Account | null;
  refreshAccount: () => Promise<void>;
}

const AppContext = createContext<Ctx | null>(null);

export function ClientProvider({ client, children }: { client: GameClient; children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const refreshAccount = useCallback(async () => setAccount(await client.getAccount()), [client]);
  useEffect(() => { void refreshAccount(); }, [refreshAccount]);
  const value = useMemo(() => ({ client, account, refreshAccount }), [client, account, refreshAccount]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp must be used inside <ClientProvider>');
  return v;
}
