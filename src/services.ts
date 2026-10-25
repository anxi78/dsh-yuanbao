/**
 * Safe access to cordis services.
 *
 * Cordis throws `cannot get property "X" without inject` when a plugin reads a
 * service it did not declare. That is a *read-time* throw, so a guard placed
 * before the property access cannot catch it -- the access itself must sit
 * inside the try, or (better) go through `ctx.reflect.get`, which is explicitly
 * documented as "read a service from the store without the inject requirement".
 *
 * Every service lookup in this plugin goes through here so the failure mode is
 * always "undefined + a warning" rather than a thrown error that aborts the
 * surrounding work (an inbound message, a tool registration, a session resume).
 */

export type ServiceReader = {
  /** Returns the service, or undefined when absent/unreadable. */
  get(name: string): unknown;
  /** Same, with a warning logged when the service is unavailable. */
  require(name: string): unknown;
};

type Warn = (message: string) => void;

/**
 * Build a reader bound to one context.
 *
 * @param ctx - the cordis context (or any object exposing `reflect`).
 * @param warn - called when a lookup fails; omit to stay silent.
 */
export function createServiceReader(ctx: unknown, warn?: Warn): ServiceReader {
  const read = (name: string): unknown => {
    const holder = ctx as { reflect?: { get?(name: string): unknown } } | undefined;
    const reflect = holder?.reflect;
    if (reflect && typeof reflect.get === 'function') {
      return reflect.get(name);
    }
    // Fallback for hosts without a reflect service. The property read is inside
    // the caller's try below, so an inject refusal is caught, not propagated.
    return (ctx as Record<string, unknown> | undefined)?.[name];
  };

  return {
    get(name: string): unknown {
      try {
        return read(name);
      } catch {
        return undefined;
      }
    },
    require(name: string): unknown {
      try {
        return read(name);
      } catch (error) {
        warn?.(`service unavailable: ${name}; ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
  };
}
