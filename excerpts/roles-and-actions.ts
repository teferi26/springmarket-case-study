/**
 * Excerpt (simplified, comments translated) — roles, admin scopes and the single
 * wrapper every Server Action goes through.
 *
 * Helpers such as getSession, getDb, logger, ok/fail and adminTwoFactorRequirement
 * live elsewhere in the private codebase and are omitted here.
 */
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";

export type Role = "admin" | "employee" | "client";
export type AdminScope = "superadmin" | "sales" | "finance" | "ops" | "content";

export function homeForRole(role: Role) {
  return role === "admin" ? "/app/admin" : role === "employee" ? "/app/equipo" : "/app/cliente";
}

/** Used by every portal layout. Wrong role -> sent to their own home. Admins must have 2FA. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const s = await requireSession();
  if (!roles.includes(s.profile.role)) redirect(homeForRole(s.profile.role));
  const twoFactor = await adminTwoFactorRequirement(s);
  if (twoFactor === "enrollment_required") redirect("/app/cuenta/2fa");
  if (twoFactor === "verification_required") redirect("/acceder?error=2fa");
  return s;
}

/** An admin with no explicit scopes counts as superadmin. */
export function sessionHasScope(session: Pick<Session, "profile">, scope: AdminScope): boolean {
  if (session.profile.role !== "admin") return false;
  const scopes = session.profile.adminScopes?.length ? session.profile.adminScopes : ["superadmin"];
  return scopes.includes("superadmin") || scopes.includes(scope);
}

interface ActionOptions {
  roles?: Role[];
  public?: boolean;
  scope?: AdminScope;
  allowImpersonated?: boolean;
}

/**
 * Wraps a Server Action: zod validation, session + role + scope checks, read-only
 * impersonation, SLO timing and structured logging. Returns { ok, data } | { ok: false, error }.
 *
 * Usage: export const createTask = action(schema, async (input, session) => { ... }, { roles: ["client", "admin"] });
 */
export function action<I, O>(schema: z.ZodType<I, z.ZodTypeDef, unknown>, handler: (input: I, session: Session) => Promise<O>, opts: ActionOptions = {}) {
  return async (raw: unknown): Promise<ActionResult<O>> => {
    const started = Date.now();
    let session: Session | null = null;
    try {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "_"] = issue.message;
        return fail("Check the highlighted fields.", fieldErrors);
      }
      session = await getSession();
      if (!opts.public) {
        if (!session) return fail("Session required.");
        if (opts.roles && !opts.roles.includes(session.profile.role)) return fail("Insufficient permissions.");
        if (await adminTwoFactorRequirement(session)) return fail("Complete two-factor authentication first.");
        if (opts.scope && session.profile.role === "admin" && !sessionHasScope(session, opts.scope)) return fail("Missing admin scope.");
        // Impersonation is read-only unless the admin explicitly started it with write access (audited).
        if (session.impersonatedBy && !opts.allowImpersonated && !(await impersonationAllowsWrite(session))) {
          return fail("Read-only impersonation.");
        }
      }
      const data = await handler(parsed.data, session ?? PUBLIC_SESSION);
      const durationMs = Date.now() - started;
      if (durationMs > SLO.serverActionMs) logger.warn("slow server action", { durationMs });
      return ok(data);
    } catch (e) {
      if (e instanceof ZodError) return fail("Invalid data.");
      logger.error("server action error", { error: e, actorProfileId: session?.profile.id ?? null });
      return fail("Something went wrong. Please try again.");
    }
  };
}
