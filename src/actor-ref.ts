/**
 * Normalization helpers for {@link ActorInput} — the "role, and which person"
 * pair that every actor-attributed store write accepts.
 *
 * Two shapes exist on purpose:
 *   - a bare {@link Actor} string — every pre-existing call site, and every
 *     single-user path (CLI, supervisor, reconciler, MCP)
 *   - an {@link ActorRef} `{ role, email, name }` — an RPC whose caller the
 *     daemon could attribute to a PERSON, named as git names people
 *
 * This module is the ONE place that collapses the two. Storage backends call
 * {@link actorRole} for the role column and {@link actorEmail} /
 * {@link actorName} for the person columns; nothing else should destructure an
 * `ActorInput` by hand.
 *
 * INVARIANT: the person is daemon-imposed. It is derived from the caller's
 * actor token in `applyCallerActor` (src/daemon/rpc-handlers.ts) and never read
 * from a client-supplied request field — see
 * docs/design/actor-identity-and-remote-clients.md §3.
 */

import type { Actor, ActorInput, ActorRef } from './types';

/** True for the object form of an {@link ActorInput}. */
export function isActorRef(actor: ActorInput | undefined): actor is ActorRef {
  return typeof actor === 'object' && actor !== null;
}

/** The role (channel) an actor input names, or undefined when unset. */
export function actorRole(actor: ActorInput | undefined): Actor | undefined {
  if (actor === undefined) return undefined;
  return isActorRef(actor) ? actor.role : actor;
}

/**
 * The email of the person behind an actor input, or undefined when there is
 * none — a bare role string, or a ref the daemon could not attribute.
 */
export function actorEmail(actor: ActorInput | undefined): string | undefined {
  if (!isActorRef(actor)) return undefined;
  const email = actor.email;
  // Treat '' as absent: a blank attributes a row to nobody while looking set.
  return email ? email : undefined;
}

/**
 * Does this value name a PERSON the way git does — an address with a domain?
 *
 * ONE spelling of the question, because two places ask it and they must agree:
 * the migration off `actor_user_id` (src/storage/actor-identity-migration.ts),
 * which clears anything that is not an email rather than carry a meaningless
 * `user-12` into a field that promises one, and the per-user credential
 * registry (src/daemon/user-credentials.ts), keyed by email for the same
 * reason. If these diverged, an identity the store accepts could be one the
 * credential registry refuses, and a person would exist for attribution and not
 * for billing.
 *
 * Deliberately a SHAPE check and not RFC 5322: nothing here can tell whether an
 * address is deliverable, and the only thing the caller needs to know is
 * whether this string could be a person rather than a control plane's id.
 */
const PERSON_EMAIL_RE = /^[^\s@,<>"']+@[^\s@,<>"'.]+(\.[^\s@,<>"'.]+)+$/;

export function isPersonEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // 254 is the longest address an SMTP path can carry; past it nothing is real.
  return trimmed.length > 0 && trimmed.length <= 254 && PERSON_EMAIL_RE.test(trimmed);
}

/**
 * The ONE spelling of a person's address — trimmed and case-folded.
 *
 * WHY THIS EXISTS: an address is a KEY here, not just a rendered string. A user
 * token is keyed by it (src/daemon/actor-tokens.ts), the per-user credential
 * registry is keyed by it (src/daemon/user-credentials.ts), and every attributed
 * row carries it. `isPersonEmail` trims before testing, so `' Ada@Example.com '`
 * VALIDATES — and storing what was validated rather than a canonical form let
 * one person exist under several keys at once:
 *
 *   - a mint of `' ada@example.com'` and a revoke of `'ada@example.com'` answered
 *     "revoked 0", which reads exactly like "already gone" while the token kept
 *     authenticating;
 *   - `putUserCredential` already trims its key, so the credential was filed
 *     under one spelling and the token held another, and the member was refused
 *     with the no-credential marker — the least suspicious symptom available;
 *   - attribution split into two `actor_email` values for one person, with
 *     nothing downstream reconciling them.
 *
 * Case-folding the WHOLE address (not just the domain, which is all the RFC
 * strictly allows) is deliberate: every identity this repo keys on is compared
 * with `===`, and no mail server anybody uses treats the local part as
 * case-sensitive. The cost of folding is a theoretical address nobody has; the
 * cost of not folding is the three failures above.
 *
 * Call this at every DOOR — where an address enters the daemon — never at the
 * comparison site, so the stored form is canonical and a reader can trust it.
 */
export function canonicalPersonEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The display name of the person behind an actor input, when the write carried
 * one. Nullable independently of the email: a token may know an address and no
 * name, and a name alone names nobody reachable.
 */
export function actorName(actor: ActorInput | undefined): string | undefined {
  if (!isActorRef(actor)) return undefined;
  const name = actor.name;
  return name ? name : undefined;
}

/**
 * The `{ actor?, actor_email?, actor_name? }` slice to spread into a stored row.
 *
 * INVARIANT (cross-backend row shape): an unset optional key is ABSENT, never
 * present-and-undefined — FileStorage row shapes are compared key-for-key
 * against Postgres ones (test/e2e/storage-contract.test.ts).
 */
export function actorFields(actor: ActorInput | undefined): {
  actor?: Actor;
  actor_email?: string;
  actor_name?: string;
} {
  const role = actorRole(actor);
  const email = actorEmail(actor);
  const name = actorName(actor);
  return {
    ...(role ? { actor: role } : {}),
    ...(email ? { actor_email: email } : {}),
    ...(name ? { actor_name: name } : {}),
  };
}

/**
 * Re-attach a person to a role the caller resolved separately.
 *
 * Call sites that default a missing actor (`params.actor ?? getActor()`) end up
 * holding a plain role; this puts the original ref's person back on it so the
 * attribution is not lost by the defaulting.
 */
export function withActorPerson(role: Actor, source: ActorInput | undefined): ActorInput {
  const email = actorEmail(source);
  const name = actorName(source);
  if (!email && !name) return role;
  return { role, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

/**
 * "Who did this", in words, from a stored `{ actor, actor_email, actor_name }`
 * triple.
 *
 * ONE spelling for every surface — CLI text, web HTML (escaped by the caller),
 * a report line. A person is rendered as git spells them, `name <email>`,
 * falling back to the email alone; with no person it is the role, which is what
 * a row written before any of this carried and reads exactly as it always did.
 *
 * Empty string when neither is known, so a caller can drop the phrase entirely
 * rather than print "by undefined".
 */
export function attributionLabel(
  role: Actor | string | null | undefined,
  email?: string | null,
  name?: string | null,
): string {
  const person = email?.trim() || '';
  const display = name?.trim() || '';
  if (person) return display ? `${display} <${person}>` : person;
  if (role) return role;
  return '';
}

/**
 * A person (from {@link actorEmail} / {@link actorName}) as `<prefix>_email` / `<prefix>_name`
 * columns — for row types that name several actors (a memory record's
 * `created_by` / `updated_by` / `deleted_by`) and so cannot use the single
 * `actor_email` pair {@link actorFields} writes.
 *
 * Same row-shape invariant as {@link actorFields}: an unset key is ABSENT.
 */
export function personFieldsAs<P extends string>(
  prefix: P,
  email: string | undefined,
  name: string | undefined,
): Partial<Record<`${P}_email` | `${P}_name`, string>> {
  return {
    ...(email ? { [`${prefix}_email`]: email } : {}),
    ...(name ? { [`${prefix}_name`]: name } : {}),
  } as Partial<Record<`${P}_email` | `${P}_name`, string>>;
}
