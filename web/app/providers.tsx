'use client';

import { useState, ReactNode } from 'react';
import { NhostProvider } from '@nhost/react';
import { Provider as UrqlProvider } from 'urql';
import { nhost } from '../lib/nhost';
import { makeClient } from '../lib/urql';

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => makeClient());
  return (
    <NhostProvider nhost={nhost}>
      <UrqlProvider value={client}>{children}</UrqlProvider>
    </NhostProvider>
  );
}
