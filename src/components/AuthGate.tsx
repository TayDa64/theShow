import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading } = useAuth();

  if (!isLoading) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex items-center justify-center px-6">
      <div className="w-full max-w-md border border-zinc-900 bg-zinc-950 rounded-3xl p-6 shadow-2xl space-y-4 text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl border border-indigo-500/30 bg-indigo-500/10 flex items-center justify-center">
          <ShieldCheck className="w-6 h-6 text-indigo-400" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-white">Restoring secure workspace session…</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            StoryForge is checking your account session, provider status, and sync permissions before loading the workspace.
          </p>
        </div>
      </div>
    </div>
  );
}