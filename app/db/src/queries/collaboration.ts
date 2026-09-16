import type { QueryRunner } from '../runner.js'

/**
 * Build plan step 18 — notes, assignment and the people to assign to.
 */

export type Note = {
  id: string
  body: string
  authorMembershipId: string | null
  createdAt: Date
}

/**
 * Notes live in their own table and the dispatcher only reads `messages`, so
 * an internal note cannot reach a customer even if a future query forgets to
 * filter. Section 18.12 requires exactly that separation.
 */
export async function addNote(
  run: QueryRunner,
  input: { operatorId: string; conversationId: string; membershipId: string; body: string },
): Promise<{ noteId: string | null }> {
  const rows = await run(
    `insert into conversation_notes (operator_id, conversation_id, author_membership_id, body)
     select v.operator_id, v.id, $3, $4
     from conversations v
     where v.id = $2 and v.operator_id = $1
     returning id`,
    [input.operatorId, input.conversationId, input.membershipId, input.body],
  )
  return { noteId: (rows[0]?.['id'] as string) ?? null }
}

export async function listNotes(
  run: QueryRunner,
  operatorId: string,
  conversationId: string,
): Promise<Note[]> {
  const rows = await run(
    `select id, body, author_membership_id, created_at
     from conversation_notes
     where conversation_id = $2 and operator_id = $1
     order by created_at`,
    [operatorId, conversationId],
  )
  return rows.map((r) => ({
    id: r['id'] as string,
    body: r['body'] as string,
    authorMembershipId: (r['author_membership_id'] as string) ?? null,
    createdAt: new Date(r['created_at'] as string),
  }))
}

export type Member = {
  membershipId: string
  userId: string
  role: string
  email: string | null
}

/**
 * The people a conversation can be assigned to.
 *
 * The email comes from a security-definer function rather than from auth.users
 * directly. The restricted role a request runs as has no access to the auth
 * schema and must not be given any: "permission denied for schema auth" is the
 * database being right, and it took the conversation page down when row-level
 * security was wired, because the reassign dropdown is the only place in the
 * application that asks who anybody is.
 *
 * Still a left join and still optional, for the original reason: the test
 * database has no auth schema, so a missing email is a null rather than a
 * missing row. That is also why nothing in the suite could have caught it.
 */
export async function listMembers(run: QueryRunner, operatorId: string): Promise<Member[]> {
  const rows = await run(
    `select m.id as membership_id, m.user_id, m.role::text as role, e.email
     from memberships m
     left join public.vyra_member_emails() e on e.user_id = m.user_id
     where m.operator_id = $1 and m.active
     order by role, membership_id`,
    [operatorId],
  )
  return rows.map((r) => ({
    membershipId: r['membership_id'] as string,
    userId: r['user_id'] as string,
    role: r['role'] as string,
    email: (r['email'] as string) ?? null,
  }))
}

/**
 * Reassignment.
 *
 * Assigning an owner does NOT take the conversation away from the AI — those
 * are separate fields for separate reasons, and section 7 of the MVP is
 * explicit that collapsing them loses real combinations. A lead can be
 * assigned to a salesperson for follow-up while the AI still handles the next
 * reply, and a manager reassigning a queue should not silently start or stop
 * automation as a side effect.
 */
export async function assignConversation(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    assigneeMembershipId: string | null
    actorMembershipId: string
  },
): Promise<{ assigned: boolean }> {
  const rows = await run(
    `with updated as (
       update conversations v
       set owner_membership_id = $3, updated_at = now()
       where v.id = $2 and v.operator_id = $1
         -- An assignee must belong to this operator. A crafted id cannot
         -- hand another operator's staff member one of our conversations.
         and ($3::uuid is null or exists (
           select 1 from memberships m
           where m.id = $3 and m.operator_id = $1 and m.active
         ))
       returning v.id, v.operator_id
     ),
     audited as (
       insert into audit_events (
         operator_id, actor_type, actor_id, action, subject_type, subject_id, data
       )
       select u.operator_id, 'user', $4,
              case when $3::uuid is null then 'conversation.unassigned' else 'conversation.assigned' end,
              'conversation', u.id,
              jsonb_build_object('assignee_membership_id', $3::uuid)
       from updated u
       returning id
     )
     select (select id from updated) as conversation_id`,
    [input.operatorId, input.conversationId, input.assigneeMembershipId, input.actorMembershipId],
  )
  return { assigned: rows[0]?.['conversation_id'] != null }
}

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export async function setPriority(
  run: QueryRunner,
  input: {
    operatorId: string
    conversationId: string
    priority: string
    actorMembershipId: string
  },
): Promise<{ changed: boolean }> {
  if (!PRIORITIES.includes(input.priority as (typeof PRIORITIES)[number])) {
    return { changed: false }
  }
  const rows = await run(
    `with updated as (
       update conversations set priority = $3::priority, updated_at = now()
       where id = $2 and operator_id = $1
       returning id, operator_id, priority
     ),
     audited as (
       insert into audit_events (operator_id, actor_type, actor_id, action, subject_type, subject_id, data)
       select u.operator_id, 'user', $4, 'conversation.priority_changed', 'conversation', u.id,
              jsonb_build_object('priority', u.priority)
       from updated u returning id
     )
     select (select id from updated) as conversation_id`,
    [input.operatorId, input.conversationId, input.priority, input.actorMembershipId],
  )
  return { changed: rows[0]?.['conversation_id'] != null }
}
