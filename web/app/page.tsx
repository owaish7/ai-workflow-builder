'use client';

import { useAuthenticationStatus } from '@nhost/react';
import AuthForm from '../components/AuthForm';
import Home from '../components/Home';

export default function Page() {
  const { isLoading, isAuthenticated } = useAuthenticationStatus();
  if (isLoading) return <div className="container">Loading…</div>;
  return (
    <div className="container">
      {isAuthenticated ? <Home /> : <AuthForm />}
    </div>
  );
}
