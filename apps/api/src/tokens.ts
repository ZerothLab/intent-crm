import type { Actor } from '@intent/contracts';
export const SERVICE = Symbol('IntentService');
export const COMMERCIAL = Symbol('CommercialService');
export const PRODUCT = Symbol('ProductService');
export const IDENTITY = Symbol('IdentityService');
export interface Request {
  rawBody?: Buffer;
  headers: Record<string,string|string[]|undefined>;
  socket: {remoteAddress?:string};
  ip?: string;
  method?: string;
  actor?: Actor;
}
