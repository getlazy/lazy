/**
 * A daemon restart must validate retained member environments before their
 * credentials can spend. Blocking is process-local: it preserves the durable
 * binding without revoking or reviving it. Both proxy credential paths consult
 * this gate; only validated launches/recoveries release individual bindings.
 */
export const MEMBER_EXEC_BINDING_PREFIX = 'member-exec:';

interface Recovery {
  inventoryPending: boolean;
  allowedBindings: Set<string>;
}
const recoveries = new Map<string, Recovery>();

export function beginMemberRecovery(root: string): void {
  recoveries.set(root, { inventoryPending: true, allowedBindings: new Set() });
}

export function memberInventoryPending(root: string): boolean {
  return recoveries.get(root)?.inventoryPending ?? false;
}

export function memberInventoryRead(root: string): void {
  const recovery = recoveries.get(root);
  if (recovery) recovery.inventoryPending = false;
}

export function memberBindingMaySpend(root: string, key: string): boolean {
  const recovery = recoveries.get(root);
  return !recovery || !key.startsWith(MEMBER_EXEC_BINDING_PREFIX) || recovery.allowedBindings.has(key);
}

export function allowMemberBinding(root: string, key: string): void {
  recoveries.get(root)?.allowedBindings.add(key);
}

export function blockMemberBinding(root: string, key: string): void {
  recoveries.get(root)?.allowedBindings.delete(key);
}

/** Test seam. Does not clear persisted credentials. */
export function resetMemberRecoveryForTests(): void {
  recoveries.clear();
}
