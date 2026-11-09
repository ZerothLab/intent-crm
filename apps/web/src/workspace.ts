import { createContext, useContext } from 'react';
import type { Bootstrap } from '@intent/contracts';

export const WorkspaceContext = createContext<Bootstrap | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('Workspace is not loaded');
  return context;
}
