import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Authentication is OUT OF SCOPE for this challenge (see ARCHITECTURE.md §Auth).
 *
 * Extension point: replace `ProviderIdentityPort` with an OIDC-backed implementation
 * (e.g. Keycloak client-credentials tokens whose `azp`/custom claim carries the
 * providerId). The guard is already applied to every non-public route, so enabling
 * auth is a provider swap, not a refactor.
 */
export interface ProviderIdentityPort {
  /** Resolves who is calling; null = anonymous. */
  identify(request: { headers: Record<string, string | string[] | undefined> }): Promise<{ providerId: string } | null>;
  /** Whether that caller may act on behalf of `providerId`. */
  mayActAs(identity: { providerId: string } | null, providerId: string): boolean;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Default: no authentication. Documented as a known limitation; never use in production. */
export class NoAuthProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<{ providerId: string } | null> {
    return null;
  }
  mayActAs(): boolean {
    return true;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    // With NoAuthProviderIdentity this always passes; an OIDC implementation would
    // return false for missing/invalid tokens (-> 403).
    const caller = await this.identity.identify(request);
    const body = (request as { body?: { providerId?: unknown } }).body;
    if (body && typeof body.providerId === 'string') return this.identity.mayActAs(caller, body.providerId);
    return true;
  }
}
